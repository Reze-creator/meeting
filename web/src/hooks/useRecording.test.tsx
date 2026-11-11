import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useRecording } from './useRecording'

class FakeRecorder {
  static isTypeSupported = () => true
  static empty = false
  state = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    if (!FakeRecorder.empty)
      this.ondataavailable?.({
        data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])]),
      })
    this.onstop?.()
  }
}
const outputTrack = { kind: 'video', stop: vi.fn(), requestFrame: vi.fn() }
const nodes: { stop: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  FakeRecorder.empty = false
  nodes.length = 0
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  class AudioContext {
    destination = {}
    resume = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [{ kind: 'audio', stop: vi.fn() }] } }
    }
    createOscillator() {
      const oscillator = { connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
      nodes.push(oscillator)
      return oscillator
    }
    createGain() {
      return { gain: { value: 1 }, connect: vi.fn() }
    }
  }
  vi.stubGlobal('AudioContext', AudioContext)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
    configurable: true,
    value: () => ({
      getVideoTracks: () => [outputTrack],
      getTracks: () => [outputTrack],
      addTrack: vi.fn(),
    }),
  })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:backup')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})
it('无麦克风时建立静音时钟，停止后上传 WebM 并释放合成轨道', async () => {
  const { result } = renderHook(() => useRecording('123456789', () => []))
  await act(async () => result.current.start())
  expect(result.current.active).toBe(true)
  let saved = false
  await act(async () => {
    saved = await result.current.stop()
  })
  expect(saved).toBe(true)
  expect(result.current.active).toBe(false)
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining('/123456789/recordings?duration='),
    expect.objectContaining({ method: 'POST', body: expect.any(Blob) }),
  )
  expect(nodes[0].stop).toHaveBeenCalledOnce()
  expect(outputTrack.stop).toHaveBeenCalled()
})
it('上传失败保留可下载备份，空录制不伪装成有效备份', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('断网')))
  const { result } = renderHook(() => useRecording('123456789', () => []))
  await act(async () => result.current.start())
  await act(async () => {
    expect(await result.current.stop()).toBe(false)
  })
  expect(result.current.backup).toBe('blob:backup')
  FakeRecorder.empty = true
  await act(async () => result.current.start())
  await act(async () => {
    expect(await result.current.stop()).toBe(false)
  })
  expect(result.current.backup).toBe('')
  expect(result.current.error).toContain('没有产生可录制帧')
})
