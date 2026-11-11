import { expect, it } from 'vitest'
import { encodeWav } from './pcm'
import { maskPixels } from './background'

it('PCM 编码输出独立 WAV 容器，正负峰值不会溢出', async () => {
  const blob = encodeWav(new Float32Array([-2, 0, 2]), 16000)
  // jsdom Blob 不提供 arrayBuffer，使用 FileReader 验证实际二进制。
  const buffer = await new Promise<ArrayBuffer>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.readAsArrayBuffer(blob)
  })
  const data = new DataView(buffer)
  expect(data.byteLength).toBe(50)
  expect(data.getUint32(24, true)).toBe(16000)
  expect(data.getInt16(44, true)).toBe(-32768)
  expect(data.getInt16(48, true)).toBe(32767)
  expect(data.getUint32(40, true)).toBe(6)
})
it('人像概率掩膜保留人物、移除背景，过渡概率产生柔和透明度', () => {
  const pixels = maskPixels(new Float32Array([0, 0.5, 1]))
  expect([pixels[3], pixels[7], pixels[11]]).toEqual([0, 128, 255])
})
