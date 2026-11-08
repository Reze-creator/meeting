import { useEffect, useRef } from 'react'

// 本地预览始终静音，避免自己的麦克风声音回放造成回声。
export function Video({
  stream,
  muted = false,
  mirror = false,
}: {
  stream?: MediaStream
  muted?: boolean
  mirror?: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.srcObject = stream ?? null
    void element.play().catch(() => {
      /* The room's explicit playback control handles autoplay restrictions. */
    })
    return () => {
      element.srcObject = null
    }
  }, [stream])
  return <video ref={ref} autoPlay playsInline muted={muted} className={mirror ? 'mirrored' : ''} />
}
