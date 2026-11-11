import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { mergeCaptions, useCaptions } from './useCaptions'
import type { Caption } from '../types'

class Context {
  static instances: Context[] = []
  destination = {}
  resume = vi.fn().mockResolvedValue(undefined)
  close = vi.fn().mockResolvedValue(undefined)
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
  source = { connect: vi.fn(), disconnect: vi.fn() }
  createMediaStreamSource = () => this.source
  createGain = () => ({ gain: { value: 1 }, connect: vi.fn() })
  constructor() {
    Context.instances.push(this)
  }
}
class Worklet {
  static instances: Worklet[] = []
  port = {
    onmessage: null as
      null | ((event: { data: { samples: Float32Array; sampleRate: number } }) => void),
    close: vi.fn(),
  }
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() {
    Worklet.instances.push(this)
  }
}
class Stream {
  tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[]) {
    this.tracks = tracks
  }
  getAudioTracks() {
    return this.tracks
  }
}
const audio = { kind: 'audio', enabled: true } as MediaStreamTrack
beforeEach(() => {
  Context.instances = []
  Worklet.instances = []
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('AudioWorkletNode', Worklet)
  vi.stubGlobal('MediaStream', Stream)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }))
})
it('本人静音后关闭音频节点和在途识别，迟到字幕不能显示', async () => {
  let finish!: (value: Response) => void
  const fetcher = vi.mocked(fetch)
  fetcher.mockImplementation(async (path) => {
    if (String(path).includes('transcribe'))
      return (await new Promise((resolve) => {
        finish = resolve
      })) as Response
    return { ok: true, json: async () => ({ data: [] }) } as Response
  })
  const stream = new Stream([audio]) as unknown as MediaStream
  const { result, rerender } = renderHook(
    ({ mic }) =>
      useCaptions({
        meetingId: '123456789',
        sessionId: 'session-a',
        online: true,
        stream,
        enabled: true,
        mic,
      }),
    { initialProps: { mic: true } },
  )
  await waitFor(() => expect(Worklet.instances).toHaveLength(1))
  const event = { data: { samples: new Float32Array(16000).fill(0.1), sampleRate: 16000 } }
  act(() => Worklet.instances[0].port.onmessage?.(event))
  const request = fetcher.mock.calls.find(([path]) => String(path).includes('transcribe'))!
  expect(String(request[0])).toContain('sessionId=session-a')
  rerender({ mic: false })
  expect((request[1]!.signal as AbortSignal).aborted).toBe(true)
  expect(Context.instances[0].close).toHaveBeenCalled()
  await act(async () =>
    finish({ ok: true, json: async () => ({ data: { id: 9, text: '迟到结果' } }) } as Response),
  )
  expect(result.current.items).toHaveLength(0)
})
it('默认关闭时不创建音频节点；近乎静音的片段不调用 STT', async () => {
  const stream = new Stream([audio]) as unknown as MediaStream
  const { rerender } = renderHook(
    ({ enabled }) =>
      useCaptions({
        meetingId: '123456789',
        sessionId: 'a',
        online: true,
        stream,
        mic: true,
        enabled,
      }),
    { initialProps: { enabled: false } },
  )
  expect(Context.instances).toHaveLength(0)
  rerender({ enabled: true })
  await waitFor(() => expect(Worklet.instances).toHaveLength(1))
  act(() =>
    Worklet.instances[0].port.onmessage?.({
      data: { samples: new Float32Array(16000), sampleRate: 16000 },
    }),
  )
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes('transcribe'))).toBe(
    false,
  )
})
it('历史补齐与推送按 ID 去重，并限制会中内存缓存', () => {
  const items = Array.from({ length: 600 }, (_, id) => ({ id, text: String(id) }) as Caption)
  const merged = mergeCaptions(items, [{ id: 599, text: '更新' } as Caption])
  expect(merged).toHaveLength(500)
  expect(merged[0].id).toBe(100)
  expect(merged[499].text).toBe('更新')
})
