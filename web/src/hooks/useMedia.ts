import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../api'
import { useBackground } from './useBackground'

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
  const recovery = useRef<(kind: 'audio' | 'video', enabled: boolean) => void>(() => {})
  const recovering = useRef(new Set<'audio' | 'video'>())
  const [stream, setStream] = useState<MediaStream>()
  const [mic, setMic] = useState(false)
  const [camera, setCamera] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [cameraId, setCameraId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const background = useBackground(stream, camera)

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices) return
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      if (mounted.current) {
        setDevices(list)
        for (const kind of ['audio', 'video'] as const) {
          const track = tracks.current[kind]
          const selected = track?.getSettings?.().deviceId
          if (selected && !list.some((device) => device.deviceId === selected))
            recovery.current(kind, track!.enabled)
        }
      }
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
    async (kind: 'audio' | 'video', selectedDevice = '', preserveEnabled?: boolean) => {
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
            : {
                audio: false,
                video: {
                  ...(selectedDevice ? { deviceId: { exact: selectedDevice } } : {}),
                  width: { ideal: 1280 },
                  height: { ideal: 720 },
                },
              },
        )
        const nextTrack = nextStream.getTracks()[0]
        // 权限弹窗可能延迟返回；离开页面后的请求结果不能重新开启设备。
        if (!mounted.current || request !== requests.current[kind]) {
          nextStream.getTracks().forEach((track) => track.stop())
          return
        }
        const enabled = preserveEnabled ?? tracks.current[kind]?.enabled ?? true
        nextTrack.enabled = enabled
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
          recovery.current(kind, nextTrack.enabled)
        }
        setStream(
          new MediaStream(
            Object.values(tracks.current).filter((track): track is MediaStreamTrack => !!track),
          ),
        )
        if (kind === 'audio') {
          setMic(enabled)
          setDeviceId(selectedDevice)
        } else {
          setCamera(enabled)
          setCameraId(selectedDevice)
        }
        await refreshDevices()
      } catch (error) {
        if (mounted.current && request === requests.current[kind]) setError(deviceError(error))
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [refreshDevices],
  )

  useEffect(() => {
    recovery.current = (kind, enabled) => {
      if (recovering.current.has(kind)) return
      recovering.current.add(kind)
      // 自动恢复保留原静音状态，不因插拔耳机而突然打开麦克风。
      void acquire(kind, '', enabled).finally(() => recovering.current.delete(kind))
    }
  }, [acquire])

  const toggle = useCallback(
    async (kind: 'audio' | 'video') => {
      const track = tracks.current[kind]
      if (track) {
        track.enabled = !track.enabled
        if (kind === 'audio') setMic(track.enabled)
        else setCamera(track.enabled)
      } else await acquire(kind, kind === 'audio' ? deviceId : cameraId)
    },
    [acquire, deviceId, cameraId],
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
  const mute = useCallback(() => {
    const audio = tracks.current.audio
    if (audio) audio.enabled = false
    setMic(false)
  }, [])
  return {
    stream: background.stream,
    rawStream: stream,
    background,
    mic,
    camera,
    devices,
    deviceId,
    cameraId,
    error: error || background.error,
    busy,
    toggle,
    stop,
    selectMicrophone: (id: string) => acquire('audio', id),
    selectCamera: (id: string) => acquire('video', id),
    mute,
  }
}
export type MediaController = ReturnType<typeof useMedia>
