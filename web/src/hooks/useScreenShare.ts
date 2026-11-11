import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../api'

/** 屏幕轨道单独管理，停止共享不影响摄像头；处理浏览器自带“停止共享”按钮。 */
export function useScreenShare() {
  const active = useRef<MediaStream | undefined>(undefined)
  const generation = useRef(0)
  const [stream, setStream] = useState<MediaStream>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const stop = useCallback(() => {
    generation.current++
    active.current?.getTracks().forEach((track) => track.stop())
    active.current = undefined
    setStream(undefined)
    setBusy(false)
  }, [])
  async function start() {
    const request = ++generation.current
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('当前浏览器不支持屏幕共享，请使用桌面版 Chrome 或 Edge。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const next = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      })
      if (request !== generation.current) {
        next.getTracks().forEach((track) => track.stop())
        return
      }
      active.current?.getTracks().forEach((track) => track.stop())
      active.current = next
      setStream(next)
      next.getVideoTracks()[0].onended = stop
    } catch (error) {
      if (
        request === generation.current &&
        !(error instanceof DOMException && error.name === 'NotAllowedError')
      )
        setError(errorText(error))
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  useEffect(
    () => () => {
      generation.current++
      active.current?.getTracks().forEach((track) => track.stop())
    },
    [],
  )
  return { stream, busy, error, start, stop }
}
