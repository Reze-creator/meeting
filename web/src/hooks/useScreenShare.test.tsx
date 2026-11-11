import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useScreenShare } from './useScreenShare'

it('浏览器停止共享时释放屏幕轨道并同步状态', async () => {
  const track = { stop: vi.fn(), onended: null as (() => void) | null }
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] }
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
  })
  const { result } = renderHook(useScreenShare)
  await act(async () => result.current.start())
  expect(result.current.stream).toBe(stream)
  act(() => track.onended?.())
  expect(track.stop).toHaveBeenCalledOnce()
  expect(result.current.stream).toBeUndefined()
})
it('共享选择器延迟返回时不在已退出的页面上重启共享', async () => {
  const track = { stop: vi.fn() }
  let resolve!: (value: unknown) => void
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      ),
    },
  })
  const { result, unmount } = renderHook(useScreenShare)
  let pending!: Promise<void>
  act(() => {
    pending = result.current.start()
  })
  unmount()
  await act(async () => {
    resolve({ getTracks: () => [track] })
    await pending
  })
  expect(track.stop).toHaveBeenCalledOnce()
})
