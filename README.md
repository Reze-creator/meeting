# Comeet 在线会议 · 基础档

使用 React + TypeScript + Vite、Go、SQLite 和 WebSocket 实现的可运行项目。已实现基础档要求，并接入浏览器 WebRTC P2P 音视频，适合本机或小规模会议演示。

## 已实现

- 注册、登录、bcrypt 密码存储、24 小时 JWT 鉴权及过期退出。
- 工作台创建即时会议、输入 9 位会议号加入会议、查看本人参与的会议。
- 入会准备：麦克风选择、静音入会、摄像头开关、本地预览。
- 在线成员列表：昵称、本人标识、主持人标识、麦克风及摄像头状态同步。
- 群聊：实时广播、SQLite 持久化、最近 100 条历史、向前翻页、断线消息补齐、发送确认与重试去重。
- 主动离会、关闭页面后的连接清理、媒体轨道释放。
- 断线提示、指数退避自动重连、网络恢复后立即重试。
- 同账号重复入会采用“新连接替换旧连接”，旧页面会明确退出；旧连接清理不会删除新连接。
- 主持人结束会议、全员通知、结束后禁止再次加入。
- REST 统一错误结构、输入长度限制、登录接口限流、WebSocket Origin 校验、心跳检测。

## 启动方式

已在 Windows 上使用 Go 1.27.3、Node.js 24.15.0 和 npm 11.12.1 验证。依赖版本由 `go.mod`、`go.sum` 和 `web/package-lock.json` 固定。SQLite 使用纯 Go 驱动，不要求本机安装数据库或 C 编译器。

在项目根目录运行：

```powershell
.\scripts\start.ps1
```

脚本安装依赖、构建前端并启动 Go 服务。打开 **http://127.0.0.1:8080**，注册自己的账号即可使用。使用 Ctrl+C 关闭服务。

若当前系统不允许运行 PowerShell 脚本，可以直接执行下面的命令，无需修改系统执行策略：

```powershell
go mod download
cd web
npm.cmd ci
npm.cmd run build
cd ..
go run ./cmd/server
```

不要用 `file://` 打开 `index.html`，也不要在 `web` 目录中启动 Go 服务；服务需要从项目根目录读取配置和前端构建结果。

### 前后端分别开发

终端 A，在项目根目录运行：

```powershell
go run ./cmd/server
```

终端 B：

```powershell
cd web
npm.cmd ci
npm.cmd run dev
```

打开 **http://127.0.0.1:5173**。Vite 已把 `/api` 和 `/ws` 代理给 Go 服务，支持热更新。

## 配置与数据

可以把根目录 `.env.example` 复制为 `.env` 后修改。系统环境变量优先于 `.env`。前端同样读取根目录的 `.env`，修改 `VITE_` 配置后需要重新构建。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ADDR` | `127.0.0.1:8080` | HTTP 监听地址 |
| `DB_PATH` | `data/comeet.db` | SQLite 路径，自动建目录和表 |
| `JWT_SECRET` | 启动时生成随机密钥 | 至少 32 字节；未固定时重启会使登录失效 |
| `ALLOWED_ORIGINS` | localhost / 127.0.0.1 的 5173、8080 来源 | 逗号分隔，需填写完整协议、域名和端口 |
| `VITE_STUN_URL` | `stun:stun.l.google.com:19302` | ICE STUN URL，可逗号分隔 |
| `VITE_TURN_URL` | 空 | 可选 TURN 中继 URL |
| `VITE_TURN_USERNAME` | 空 | TURN 用户名 |
| `VITE_TURN_CREDENTIAL` | 空 | TURN 短期凭据 |

生产环境必须固定随机 `JWT_SECRET`、配置正确来源并使用 HTTPS。`VITE_` 变量会进入浏览器，不能放入管理员密钥。TURN 演示配置为静态值，生产环境应通过后端签发短期凭据。

数据库保存用户、会议、参会关系和聊天消息。房间在线成员保存在内存中；服务重启后浏览器重连并重建在线状态，会议和聊天记录仍保留。参会表保留每人每场会议最近一次连接的加入/离开时间，不是完整出勤事件流水。

登录凭据保存在 `sessionStorage` 中。为了演示不同用户，建议直接新建独立标签页并分别登录；浏览器“复制标签页”可能复制原标签页会话存储，此时退出后登录另一个账号即可。

## 双人验收步骤

1. 打开两个独立标签页，分别注册账号 A 和 B。
2. A 创建会议，在准备页确认设备。默认静音且摄像头关闭，无设备也能入会聊天。
3. A 将会议号给 B，B 输入会议号并加入。
4. 双方查看成员列表，确认本人、主持人及设备开关标识。
5. 双方发送消息，确认另一侧实时收到；B 离开再加入，确认历史消息仍在。
6. 在浏览器开发工具中临时断网，再恢复，检查“断线重连中”提示和消息补齐。
7. 如有可用设备，开启双方麦克风/摄像头验证音视频。使用耳机防止同一房间内声学回声。若浏览器拦截自动播放，可点击“启用声音播放”。
8. B 点击离会，A 的成员数应减少；B 的本地设备应停止。
9. A 点击“结束会议”并确认，所有成员返回工作台，该会议出现在已结束列表，再加入应失败。

## 自动化检查

安装依赖后，在根目录执行：

```powershell
.\scripts\check.ps1
```

也可以分别执行：

```powershell
go test ./... -count=1
go vet ./...
cd web
npm.cmd run format:check
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

测试覆盖鉴权、主持人权限、非法输入、Origin 校验、真实双连接 WebSocket 聊天广播、消息去重、断线后的消息游标、重复连接替换、会议结束通知、SQLite 重启和分页，以及前端设备释放、权限拒绝、异步权限返回、自动重连、中文输入法与消息确认。详细记录见 `docs/验收记录.md`。

## 目录与阅读顺序

```text
meeting/
├─ cmd/server/main.go           # 服务入口与退出流程
├─ internal/
│  ├─ config/config.go          # 环境变量和 .env
│  ├─ store/store.go            # 表结构、模型和持久化
│  └─ server/
│     ├─ server.go              # 路由、中间件、静态资源
│     ├─ auth.go                # 登录注册和 JWT
│     ├─ meetings.go            # 会议生命周期与聊天历史接口
│     ├─ hub.go                 # 房间、成员同步与 WebSocket
│     ├─ response.go            # JSON 解码与统一错误
│     ├─ ratelimit.go           # 登录接口限流
│     └─ id.go                  # 随机连接会话编号
├─ web/src/
│  ├─ api.ts                   # HTTP 客户端、会话存储
│  ├─ types.ts                 # 共享数据类型
│  ├─ pages/                   # 登录、工作台、准备和会议室
│  ├─ components/              # 聊天、媒体渲染和图标
│  └─ hooks/                   # 本地设备、P2P、信令与重连
├─ scripts/                    # 启动和质量检查
├─ docs/                       # API 与验收说明
├─ 方案.md                     # 技术方案与完成范围
└─ .env.example                # 可公开提交的配置模板
```

建议按 `main.go → server.go → auth.go / meetings.go → hub.go → store.go` 阅读后端；前端按 `App.tsx → pages → hooks → components` 阅读。关键并发、去重、异步回调和媒体资源管理处附有中文注释。

## 当前边界

- 本次交付以基础档为目标。未实现屏幕共享、Simulcast、主持人强制静音/移出成员、录制回放、实时字幕、AI 纪要和虚拟背景。
- 已接入基础 P2P 音视频，建议 2–4 人演示；没有 SFU，不宣称大规模会议能力。
- 跨运营商/企业 NAT 网络可能需要自己的 TURN。默认公共 STUN 的可用性不由本项目保证。
- 浏览器访问摄像头和麦克风需要安全上下文，localhost 可直接使用；局域网 IP 的普通 HTTP 通常不能调用设备，需要 HTTPS。
- 本次浏览器验收在关闭真实设备的情况下完成；自动化设备测试使用模拟轨道。真实声音、摄像头、跨设备及公网连通性仍需按上述步骤实测。
- 刷新会议页面会释放旧连接并回到工作台，可重新加入。退出登录清除当前标签页 JWT；服务端没有 JWT 撤销表。
- 房间为单进程内存模型，尚未做多实例共享和生产级监控；数据库为第一版自动建表，未来变更需增加版本迁移。
