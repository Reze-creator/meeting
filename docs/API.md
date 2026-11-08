# HTTP 与 WebSocket 协议

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
