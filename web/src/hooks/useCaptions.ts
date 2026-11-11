import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText, session } from '../api'
import type { Caption } from '../types'
import { encodeWav } from '../media/pcm'

export function mergeCaptions(current: Caption[], incoming: Caption[]) {
  return [...new Map([...current, ...incoming].map((item) => [item.id, item])).values()]
    .sort((a, b) => a.id - b.id)
    .slice(-500)
}

/** 仅识别本人已开启的麦克风。关闭字幕、静音、离会或会话替换都会中止请求和音频节点。 */
export function useCaptions(options: {
  meetingId: string
  sessionId: string
  online: boolean
  mic: boolean
  stream?: MediaStream
  enabled: boolean
}) {
  const enabled = options.enabled
  const [language, setLanguage] = useState('zh')
  const [items, setItems] = useState<Caption[]>([])
  const [error, setError] = useState('')
  const [recognizing, setRecognizing] = useState(false)
  const cursor = useRef(0)
  const receive = useCallback((caption: Caption) => {
    // 推送先于历史补齐时，不推进历史游标，防止跳过推送前的遗漏字幕。
    setItems((old) => mergeCaptions(old, [caption]))
  }, [])
  useEffect(() => {
    if (!options.online) return
    const controller = new AbortController()
    async function repair() {
      try {
        let more = true
        while (more && !controller.signal.aborted) {
          const page = await api<Caption[]>(
            `/meetings/${options.meetingId}/captions?after=${cursor.current}`,
            { signal: controller.signal },
          )
          if (controller.signal.aborted) return
          setItems((old) => mergeCaptions(old, page))
          if (page.length) cursor.current = Math.max(cursor.current, ...page.map((item) => item.id))
          more = page.length === 100
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(errorText(error))
      }
    }
    void repair()
    return () => controller.abort()
  }, [options.meetingId, options.online, options.sessionId])
  const audio = options.stream?.getAudioTracks()[0]
  useEffect(() => {
    if (!enabled || !options.mic || !options.online || !audio) return
    let disposed = false
    let context: AudioContext | undefined
    let source: MediaStreamAudioSourceNode | undefined
    let node: AudioWorkletNode | undefined
    let processing = false
    const controller = new AbortController()
    async function initialize() {
      try {
        context = new AudioContext({ sampleRate: 16000 })
        await context.resume()
        await context.audioWorklet.addModule('/audio/pcm-capture.js')
        if (disposed) return
        source = context.createMediaStreamSource(new MediaStream([audio!]))
        node = new AudioWorkletNode(context, 'comeet-pcm')
        const silent = context.createGain()
        silent.gain.value = 0
        source.connect(node)
        node.connect(silent)
        silent.connect(context.destination)
        setError('')
        node.port.onmessage = (
          event: MessageEvent<{ samples: Float32Array; sampleRate: number }>,
        ) => {
          if (disposed || !audio?.enabled) return
          const { samples, sampleRate } = event.data
          const rms = Math.sqrt(
            samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
          )
          if (rms < 0.003) return // 跳过近乎静音片段，减少空白语音的幻觉与无用调用。
          if (processing) {
            setError('识别速度低于实时速度，已跳过积压片段。请使用更快的 STT 模型或服务。')
            return
          }
          processing = true
          setRecognizing(true)
          const startedAt = new Date(
            Date.now() - (samples.length / sampleRate) * 1000,
          ).toISOString()
          const query = new URLSearchParams({
            clientId: crypto.randomUUID(),
            sessionId: options.sessionId,
            language,
            startedAt,
          })
          void fetch(`/api/meetings/${options.meetingId}/transcribe?${query}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.get()}`, 'Content-Type': 'audio/wav' },
            body: encodeWav(samples, sampleRate),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]),
          })
            .then(async (response) => {
              const body = await response.json()
              if (!response.ok) throw new Error(body.error?.message ?? '字幕识别失败')
              if (!disposed && body.data?.id) receive(body.data as Caption)
            })
            .catch((error) => {
              if (!disposed) setError(errorText(error))
            })
            .finally(() => {
              processing = false
              if (!disposed) setRecognizing(false)
            })
        }
      } catch (error) {
        if (!disposed) setError(errorText(error))
      }
    }
    void initialize()
    return () => {
      disposed = true
      controller.abort()
      source?.disconnect()
      node?.disconnect()
      if (node) {
        node.port.onmessage = null
        node.port.close()
      }
      void context?.close()
      setRecognizing(false)
    }
  }, [
    audio,
    enabled,
    language,
    options.meetingId,
    options.mic,
    options.online,
    options.sessionId,
    receive,
  ])
  return { enabled, language, setLanguage, items, error, recognizing, receive }
}
