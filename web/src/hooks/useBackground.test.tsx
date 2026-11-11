import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useBackground } from './useBackground'

const processor = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('../media/background', () => ({ createBackgroundProcessor: processor.create }))
class Stream {
  private tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
}
beforeEach(() => {
  processor.create.mockReset()
  vi.stubGlobal('MediaStream', Stream)
})
function rawStream() {
  const raw = { kind: 'video', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack
  const audio = { kind: 'audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack
  return { raw, audio, stream: new Stream([raw, audio]) as unknown as MediaStream }
}
it('模型加载期间不发送原始摄像头，完成后替换为合成轨道并保留音频', async () => {
  const { stream, raw, audio } = rawStream()
  const output = { kind: 'video', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack
  let resolve!: (value: unknown) => void
  processor.create.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const close = vi.fn()
  const { result, rerender, unmount } = renderHook(({ camera }) => useBackground(stream, camera), {
    initialProps: { camera: true },
  })
  expect(result.current.stream).toBe(stream)
  act(() => result.current.setMode('studio'))
  expect(result.current.stream!.getTracks()).toEqual([audio])
  await act(async () => resolve({ track: output, close }))
  await waitFor(() => expect(result.current.stream!.getTracks()).toEqual([audio, output]))
  rerender({ camera: false })
  expect(output.enabled).toBe(false)
  unmount()
  expect(close).toHaveBeenCalled()
  expect(raw.stop).not.toHaveBeenCalled()
})
it('退出后才完成的分割器必须释放，不能恢复发布', async () => {
  const { stream } = rawStream()
  let resolve!: (value: unknown) => void
  processor.create.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const { result, unmount } = renderHook(() => useBackground(stream, true))
  act(() => result.current.setMode('blur'))
  const signal = processor.create.mock.calls[0][3] as AbortSignal
  unmount()
  expect(signal.aborted).toBe(true)
  const close = vi.fn()
  await act(async () => resolve({ track: {}, close }))
  expect(close).toHaveBeenCalledOnce()
})
it('模型失败时保持真实背景隐藏，用户关闭效果才恢复原轨道', async () => {
  const { stream, audio } = rawStream()
  processor.create.mockRejectedValue(new Error('模型不可用'))
  const { result } = renderHook(() => useBackground(stream, true))
  act(() => result.current.setMode('blur'))
  await waitFor(() => expect(result.current.error).toContain('加载失败'))
  expect(result.current.stream!.getTracks()).toEqual([audio])
  act(() => result.current.setMode('off'))
  expect(result.current.stream).toBe(stream)
})
