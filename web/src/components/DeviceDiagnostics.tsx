import { useEffect, useRef, useState } from 'react'
import type { MediaController } from '../hooks/useMedia'
import { useDeviceMeter } from '../hooks/useDeviceMeter'

export function DeviceDiagnostics({ media }: { media: MediaController }) {
  const level = useDeviceMeter(media.stream, media.mic)
  const test = useRef<AudioContext | null>(null)
  const [playing, setPlaying] = useState(false)
  useEffect(
    () => () => {
      void test.current?.close()
    },
    [],
  )
  async function playTone() {
    if (test.current) {
      await test.current.close()
    }
    const context = new AudioContext()
    test.current = context
    try {
      await context.resume()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = 440
      gain.gain.value = 0.08
      oscillator.connect(gain)
      gain.connect(context.destination)
      setPlaying(true)
      oscillator.onended = () => {
        setPlaying(false)
        void context.close()
        if (test.current === context) test.current = null
      }
      oscillator.start()
      oscillator.stop(context.currentTime + 0.8)
    } catch {
      setPlaying(false)
    }
  }
  return (
    <div className="device-diagnostics">
      <label>
        麦克风电平 <meter min={0} max={100} value={level} aria-label="麦克风电平" />
      </label>
      <small>{media.mic ? '对着麦克风说话，观察电平变化。' : '开启麦克风后可检测输入电平。'}</small>
      <button className="button subtle" disabled={playing} onClick={() => void playTone()}>
        {playing ? '正在播放测试音…' : '扬声器试听'}
      </button>
    </div>
  )
}
