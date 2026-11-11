// WASM 来自锁定 npm 包，模型随源码提交并校验；运行页面不依赖第三方 CDN。
import { mkdir, readdir, copyFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm')
const destination = path.join(root, 'public/vendor/mediapipe')
await mkdir(destination, { recursive: true })
for (const file of await readdir(source)) {
  if (file.endsWith('.wasm') || file.endsWith('.js')) await copyFile(path.join(source, file), path.join(destination, file))
}
const model = await readFile(path.join(root, 'public/models/selfie_segmenter_landscape.tflite'))
const hash = createHash('sha256').update(model).digest('hex')
if (hash !== '490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e') throw new Error('人像分割模型校验失败')
console.log('本地人像分割 WASM 与模型已准备并校验')
