# 人像分割模型

`selfie_segmenter_landscape.tflite` 来自 Google MediaPipe 官方模型库：

https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite

版本：float16 / 1；大小 250177 字节。

SHA256：`490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e`。

用途：仅在浏览器本地推理人像概率掩膜，再用 Canvas 合成背景。Google MediaPipe 模型及代码遵循上游 Apache-2.0 许可，许可正文见 `LICENSE`；WASM 由锁定的 `@mediapipe/tasks-vision` npm 包提供。
