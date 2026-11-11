// 音频线程只采集和合并单声道 PCM；网络与 React 状态留在主线程。
// 固定四秒片段，不重启采集器，因此片段边界不丢帧。
class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.samples = new Float32Array(Math.round(sampleRate * 4))
    this.offset = 0
    this.port.onmessage = (event) => {
      if (event.data === 'flush') this.flush()
    }
  }
  flush() {
    if (this.offset < sampleRate * 0.2) return
    const samples = this.samples.slice(0, this.offset)
    this.port.postMessage({ samples, sampleRate }, [samples.buffer])
    this.offset = 0
  }
  process(inputs) {
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0
      for (const channel of channels) sample += channel[i] / channels.length
      this.samples[this.offset++] = sample
      if (this.offset === this.samples.length) this.flush()
    }
    return true
  }
}
registerProcessor('comeet-pcm', PCMCapture)
