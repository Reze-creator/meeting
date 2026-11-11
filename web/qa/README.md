# 虚拟背景实际模型验收

常规单元测试验证生命周期和隐私边界；本页补充实际 WASM 推理与 Canvas 输出检查，不调用摄像头。

1. 从 Google 官方样例下载 `https://storage.googleapis.com/mediapipe-assets/pose.jpg` 到本目录 `portrait.jpg`（测试素材被 Git 忽略）。
2. 执行 `npm run dev`，访问 `http://127.0.0.1:5173/qa/background.html`。
3. 点击“开始本地模型验收”，应显示人物保留、背景替换为工作室，并显示输出 640×360、track=live。

页面仅供开发服务器验收，Vite 生产构建不会包含 `qa` 页面。

`/qa/pcm.html` 可以用浏览器振荡器验证真实 AudioWorklet 四秒分段和 PCM WAV 编码，不访问麦克风。
