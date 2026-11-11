export type BackgroundMode = 'off' | 'blur' | 'studio'

/** 将人像概率转为柔和透明度，避免二值阈值造成头发边缘锯齿。 */
export function maskPixels(confidence: Float32Array): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(confidence.length * 4)
  confidence.forEach((value, index) => {
    pixels[index * 4] = pixels[index * 4 + 1] = pixels[index * 4 + 2] = 255
    pixels[index * 4 + 3] = Math.round(Math.max(0, Math.min(1, (value - 0.25) / 0.5)) * 255)
  })
  return pixels
}

/** 模型与 WASM 均由本机页面提供，不发送摄像头帧到服务器。 */
export async function createBackgroundProcessor(
  raw: MediaStreamTrack,
  mode: Exclude<BackgroundMode, 'off'>,
  onError: (message: string) => void,
  signal: AbortSignal,
) {
  const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision')
  const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe')
  signal.throwIfAborted()
  const segmenter = await ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/models/selfie_segmenter_landscape.tflite', delegate: 'CPU' },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  })
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([raw])
  let output: MediaStream | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    signal.removeEventListener('abort', close)
    clearInterval(timer)
    segmenter.close()
    video.pause()
    video.srcObject = null
    output?.getTracks().forEach((track) => track.stop())
  }
  if (signal.aborted) {
    close()
    signal.throwIfAborted()
  }
  signal.addEventListener('abort', close, { once: true })
  try {
    await Promise.race([
      video.play(),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('已取消背景处理', 'AbortError')),
          { once: true },
        )
      }),
    ])
    signal.throwIfAborted()
    const canvas = document.createElement('canvas')
    // 限制处理分辨率和帧率，避免主线程推理拖慢会议 UI。
    canvas.width = 640
    canvas.height = 360
    const painter = canvas.getContext('2d')!
    const maskCanvas = document.createElement('canvas')
    const maskPainter = maskCanvas.getContext('2d')!
    const personCanvas = document.createElement('canvas')
    personCanvas.width = canvas.width
    personCanvas.height = canvas.height
    const person = personCanvas.getContext('2d')!
    if (!painter || !maskPainter || !person) throw new Error('浏览器不支持 Canvas 合成')
    output = canvas.captureStream(15)
    function render() {
      if (closed || !raw.enabled || raw.readyState === 'ended' || video.readyState < 2) return
      try {
        segmenter.segmentForVideo(video, performance.now(), (result) => {
          const mask = result.confidenceMasks?.[0]
          if (!mask) throw new Error('人像分割没有返回概率掩膜')
          maskCanvas.width = mask.width
          maskCanvas.height = mask.height
          const pixels = new Uint8ClampedArray(maskPixels(mask.getAsFloat32Array()))
          maskPainter.putImageData(new ImageData(pixels, mask.width, mask.height), 0, 0)
          person.clearRect(0, 0, 640, 360)
          person.globalCompositeOperation = 'source-over'
          person.drawImage(video, 0, 0, 640, 360)
          person.globalCompositeOperation = 'destination-in'
          person.drawImage(maskCanvas, 0, 0, 640, 360)
          painter.globalCompositeOperation = 'source-over'
          painter.clearRect(0, 0, 640, 360)
          if (mode === 'blur') {
            painter.filter = 'blur(16px)'
            painter.drawImage(video, -20, -20, 680, 400)
            painter.filter = 'none'
          } else {
            const gradient = painter.createLinearGradient(0, 0, 640, 360)
            gradient.addColorStop(0, '#dce8f8')
            gradient.addColorStop(1, '#68809f')
            painter.fillStyle = gradient
            painter.fillRect(0, 0, 640, 360)
            painter.fillStyle = '#ffffff33'
            painter.fillRect(440, 0, 12, 360)
          }
          painter.drawImage(personCanvas, 0, 0)
        })
      } catch {
        onError('虚拟背景处理失败，已停止发送画面。请关闭虚拟背景或重试。')
        close()
      }
    }
    render()
    timer = setInterval(render, 1000 / 15)
    return { track: output.getVideoTracks()[0], close }
  } catch (error) {
    close()
    throw error
  }
}
