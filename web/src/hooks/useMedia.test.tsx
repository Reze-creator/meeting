import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useMedia } from './useMedia'

function track(kind: string) {
  return { kind, enabled: true, stop: vi.fn(), onended: null }
}
class FakeStream {
  tracks: ReturnType<typeof track>[]
  constructor(tracks: ReturnType<typeof track>[] = []) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
}
function mockDevices(getUserMedia: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('MediaStream', FakeStream)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  })
}

describe('本地媒体资源生命周期', () => {
  it('设备热插拔恢复到默认输入时保持原有静音状态', async () => {
    const first = track('audio')
    const replacement = track('audio')
    mockDevices(
      vi
        .fn()
        .mockResolvedValueOnce(new FakeStream([first]))
        .mockResolvedValueOnce(new FakeStream([replacement])),
    )
    const { result } = renderHook(useMedia)
    await act(async () => result.current.toggle('audio'))
    act(() => result.current.mute())
    await act(async () => {
      const ended = first.onended as unknown as () => void
      ended()
    })
    await waitFor(() => expect(replacement.enabled).toBe(false))
    expect(result.current.mic).toBe(false)
  })
  it('切换麦克风释放旧设备，离会释放全部轨道', async () => {
    const first = track('audio')
    const second = track('audio')
    const camera = track('video')
    mockDevices(
      vi
        .fn()
        .mockResolvedValueOnce(new FakeStream([first]))
        .mockResolvedValueOnce(new FakeStream([second]))
        .mockResolvedValueOnce(new FakeStream([camera])),
    )
    const { result, unmount } = renderHook(useMedia)
    expect(result.current.mic).toBe(false)
    await act(async () => {
      await result.current.toggle('audio')
    })
    expect(result.current.mic).toBe(true)
    await act(async () => {
      await result.current.selectMicrophone('second-device')
    })
    expect(first.stop).toHaveBeenCalledOnce()
    await act(async () => {
      await result.current.toggle('video')
    })
    act(() => result.current.stop())
    expect(second.stop).toHaveBeenCalledOnce()
    expect(camera.stop).toHaveBeenCalledOnce()
    expect(result.current.stream).toBeUndefined()
    expect(result.current.camera).toBe(false)
    unmount()
  })
  it('拒绝设备权限后保留静音入会能力', async () => {
    mockDevices(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
    const { result } = renderHook(useMedia)
    await act(async () => {
      await result.current.toggle('audio')
    })
    expect(result.current.mic).toBe(false)
    expect(result.current.error).toContain('权限未获允许')
  })
  it('卸载后才完成的权限请求必须立即停止轨道', async () => {
    const delayedTrack = track('audio')
    let resolve!: (stream: FakeStream) => void
    mockDevices(
      vi.fn(
        () =>
          new Promise<FakeStream>((done) => {
            resolve = done
          }),
      ),
    )
    const { result, unmount } = renderHook(useMedia)
    let request!: Promise<void>
    act(() => {
      request = result.current.toggle('audio')
    })
    unmount()
    await act(async () => {
      resolve(new FakeStream([delayedTrack]))
      await request
    })
    await waitFor(() => expect(delayedTrack.stop).toHaveBeenCalledOnce())
  })
})
