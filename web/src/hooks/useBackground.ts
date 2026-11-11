import { useEffect, useMemo, useState } from 'react'
import { errorText } from '../api'
import { createBackgroundProcessor } from '../media/background'
import type { BackgroundMode } from '../media/background'

/** 原始摄像头归 useMedia 管理，本 hook 只拥有合成后的轨道；清理时不关闭原始设备。 */
export function useBackground(stream: MediaStream | undefined, camera: boolean) {
  const [mode, setMode] = useState<BackgroundMode>('off')
  const [processed, setProcessed] = useState<{
    source: MediaStreamTrack
    mode: BackgroundMode
    track: MediaStreamTrack
  }>()
  const [error, setError] = useState('')
  const raw = stream?.getTracks().find((track) => track.kind === 'video')
  useEffect(() => {
    if (mode === 'off' || !raw) return
    let disposed = false
    queueMicrotask(() => {
      if (!disposed) {
        setProcessed(undefined)
        setError('')
      }
    })
    const controller = new AbortController()
    let cleanup: (() => void) | undefined
    void createBackgroundProcessor(
      raw,
      mode,
      (message) => {
        if (!disposed) setError(message)
      },
      controller.signal,
    )
      .then((processor) => {
        if (disposed) {
          processor.close()
          return
        }
        cleanup = processor.close
        setProcessed({ source: raw, mode, track: processor.track })
        setError('')
      })
      .catch((error) => {
        if (!disposed) setError(`虚拟背景加载失败：${errorText(error)}。请关闭效果或重试。`)
      })
    return () => {
      disposed = true
      controller.abort()
      cleanup?.()
    }
  }, [raw, mode])
  const track =
    processed && processed.source === raw && processed.mode === mode ? processed.track : undefined
  useEffect(() => {
    // MediaStreamTrack 是浏览器可变资源；这里只同步设备开关，不修改 React 展示数据。
    // oxlint-disable-next-line react/immutability
    if (track) track.enabled = camera
  }, [track, camera])
  // 开启效果到模型就绪之间不发送原始摄像头，避免短暂泄露真实背景。
  const published = useMemo(() => {
    if (mode === 'off') return stream
    const audio = stream?.getTracks().filter((item) => item.kind === 'audio') ?? []
    return stream ? new MediaStream([...audio, ...(track ? [track] : [])]) : undefined
  }, [stream, track, mode])
  return {
    stream: published,
    mode,
    setMode,
    error,
    loading: mode !== 'off' && !!raw && !track && !error,
  }
}
