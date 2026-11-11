# HTTP 与 WebSocket 协议

## 挑战档前三项新增接口

以下接口均要求 Bearer JWT，会议数据仅本场参会者可读，生成纪要仅主持人可调用。普通 API 限流继续生效；模型调用使用独立的 30 秒 STT / 120 秒纪要超时，不在 Hub 锁中等待网络。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/intelligence` | 返回 `{captions,minutes,minutesModel}`，不返回密钥或服务内部地址 |
| GET | `/api/meetings/{id}/captions?after=ID&before=ID` | 每页最多 100 条，首次取最近页，after 从旧到新补齐，before 向前翻页 |
| POST | `/api/meetings/{id}/transcribe?clientId=唯一编号&sessionId=当前WS会话&startedAt=ISO时间&language=zh或en` | `Content-Type: audio/wav`，0.2–8 秒、最多 2 MiB、44 字节头的单声道 PCM16 WAV；本人必须在线、开麦、开启字幕且未被禁麦 |
| GET | `/api/meetings/{id}/transcript` | 鉴权导出全部已保存转写为 UTF-8 TXT，分页遍历，不仅导出最近一页；最大 16 MiB |
| GET | `/api/meetings/{id}/minutes` | `{minutes:null或{content,model,sourceHash,createdAt},stale}`；content 包含 overview、decisions、actions、risks |
| POST | `/api/meetings/{id}/minutes` | 主持人生成/更新 DeepSeek 纪要；JSON 请求体可为空，资料来自服务端快照，每场最多一个在途生成任务 |

转写成功返回 201 和 `Caption`：`{id,meetingId,userId,name,clientId,text,startedAt,duration,createdAt}`，无语音返回 200 `{empty:true}`，重复片段返回原有字幕。身份从 JWT 取得，模型调用完成后重新校验会话状态，丢弃静音、离会或连接替换后的结果。

WS `state` 新增 `captioning:boolean`，`members` 快照同步实际状态。新事件 `caption` 携带已保存的 Caption。字幕推送与历史读取以 ID 去重；WS `ready` 的 `sessionId` 用于绑定音频片段当前会话，不能跨会话补传旧片段。

新增错误码：`STT_NOT_CONFIGURED`、`STT_BUSY`、`INVALID_CLIP`、`INVALID_CLIP_TIME`、`CAPTION_NOT_ALLOWED`、`INVALID_AUDIO`、`AUDIO_TOO_LARGE`、`STT_FAILED`、`CAPTION_SESSION_ENDED`、`DEEPSEEK_NOT_CONFIGURED`、`MINUTES_BUSY`、`NO_MINUTES_SOURCE`、`MINUTES_SOURCE_LIMIT`、`DEEPSEEK_FAILED`、`EXPORT_TOO_LARGE`。失败不保存无效字幕、不覆盖旧纪要，上游错误正文不会透传。

虚拟背景完全在浏览器中执行，不新增视频上传接口。详细配置与限制见 `docs/挑战档.md`。

---

## 进阶档新增接口

以下接口均要求 Bearer JWT，普通用户 API 每分钟最多 180 次。录制上传允许较长读超时，其余请求保持短超时。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/meetings/{id}/media-token` | 需已在线且未被移出；返回 `{mode:"p2p"}` 或 `{mode:"livekit",url,token}` |
| POST | `/api/meetings/{id}/moderation` | 主持人专用，`{target:用户ID,action:"mute"/"allow-mic"/"remove"}` |
| GET | `/api/meetings/{id}/history` | 已加入用户可读取 `{meeting,participants,recordings}` |
| POST | `/api/meetings/{id}/recordings?duration=秒数` | 主持人上传二进制 WebM，Content-Type `video/webm`，最大 96 MiB；已结束会议仍可保存最终片段 |
| GET | `/api/recordings/{recordingId}` | 参会者鉴权读取私有 WebM，支持 Range |

新增错误码：`REMOVED`（本场已移出）、`ROOM_NOT_READY`（信令未建立）、`MEDIA_CONTROL_FAILED`（业务限制已保存，媒体端同步失败，应重试）、`INVALID_ACTION`、`INVALID_TARGET`、`INVALID_DURATION`、`INVALID_RECORDING`、`RECORDING_TOO_LARGE`。

`members` 快照新增 `screen`、`mutedByHost`、`recording`。客户端 `state` 可上报 `screen` 和 `recording`，服务器仅允许主持人上报录制；被限制的成员上报 `mic:true` 不会覆盖限制。

新增服务端事件：

- `moderation`：`{muted:boolean,removed:boolean}`；客户端同步限制，静音时立即关闭本地音轨。
- `removed`：终止连接并返回工作台，不再自动重连。

`allow-mic` 不会替用户打开麦克风。移出限制跨重连和进程重启保存。媒体 API 出错会返回 503，不伪装成完全成功。会议最长时长由 `MEETING_MAX_MINUTES` 配置，后台每 5 秒结束超时会议；媒体房间删除失败会在本进程重试。

P2P 的 `signal` 可携带 `screenId`；服务端将其作为不透明信令仅转发给同房间目标成员。LiveKit 模式媒体信令由 SDK 直接连接 SFU，业务 WebSocket 继续负责成员、聊天和控制事件。

---

## HTTP 约定

请求和响应使用 JSON。除注册、登录和健康检查外，需要 `Authorization: Bearer <JWT>`。

成功：

```json
{ "data": { "status": "ok" } }
```

失败：

```json
{ "error": { "code": "MEETING_ENDED", "message": "会议已结束" } }
```

| 方法 | 路径 | 请求/用途 |
| --- | --- | --- |
| GET | `/api/health` | 进程存活检查 |
| POST | `/api/auth/register` | `{ "username": "alice", "name": "爱丽丝", "password": "password123" }` |
| POST | `/api/auth/login` | `{ "username": "alice", "password": "password123" }` |
| GET | `/api/me` | 当前用户 |
| GET | `/api/meetings` | 本人参与的最近 100 场会议 |
| POST | `/api/meetings` | `{ "title": "项目讨论" }`，返回会议；创建者自动获得参会关系 |
| GET | `/api/meetings/{id}` | 会议详情，仅已加入用户 |
| POST | `/api/meetings/{id}/join` | 建立参会关系，重复调用幂等，已结束会议不可加入 |
| POST | `/api/meetings/{id}/leave` | 主动清理当前用户连接；前端正常离会走 WS `leave` |
| POST | `/api/meetings/{id}/end` | 仅主持人，幂等结束并通知全部在线成员 |
| GET | `/api/meetings/{id}/messages` | 最近 100 条，按 ID 正序返回 |
| GET | `/api/meetings/{id}/messages?before=100` | ID 小于 100 的最近 100 条，正序 |
| GET | `/api/meetings/{id}/messages?after=100` | ID 大于 100 的前 100 条，正序；重连补齐可连续翻页 |

`before` 和 `after` 不能同时使用。会议号为 9 位数字。用户名归一化为小写后需符合 `[a-z0-9_]{3,24}`，昵称 1–24 字，密码 8–72 字节，会议主题 1–60 字，消息 1–2000 字。

常见状态码：400 输入错误、401 未登录/过期、403 来源不受信任或无权限、404 会议不存在、409 重名/会议结束、429 请求过快、500 服务错误。注册和登录按直连 IP 每分钟最多 30 次；默认不信任客户端提交的 `X-Forwarded-For`。

## WebSocket

地址：`ws://127.0.0.1:8080/ws?meeting=123456789`。部署 HTTPS 后使用 `wss`。浏览器 Origin 必须在允许列表中。

先调用 REST 创建或加入会议，再建立 WebSocket。握手后 5 秒内发送鉴权首帧，JWT 不放在 URL 中：

```json
{ "type": "auth", "token": "<JWT>", "mic": false, "camera": false }
```

成功后先收到 `ready`，再收到 `members`。`ready.data` 包含会议和本次连接的 `sessionId`。每次成员变化广播完整快照，客户端按会话编号判断是否需要重建 P2P。

客户端事件：

```json
{ "type": "state", "mic": true, "camera": false }
{ "type": "chat", "clientId": "<uuid>", "content": "大家好" }
{ "type": "signal", "target": 2, "signal": { "description": { "type": "offer", "sdp": "..." } } }
{ "type": "signal", "target": 2, "signal": { "candidate": {} } }
{ "type": "leave" }
```

服务端事件都使用 `{ "type": "...", "data": ... }`：

| type | data / 含义 |
| --- | --- |
| `ready` | `{ meeting, sessionId }`，房间已就绪 |
| `members` | `[{ id, name, host, mic, camera, sessionId }]` |
| `chat` | `{ id, meetingId, userId, name, content, clientId, createdAt }` |
| `signal` | `{ from, sessionId, signal }`，仅转发给同房间目标成员 |
| `error` | `{ code, message }`，可恢复的输入/存储错误 |
| `unauthorized` | JWT 无效或已过期，需要重新登录 |
| `unavailable` | 没有参会关系、会议结束或服务正在关闭 |
| `replaced` | 同账号的新连接替代当前连接，停止重连 |
| `left` | REST 离会确认，停止重连 |
| `ended` | 主持人结束会议，停止重连 |

时间使用 UTC RFC3339，客户端按本地时区显示。昵称和发送者编号以服务端鉴权结果为准，客户端不能伪造。`(meeting_id, user_id, client_id)` 唯一约束保证重发不重复落库。

每个连接只有一个写协程，写超时 5 秒；发送队列容量 128，慢客户端会断开并由前端重连。每 25 秒发送 Ping，60 秒没有 Pong 会清理连接。帧大小上限 16 KiB，聊天每个连接最短发送间隔 200 毫秒。JWT 到期后服务端主动通知并关闭连接。
