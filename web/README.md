# Comeet 前端

运行指南、功能范围和双人验收步骤见项目根目录的 `README.md`。

```powershell
npm.cmd ci
npm.cmd run dev
```

开发服务默认使用 `http://127.0.0.1:5173`，将 `/api` 和 `/ws` 代理到根目录启动的 Go 服务 `http://127.0.0.1:8080`。

代码按 `pages`（页面）、`components`（复用组件）和 `hooks`（设备、音视频、房间逻辑）组织。修改后运行 `npm.cmd run format`，再依次执行 `format:check`、`lint`、`test` 和 `build`。

前端读取根目录 `.env`。只有 `VITE_` 开头的配置会进入浏览器，不能包含服务端密钥。
