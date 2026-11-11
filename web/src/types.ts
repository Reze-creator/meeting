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
  screen?: boolean
  mutedByHost?: boolean
  recording?: boolean
  captioning?: boolean
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

export interface Recording {
  id: string
  meetingId: string
  userId: number
  size: number
  duration: number
  createdAt: string
}
export interface MeetingHistory {
  meeting: Meeting
  participants: { id: number; name: string; joinedAt: string; leftAt: string | null }[]
  recordings: Recording[]
}
export interface Caption {
  id: number
  meetingId: string
  userId: number
  name: string
  clientId: string
  text: string
  startedAt: string
  duration: number
  createdAt: string
}
export interface MinutesContent {
  overview: string
  decisions: string[]
  actions: { task: string; owner: string; due: string }[]
  risks: string[]
}
export interface MinutesResult {
  minutes: { content: MinutesContent; model: string; sourceHash: string; createdAt: string } | null
  stale: boolean
}
export interface IntelligenceStatus {
  captions: boolean
  minutes: boolean
  minutesModel: string
}
