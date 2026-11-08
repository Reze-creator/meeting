import { useCallback, useEffect, useRef, useState } from 'react'
import { api, errorText, session } from '../api'
import type { ConnectionState, Meeting, Member, Message } from '../types'
import type { Signal } from './usePeers'

interface RoomOptions {
  meeting: Meeting
  mic: boolean
  camera: boolean
  onSignal: (from: number, sessionId: string, signal: Signal) => void
  onMembers: (members: Member[]) => void
  onDisconnect: () => void
  onExit: (message: string) => void
}
export function mergeMessages(current: Message[], incoming: Message[]) {
  return [
    ...new Map([...current, ...incoming].map((message) => [message.id, message])).values(),
  ].sort((a, b) => a.id - b.id)
}

/** 管理信令生命周期、指数退避重连，以及从持久化历史补齐聊天消息。 */
export function useRoom(options: RoomOptions) {
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  }, [options])
  const socket = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<ConnectionState>('connecting')
  const [members, setMembers] = useState<Member[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState('')
  const [hasOlder, setHasOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const lastID = useRef(0)
  const historyLoaded = useRef(false)
  const send = useCallback((payload: unknown) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false
    socket.current.send(JSON.stringify(payload))
    return true
  }, [])

  useEffect(() => {
    let disposed = false
    let terminal = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const abort = new AbortController()
    const id = options.meeting.id
    const exit = (message: string) => {
      terminal = true
      latest.current.onExit(message)
    }
    async function repairHistory() {
      try {
        let cursor = lastID.current
        if (!historyLoaded.current) {
          const history = await api<Message[]>(`/meetings/${id}/messages`, { signal: abort.signal })
          if (disposed) return
          setMessages((old) => mergeMessages(old, history))
          setHasOlder(history.length === 100)
          historyLoaded.current = true
          lastID.current = Math.max(lastID.current, ...history.map((message) => message.id), 0)
          return
        }
        while (!disposed) {
          const page = await api<Message[]>(`/meetings/${id}/messages?after=${cursor}`, {
            signal: abort.signal,
          })
          if (disposed) return
          setMessages((old) => mergeMessages(old, page))
          cursor = Math.max(cursor, ...page.map((message) => message.id))
          lastID.current = Math.max(lastID.current, cursor)
          if (page.length < 100) return
        }
      } catch (error) {
        if (!disposed) setError(`历史消息加载失败：${errorText(error)}`)
      }
    }
    function connect() {
      if (disposed || terminal) return
      setStatus(attempts ? 'reconnecting' : 'connecting')
      const ws = new WebSocket(
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?meeting=${id}`,
      )
      socket.current = ws
      watchdog = setTimeout(() => ws.close(), 10000)
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            type: 'auth',
            token: session.get(),
            mic: latest.current.mic,
            camera: latest.current.camera,
          }),
        )
      // 回调绑定当前连接，旧连接的关闭事件不能启动第二条重连链。
      ws.onmessage = ({ data }) => {
        if (disposed || terminal || socket.current !== ws) return
        let event: { type: string; data?: unknown }
        try {
          event = JSON.parse(data)
        } catch {
          return
        }
        switch (event.type) {
          case 'ready':
            clearTimeout(watchdog)
            attempts = 0
            setStatus('online')
            setError('')
            void repairHistory()
            break
          case 'members': {
            const members = event.data as Member[]
            setMembers(members)
            latest.current.onMembers(members)
            break
          }
          case 'chat': {
            const message = event.data as Message
            setMessages((old) => mergeMessages(old, [message]))
            lastID.current = Math.max(lastID.current, message.id)
            break
          }
          case 'signal': {
            const data = event.data as { from: number; sessionId: string; signal: Signal }
            latest.current.onSignal(data.from, data.sessionId, data.signal)
            break
          }
          case 'ended':
            exit('主持人已结束会议。')
            break
          case 'left':
            exit('你已离开会议。')
            break
          case 'replaced':
            exit('此账号已在其他标签页加入会议，当前连接已关闭。')
            break
          case 'unavailable':
            exit('会议已结束或无法加入，请返回工作台重试。')
            break
          case 'unauthorized':
            session.clear()
            window.dispatchEvent(new Event('comeet:unauthorized'))
            terminal = true
            break
          case 'error':
            setError((event.data as { message: string }).message)
            break
        }
      }
      ws.onclose = () => {
        if (disposed || terminal || socket.current !== ws) return
        clearTimeout(watchdog)
        latest.current.onDisconnect()
        setMembers([])
        setStatus('reconnecting')
        attempts++
        const delay = Math.min(1000 * 2 ** Math.min(attempts - 1, 4), 15000) + Math.random() * 300
        timer = setTimeout(connect, delay)
      }
      ws.onerror = () => ws.close()
    }
    const reconnectNow = () => {
      if (socket.current?.readyState === WebSocket.OPEN) return
      clearTimeout(timer)
      clearTimeout(watchdog)
      const old = socket.current
      socket.current = null
      old?.close()
      connect()
    }
    window.addEventListener('online', reconnectNow)
    connect()
    return () => {
      disposed = true
      abort.abort()
      clearTimeout(timer)
      clearTimeout(watchdog)
      window.removeEventListener('online', reconnectNow)
      socket.current?.close()
      socket.current = null
    }
  }, [options.meeting.id])
  useEffect(() => {
    if (status === 'online') send({ type: 'state', mic: options.mic, camera: options.camera })
  }, [options.mic, options.camera, status, send])

  const loadOlder = async () => {
    if (!messages.length || loadingOlder) return
    setLoadingOlder(true)
    try {
      const page = await api<Message[]>(
        `/meetings/${options.meeting.id}/messages?before=${messages[0].id}`,
      )
      setMessages((old) => mergeMessages(old, page))
      setHasOlder(page.length === 100)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setLoadingOlder(false)
    }
  }
  return { status, members, messages, error, setError, send, hasOlder, loadOlder, loadingOlder }
}
