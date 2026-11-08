import { useEffect, useRef, useState } from 'react'
import { formatTime } from '../api'
import type { Message, User } from '../types'
import { Icon } from './Icon'

interface PendingMessage {
  clientId: string
  content: string
  sentAt: number
}
interface Props {
  user: User
  messages: Message[]
  online: boolean
  send: (payload: unknown) => boolean
  hasOlder: boolean
  loadOlder: () => Promise<void>
  loadingOlder: boolean
}

export function ChatPanel({
  user,
  messages,
  online,
  send,
  hasOlder,
  loadOlder,
  loadingOlder,
}: Props) {
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<PendingMessage[]>([])
  const [now, setNow] = useState(() => Date.now())
  const bottom = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (nearBottom.current) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, pending])
  const isAcknowledged = (item: PendingMessage) =>
    messages.some((message) => message.userId === user.id && message.clientId === item.clientId)
  function submit() {
    const content = draft.trim()
    if (!content || !online) return
    const clientId = crypto.randomUUID()
    if (!send({ type: 'chat', content, clientId })) return
    // 重试复用 clientId，服务端据此去重；清理已经确认的待发送消息。
    setPending((old) => [
      ...old.filter((item) => !isAcknowledged(item)),
      { content, clientId, sentAt: Date.now() },
    ])
    setDraft('')
    nearBottom.current = true
  }
  function retry(item: PendingMessage) {
    if (send({ type: 'chat', content: item.content, clientId: item.clientId }))
      setPending((old) =>
        old.map((value) =>
          value.clientId === item.clientId ? { ...value, sentAt: Date.now() } : value,
        ),
      )
  }
  return (
    <div className="chat-panel">
      <div
        className="chat-messages"
        ref={list}
        onScroll={() => {
          const element = list.current
          if (element)
            nearBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 100
        }}
      >
        {hasOlder && (
          <button
            className="text-button load-older"
            onClick={() => void loadOlder()}
            disabled={loadingOlder}
          >
            {loadingOlder ? '加载中…' : '加载更早的消息'}
          </button>
        )}
        <p className="chat-start">对话从这里开始，消息自动保存。</p>
        {messages.map((message) => (
          <div
            className={`chat-message ${message.userId === user.id ? 'own' : ''}`}
            key={message.id}
          >
            <div className="message-meta">
              <strong>
                {message.name}
                {message.userId === user.id && '（我）'}
              </strong>
              <time>{formatTime(message.createdAt)}</time>
            </div>
            <p>{message.content}</p>
          </div>
        ))}
        {pending
          .filter((item) => !isAcknowledged(item))
          .map((item) => (
            <div className="chat-message own pending" key={item.clientId}>
              <div className="message-meta">
                <strong>我</strong>
                <span>{now - item.sentAt < 8000 ? '发送中…' : '未收到确认'}</span>
              </div>
              <p>{item.content}</p>
              {now - item.sentAt >= 8000 && (
                <button className="text-button" onClick={() => retry(item)} disabled={!online}>
                  重试发送
                </button>
              )}
            </div>
          ))}
        <div ref={bottom} />
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          aria-label="聊天消息"
          placeholder={online ? '发送消息给所有人…' : '连接恢复后可继续发送'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={2000}
          disabled={!online}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div>
          <small>Enter 发送 · Shift + Enter 换行</small>
          <button aria-label="发送消息" disabled={!online || !draft.trim()}>
            <Icon name="send" size={17} />
          </button>
        </div>
      </form>
    </div>
  )
}
