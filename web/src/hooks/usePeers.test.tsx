import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { usePeers } from './usePeers'
import type { Member } from '../types'

class FakeStream {
  tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track)
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((item) => item !== track)
  }
}
class FakePeer {
  static instances: FakePeer[] = []
  signalingState: string = 'stable'
  connectionState = 'new'
  localDescription = { toJSON: () => ({ type: 'answer', sdp: 'answer-sdp' }) }
  onicecandidate: unknown
  ontrack: unknown
  onconnectionstatechange: unknown
  onnegotiationneeded: unknown
  close = vi.fn(() => {
    this.signalingState = 'closed'
  })
  sender = { replaceTrack: vi.fn().mockResolvedValue(undefined) }
  addTrack = vi.fn(() => this.sender)
  setLocalDescription = vi.fn().mockResolvedValue(undefined)
  setRemoteDescription = vi.fn().mockResolvedValue(undefined)
  addIceCandidate = vi.fn().mockResolvedValue(undefined)
  constructor() {
    FakePeer.instances.push(this)
  }
}
const remote: Member = {
  id: 2,
  name: '远端用户',
  host: false,
  mic: true,
  camera: false,
  sessionId: 'session-a',
}

beforeEach(() => {
  FakePeer.instances = []
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('MediaStream', FakeStream)
})

it('同一成员重连时关闭旧媒体连接，只接受当前会话的信令', async () => {
  const { result } = renderHook(() => usePeers(undefined, 1, vi.fn()))
  act(() => result.current.syncMembers([remote]))
  const first = FakePeer.instances[0]
  act(() => result.current.syncMembers([{ ...remote, sessionId: 'session-b' }]))
  expect(first.close).toHaveBeenCalledOnce()
  await act(async () =>
    result.current.receive(2, 'session-a', { description: { type: 'offer', sdp: 'stale' } }),
  )
  expect(FakePeer.instances[1].setRemoteDescription).not.toHaveBeenCalled()
})

it('ICE 等待远端 SDP 完成，避免异步回调导致候选先于描述执行', async () => {
  const send = vi.fn()
  const { result } = renderHook(() => usePeers(undefined, 1, send))
  act(() => result.current.syncMembers([remote]))
  const pc = FakePeer.instances[0]
  let finish!: () => void
  pc.setRemoteDescription.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => {
    result.current.receive(2, remote.sessionId, { description: { type: 'offer', sdp: 'offer' } })
    result.current.receive(2, remote.sessionId, { candidate: { candidate: 'candidate' } })
  })
  expect(pc.addIceCandidate).not.toHaveBeenCalled()
  await act(async () => {
    finish()
  })
  expect(pc.addIceCandidate).toHaveBeenCalledOnce()
  expect(send).toHaveBeenCalledWith(2, expect.objectContaining({ description: expect.anything() }))
})

it('设备断开后重新获得同类轨道时复用 sender，避免不断新增媒体轨道', () => {
  const audio = { kind: 'audio' } as MediaStreamTrack
  const stream = new FakeStream([audio]) as unknown as MediaStream
  const { result, rerender } = renderHook(
    ({ stream }: { stream: MediaStream | undefined }) => usePeers(stream, 1, vi.fn()),
    { initialProps: { stream: stream as MediaStream | undefined } },
  )
  act(() => result.current.syncMembers([remote]))
  const pc = FakePeer.instances[0]
  rerender({ stream: undefined })
  expect(pc.sender.replaceTrack).toHaveBeenCalledWith(null)
  rerender({ stream })
  expect(pc.sender.replaceTrack).toHaveBeenCalledWith(audio)
  expect(pc.addTrack).toHaveBeenCalledOnce()
})
