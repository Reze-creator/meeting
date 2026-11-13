# Comeet 在线会议

React + TypeScript + Vite、Go、SQLite、WebSocket 与 WebRTC 实现的在线会议项目。已完成基础档、进阶档及挑战档前三项（实时字幕、DeepSeek AI 纪要、本地人像分割虚拟背景），关键生命周期和并发流程附有中文注释。

## 快速启动

完整字幕/纪要/虚拟背景演示：在后端 `.env` 配置 `DEEPSEEK_API_KEY` 后运行 `.\scripts\start-challenge.ps1`，需要 Python 3.11–3.13。默认使用轻量 Whisper tiny，首次自动下载；需要更高识别质量可加 `-Model small`。启动脚本同时兼容 Windows PowerShell 5.1 和 PowerShell 7。详细说明、配置与验证边界见 **`docs/挑战档.md`**。

在项目根目录运行完整进阶演示：

```powershell
.\scripts\start-advanced.ps1
```

首次自动安装固定版本 LiveKit 1.13.11（校验官方 SHA256），启动本机 SFU，安装/构建前端并启动 Go。访问 **http://127.0.0.1:8080**，注册账号即可使用。Ctrl+C 停止应用和本次创建的媒体子进程。

只需要运行兼容 P2P 模式时：

```powershell
.\scripts\start.ps1
```

详细的 SFU、分步启动、自建服务配置、功能说明和测试步骤见 **`docs/进阶档.md`**。PowerShell 脚本受本机策略限制时，可按该文档及下述命令分别启动，不需要修改系统执行策略。

```powershell
go mod download
cd web
npm.cmd ci
npm.cmd run build
cd ..
go run ./cmd/server
```

Go 服务必须从项目根目录启动，以读取 `.env`、数据库和前端构建结果。开发时另开终端运行 `cd web; npm.cmd run dev`，访问 5173 端口；Vite 已配置 API 和 WebSocket 代理。

## 完成范围

| 档位 | 功能 |
| --- | --- |
| 基础 | 注册/登录、bcrypt、JWT、工作台、创建/加入、设备准备、成员同步、持久化群聊、离会释放、重连和消息补齐 |
| 媒体进阶 | 屏幕独立发布/停止/观看，LiveKit SFU 多方转发，VP8 Simulcast 摄像头发布和远端订阅 |
| 设备进阶 | 麦克风电平、扬声器试听、麦克风/摄像头选择、设备热插拔刷新与默认输入恢复，恢复时保持静音状态 |
| 会控进阶 | 主持人静音成员、允许自主开麦、移出成员、结束会议，服务端权限验证及持久化限制 |
| 记录进阶 | 历史会议列表、参会者/时间/聊天详情、主持人浏览器录制、保存 WebM、鉴权回放 |
| 交互进阶 | 宫格、演讲者、共享主画面、固定成员、响应式布局、聊天未读徽标、发送状态和重试去重 |
| 服务治理 | JWT/Origin/输入校验、用户/IP/WS 限流、会议最长时长调度、结构化日志、退出等待及媒体房间清理 |

未配置 LiveKit 时可运行 P2P；**SFU 转发、Simulcast 和媒体端强制会控需要启用 LiveKit**。挑战档前三项已实现：约四秒片段 STT 实时字幕、DeepSeek 结构化会议纪要、MediaPipe 人像分割 + Canvas 虚拟背景。HTTPS 公网上线与生产可观测性按本次范围暂不实现。

## 配置

复制 `.env.example` 为 `.env` 后修改，系统环境变量优先。前端读取根目录 `.env`，修改 `VITE_` 变量后需重新构建。

| 变量 | 默认值/用途 |
| --- | --- |
| `ADDR` | `127.0.0.1:8080` |
| `DB_PATH` | `data/comeet.db`，自动建库并增量新增进阶表 |
| `JWT_SECRET` | 未指定则每次启动随机生成，至少 32 字节；重启会使原登录失效 |
| `ALLOWED_ORIGINS` | 本机 5173/8080，逗号分隔完整来源 |
| `RECORDING_DIR` | `data/recordings`，不对外静态暴露 |
| `MEETING_MAX_MINUTES` | `240`，按创建时间计算，每 5 秒检查 |
| `LOG_FORMAT` | `text` 或 `json` |
| `LIVEKIT_URL` | 浏览器访问的 SFU WebSocket URL；空值启用 P2P |
| `LIVEKIT_INTERNAL_URL` | Go 调用媒体管理 API 的地址，默认跟随 URL |
| `LIVEKIT_API_KEY/SECRET` | 仅后端使用，不加 `VITE_` 前缀 |
| `VITE_STUN_URL` | P2P STUN URL，默认公共 STUN，可逗号分隔 |
| `VITE_TURN_URL/USERNAME/CREDENTIAL` | 可选 P2P TURN 演示配置，不填写管理员凭据 |

生产环境需固定随机 JWT 密钥、自有媒体密钥、HTTPS/WSS、正确的 ICE/TURN 和反向代理配置。`VITE_` 配置会进入浏览器，不能放服务端密钥。`.env`、数据库、录制、构建输出和 bin 均已列入 `.gitignore`。

## 验收与质量检查

```powershell
.\scripts\check.ps1
# 启动 LiveKit 后，另一个终端执行真实 WebRTC 测试：
.\scripts\test-media.ps1
```

常规检查包括 Go 测试和 vet、前端格式、无警告 Lint、前端回归测试、strict TypeScript 和生产构建。真实媒体测试使用两个独立 WebRTC 客户端和合成音频，不调用真实设备。挑战档另有 `scripts/test-stt.ps1` 和 `scripts/test-intelligence.ps1` 验证真实语音识别与 DeepSeek 业务链。

建议用两个独立标签页注册不同账号：创建会议 → 设备检测 → 共享/布局切换 → 成员会控 → 聊天未读/重试 → 主持人录制并保存 → 结束会议 → 已结束列表详情与回放。重复同一账号入会时新连接替换旧连接；被移出的账号不能重新通过应用加入本场会议。

完整测试证据与实测边界见 `docs/验收记录.md`。已通过真实 SFU 音频转发与会控，浏览器录制保存及 1280×720 WebM 回放；真实屏幕选择、硬件热插拔、实际摄像头/麦克风和公网网络仍需设备实测。

## 代码结构

```text
cmd/server/                 服务入口、日志、优雅退出
internal/config/            环境变量与 .env
internal/store/             SQLite 模型、增量表、历史与录制查询
internal/server/            REST、房间信令、权限、会控、调度、文件鉴权
internal/media/             SFU 房间令牌、管理接口、真实媒体测试
web/src/pages/              登录、工作台、入会准备、会议室
web/src/components/         聊天、设备检测、历史与回放、视频和图标
web/src/hooks/              设备、共享、P2P/SFU、重连、录制生命周期
scripts/                    安装、启动、常规检查、真实媒体测试
deploy/                     本机 LiveKit 配置
docs/                       API、进阶运行、验收记录
方案.md                     Markdown 幻灯片方案
```

数据库用户、会议和消息保留；在线成员仍为单进程内存模型。参会记录保存每人每场最近一次加入/离开时间。登录态在 `sessionStorage` 中；复制浏览器标签页可能复制初始登录态，演示不同用户时请独立新建并登录。

录制由主持人浏览器合成，单段最多 30 分钟/约 80 MiB；上传失败提供本地备份。它不替代服务器 Egress 后台录制，正式应用还需对象存储、配额、清理和生产级媒体事件对账。详细限制见进阶文档。
