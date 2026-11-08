import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../api'

function deviceError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError')
      return '设备权限未获允许。你仍可静音入会，也可在浏览器设置中允许后重试。'
    if (error.name === 'NotFoundError') return '未找到可用设备。请连接麦克风或摄像头后重试。'
    if (error.name === 'NotReadableError')
      return '设备正被其他应用占用，请关闭占用设备的应用后重试。'
    if (error.name === 'OverconstrainedError') return '所选设备不可用，请选择其他设备。'
  }
  return errorText(error)
}

/** 统一管理本地媒体轨道；设备切换和页面卸载时停止旧轨道。 */
export function useMedia() {
  const tracks = useRef<{ audio?: MediaStreamTrack; video?: MediaStreamTrack }>({})
  const mounted = useRef(true)
  const requests = useRef({ audio: 0, video: 0 })
  const [stream, setStream] = useState<MediaStream>()
  const [mic, setMic] = useState(false)
  const [camera, setCamera] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices) return
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      if (mounted.current) setDevices(list)
    } catch {
      /* Device labels may be hidden without permission. */
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => {
      if (mounted.current) void refreshDevices()
    })
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices)
    const requestState = requests.current
    return () => {
      mounted.current = false
      requestState.audio++
      requestState.video++
      Object.values(tracks.current).forEach((track) => track?.stop())
      navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices)
    }
  }, [refreshDevices])

  const acquire = useCallback(
    async (kind: 'audio' | 'video', selectedDevice = '') => {
      const request = ++requests.current[kind]
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('当前环境无法访问设备，请使用 localhost 或 HTTPS。')
        return
      }
      setBusy(true)
      setError('')
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia(
          kind === 'audio'
            ? {
                audio: selectedDevice
                  ? { deviceId: { exact: selectedDevice }, echoCancellation: true }
                  : { echoCancellation: true },
                video: false,
              }
            : { audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
        )
        const nextTrack = nextStream.getTracks()[0]
        // 权限弹窗可能延迟返回；离开页面后的请求结果不能重新开启设备。
        if (!mounted.current || request !== requests.current[kind]) {
          nextStream.getTracks().forEach((track) => track.stop())
          return
        }
        tracks.current[kind]?.stop()
        tracks.current[kind] = nextTrack
        nextTrack.onended = () => {
          if (!mounted.current || tracks.current[kind] !== nextTrack) return
          delete tracks.current[kind]
          if (kind === 'audio') setMic(false)
          else setCamera(false)
          setStream(
            new MediaStream(
              Object.values(tracks.current).filter((track): track is MediaStreamTrack => !!track),
            ),
          )
          setError('设备已断开，请重新选择或开启。')
        }
        setStream(
          new MediaStream(
            Object.values(tracks.current).filter((track): track is MediaStreamTrack => !!track),
          ),
        )
        if (kind === 'audio') {
          setMic(true)
          setDeviceId(selectedDevice)
        } else setCamera(true)
        await refreshDevices()
      } catch (error) {
        if (mounted.current && request === requests.current[kind]) setError(deviceError(error))
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [refreshDevices],
  )

  const toggle = useCallback(
    async (kind: 'audio' | 'video') => {
      const track = tracks.current[kind]
      if (track) {
        track.enabled = !track.enabled
        if (kind === 'audio') setMic(track.enabled)
        else setCamera(track.enabled)
      } else await acquire(kind, kind === 'audio' ? deviceId : '')
    },
    [acquire, deviceId],
  )

  const stop = useCallback(() => {
    requests.current.audio++
    requests.current.video++
    Object.values(tracks.current).forEach((track) => track?.stop())
    tracks.current = {}
    setStream(undefined)
    setMic(false)
    setCamera(false)
  }, [])
  return {
    stream,
    mic,
    camera,
    devices,
    deviceId,
    error,
    busy,
    toggle,
    stop,
    selectMicrophone: (id: string) => acquire('audio', id),
  }
}
export type MediaController = ReturnType<typeof useMedia>
