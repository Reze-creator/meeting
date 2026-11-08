export interface User {
  id: number
  username: string
  name: string
}
export interface Meeting {
  id: string
  title: string
  hostId: number
  hostName: string
  createdAt: string
  endedAt: string | null
}
export interface Member {
  id: number
  name: string
  host: boolean
  mic: boolean
  camera: boolean
  // 每次连接使用新会话编号，用于区分重连与同一连接的状态更新。
  sessionId: string
}
export interface Message {
  id: number
  meetingId: string
  userId: number
  name: string
  content: string
  clientId: string
  createdAt: string
}
export interface AuthResult {
  token: string
  user: User
}
export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'closed'
