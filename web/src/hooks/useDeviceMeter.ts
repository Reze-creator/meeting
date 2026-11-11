import { useEffect, useState } from 'react'

/** 仅在设备面板挂载时采样，不连接扬声器，避免麦克风测试产生回声。 */
export function useDeviceMeter(stream: MediaStream | undefined, enabled: boolean) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    if (!enabled || !stream?.getAudioTracks().length) return
    const context = new AudioContext()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 256
    source.connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples)
      const rms = Math.sqrt(
        samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length,
      )
      setLevel(Math.min(100, Math.round(rms * 300)))
    }, 100)
    return () => {
      clearInterval(timer)
      source.disconnect()
      void context.close()
    }
  }, [stream, enabled])
  return enabled ? level : 0
}
