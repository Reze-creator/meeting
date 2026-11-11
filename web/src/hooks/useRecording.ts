import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText, session } from '../api'

export interface RecordingSource {
  id: number
  name: string
  stream?: MediaStream
}
interface Capture {
  recorder: MediaRecorder
  context: AudioContext
  output: MediaStream
  timer: ReturnType<typeof setInterval>
  drawTimer: ReturnType<typeof setInterval>
  started: number
  chunks: Blob[]
  bytes: number
  audio: Map<string, MediaStreamAudioSourceNode>
  videos: Map<string, HTMLVideoElement>
  done: Promise<boolean>
  resolve: (saved: boolean) => void
  silence: OscillatorNode
}

/** 浏览器合成会议宫格和混音，生成可回放 WebM；不录制整个桌面或无关页面。 */
export function useRecording(meetingId: string, sources: () => RecordingSource[]) {
  const latest = useRef(sources)
  const capture = useRef<Capture | null>(null)
  const stopRef = useRef<() => Promise<boolean>>(async () => true)
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [backup, setBackup] = useState('')
  const backupRef = useRef('')
  const disposed = useRef(false)
  useEffect(() => {
    latest.current = sources
  }, [sources])
  const stop = useCallback(async () => {
    const current = capture.current
    if (!current) return true
    if (current.recorder.state !== 'inactive') {
      setBusy(true)
      current.recorder.stop()
    }
    return current.done
  }, [])
  useEffect(() => {
    stopRef.current = stop
  }, [stop])
  async function start() {
    if (capture.current) return
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      setError('此浏览器不支持会议录制，请使用桌面版 Chrome 或 Edge。')
      return
    }
    const mime = ['video/webm;codecs=vp8,opus', 'video/webm'].find((type) =>
      MediaRecorder.isTypeSupported(type),
    )
    if (!mime) {
      setError('此浏览器不支持 WebM 录制。')
      return
    }
    setError('')
    setBusy(true)
    let context: AudioContext | undefined
    let output: MediaStream | undefined
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 720
      const painter = canvas.getContext('2d')
      if (!painter) throw new Error('无法创建录制画布')
      context = new AudioContext()
      await context.resume()
      if (disposed.current) {
        void context.close()
        return
      }
      const destination = context.createMediaStreamDestination()
      // 无麦克风时仍保持音频时钟运行，否则部分 Chromium 的 MediaRecorder
      // 会一直等待首个音频帧，最终产生空文件。零增益不会播放或录入测试音。
      const silence = context.createOscillator()
      const silentGain = context.createGain()
      silentGain.gain.value = 0
      silence.connect(silentGain)
      silentGain.connect(destination)
      silence.start()
      output = canvas.captureStream(15)
      destination.stream.getAudioTracks().forEach((track) => output!.addTrack(track))
      let resolve!: (saved: boolean) => void
      const done = new Promise<boolean>((finish) => {
        resolve = finish
      })
      const recorder = new MediaRecorder(output, {
        mimeType: mime,
        videoBitsPerSecond: 1_500_000,
        audioBitsPerSecond: 96_000,
      })
      const current: Capture = {
        recorder,
        context,
        output,
        started: Date.now(),
        chunks: [],
        bytes: 0,
        audio: new Map(),
        videos: new Map(),
        done,
        resolve,
        silence,
        timer: 0 as unknown as ReturnType<typeof setInterval>,
        drawTimer: 0 as unknown as ReturnType<typeof setInterval>,
      }
      capture.current = current
      function render() {
        const items = latest.current()
        const tracks = new Set<string>()
        for (const source of items) {
          for (const track of source.stream?.getAudioTracks() ?? []) {
            if (track.readyState === 'ended') continue
            tracks.add(track.id)
            if (!current.audio.has(track.id)) {
              const node = current.context.createMediaStreamSource(new MediaStream([track]))
              node.connect(destination)
              current.audio.set(track.id, node)
            }
          }
        }
        for (const [id, node] of current.audio) {
          if (!tracks.has(id)) {
            node.disconnect()
            current.audio.delete(id)
          }
        }
        const videoTracks = new Set<string>()
        painter!.fillStyle = '#172133'
        painter!.fillRect(0, 0, 1280, 720)
        const columns = Math.ceil(Math.sqrt(Math.max(items.length, 1)))
        const rows = Math.ceil(Math.max(items.length, 1) / columns)
        const width = 1280 / columns
        const height = 720 / rows
        items.forEach((source, index) => {
          const x = (index % columns) * width
          const y = Math.floor(index / columns) * height
          painter!.fillStyle = '#26354d'
          painter!.fillRect(x + 4, y + 4, width - 8, height - 8)
          const track = source.stream?.getVideoTracks()[0]
          if (track) {
            videoTracks.add(track.id)
            let video = current.videos.get(track.id)
            if (!video) {
              video = document.createElement('video')
              video.srcObject = new MediaStream([track])
              video.muted = true
              video.playsInline = true
              void video.play().catch(() => {})
              current.videos.set(track.id, video)
            }
            if (video.readyState >= 2)
              painter!.drawImage(video, x + 4, y + 4, width - 8, height - 8)
          }
          painter!.fillStyle = '#ffffff'
          painter!.font = '18px sans-serif'
          painter!.fillText(source.name.slice(0, 24), x + 16, y + height - 20)
        })
        for (const [id, video] of current.videos) {
          if (!videoTracks.has(id)) {
            video.pause()
            video.srcObject = null
            current.videos.delete(id)
          }
        }
        // 显式请求画布帧，让纯头像画面和后台标签页也能产生录制视频帧。
        const canvasTrack = current.output.getVideoTracks()[0] as
          CanvasCaptureMediaStreamTrack | undefined
        canvasTrack?.requestFrame?.()
      }
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          current.chunks.push(event.data)
          current.bytes += event.data.size
          if (current.bytes > 80 * 1024 * 1024) void stopRef.current()
        }
      }
      recorder.onerror = () => {
        setError('录制设备出现错误，正在保存已有片段。')
        void stopRef.current()
      }
      recorder.onstop = async () => {
        clearInterval(current.timer)
        clearInterval(current.drawTimer)
        current.audio.forEach((node) => node.disconnect())
        current.videos.forEach((video) => {
          video.pause()
          video.srcObject = null
        })
        current.output.getTracks().forEach((track) => track.stop())
        current.silence.stop()
        void current.context.close()
        setActive(false)
        setBusy(true)
        const blob = new Blob(current.chunks, { type: 'video/webm' })
        let saved = false
        try {
          if (blob.size < 4)
            throw new Error('浏览器没有产生可录制帧，请将会议标签页保持在前台后重试')
          const duration = Math.max(0.1, (Date.now() - current.started) / 1000)
          const response = await fetch(
            `/api/meetings/${meetingId}/recordings?duration=${duration}`,
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${session.get()}`, 'Content-Type': 'video/webm' },
              body: blob,
              signal: AbortSignal.timeout(120000),
            },
          )
          if (!response.ok) {
            const body = await response.json()
            throw new Error(body.error?.message ?? '上传失败')
          }
          saved = true
          setError('录制已保存，可在会议记录中回放。')
        } catch (error) {
          if (disposed.current) return
          if (backupRef.current) URL.revokeObjectURL(backupRef.current)
          if (blob.size >= 4) {
            backupRef.current = URL.createObjectURL(blob)
            setBackup(backupRef.current)
            setError(`录制上传失败：${errorText(error)}。请下载本地备份。`)
          } else {
            backupRef.current = ''
            setBackup('')
            setError(errorText(error))
          }
        } finally {
          capture.current = null
          if (!disposed.current) setBusy(false)
          current.resolve(saved)
        }
      }
      recorder.start(1000)
      render()
      current.drawTimer = setInterval(render, 1000 / 15)
      current.timer = setInterval(() => {
        if (Date.now() - current.started >= 30 * 60 * 1000) void stopRef.current()
      }, 1000)
      setActive(true)
      setBusy(false)
    } catch (error) {
      const current = capture.current
      if (current) {
        clearInterval(current.timer)
        clearInterval(current.drawTimer)
        current.silence.stop()
      }
      output?.getTracks().forEach((track) => track.stop())
      void context?.close()
      capture.current = null
      setBusy(false)
      setError(errorText(error))
    }
  }
  useEffect(() => {
    disposed.current = false
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (capture.current) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      disposed.current = true
      window.removeEventListener('beforeunload', beforeUnload)
      if (backupRef.current) URL.revokeObjectURL(backupRef.current)
      const current = capture.current
      if (current) {
        current.recorder.onstop = null
        current.recorder.ondataavailable = null
        if (current.recorder.state !== 'inactive') current.recorder.stop()
        clearInterval(current.timer)
        clearInterval(current.drawTimer)
        current.output.getTracks().forEach((track) => track.stop())
        current.silence.stop()
        current.videos.forEach((video) => {
          video.srcObject = null
        })
        void current.context.close()
        current.resolve(false)
      }
    }
  }, [])
  return { active, busy, error, backup, start, stop }
}
