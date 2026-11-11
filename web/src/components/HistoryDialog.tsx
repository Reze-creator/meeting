import { useEffect, useRef, useState } from 'react'
import { api, errorText, formatDate, formatTime, session } from '../api'
import type { Meeting, MeetingHistory, Message } from '../types'
import { Icon } from './Icon'
import { MinutesPanel } from './MinutesPanel'

export function HistoryDialog({
  meeting,
  userId,
  onClose,
}: {
  meeting: Meeting
  userId: number
  onClose: () => void
}) {
  const [history, setHistory] = useState<MeetingHistory>()
  const [messages, setMessages] = useState<Message[]>([])
  const [error, setError] = useState('')
  const [video, setVideo] = useState('')
  const [loading, setLoading] = useState(false)
  const [hasOlder, setHasOlder] = useState(false)
  const [fetchingOlder, setFetchingOlder] = useState(false)
  const url = useRef('')
  const abort = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    abort.current = controller
    void Promise.all([
      api<MeetingHistory>(`/meetings/${meeting.id}/history`, { signal: controller.signal }),
      api<Message[]>(`/meetings/${meeting.id}/messages`, { signal: controller.signal }),
    ])
      .then(([detail, chat]) => {
        setHistory(detail)
        setMessages(chat)
        setHasOlder(chat.length === 100)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error))
      })
    return () => {
      controller.abort()
      if (url.current) URL.revokeObjectURL(url.current)
    }
  }, [meeting.id])
  async function play(id: string) {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/recordings/${id}`, {
        headers: { Authorization: `Bearer ${session.get()}` },
        signal: AbortSignal.any([abort.current!.signal, AbortSignal.timeout(120000)]),
      })
      if (!response.ok) throw new Error('无法读取回放，请重新登录后重试。')
      const blob = await response.blob()
      if (abort.current?.signal.aborted) return
      if (url.current) URL.revokeObjectURL(url.current)
      url.current = URL.createObjectURL(blob)
      setVideo(url.current)
    } catch (error) {
      if (!abort.current?.signal.aborted) setError(errorText(error))
    } finally {
      setLoading(false)
    }
  }
  async function older() {
    setFetchingOlder(true)
    try {
      const page = await api<Message[]>(
        `/meetings/${meeting.id}/messages?before=${messages[0].id}`,
        { signal: abort.current!.signal },
      )
      setMessages((old) => [...page, ...old])
      setHasOlder(page.length === 100)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setFetchingOlder(false)
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
      >
        <button className="close-button" aria-label="关闭会议记录" onClick={onClose} autoFocus>
          <Icon name="close" />
        </button>
        <h2 id="history-title">{meeting.title}</h2>
        <p className="muted">
          会议号 {meeting.id} · {formatDate(meeting.createdAt)}
          {meeting.endedAt && ` — ${formatDate(meeting.endedAt)}`}
        </p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {!history ? (
          <p>正在加载记录…</p>
        ) : (
          <>
            <h3>参会者（{history.participants.length}）</h3>
            <div className="history-participants">
              {history.participants.map((person) => (
                <span key={person.id}>
                  {person.name} · {formatTime(person.joinedAt)} 加入
                  {person.leftAt ? ` / ${formatTime(person.leftAt)} 离开` : ' / 在线'}
                </span>
              ))}
            </div>
            <h3>会议回放</h3>
            {history.recordings.length ? (
              history.recordings.map((recording) => (
                <div className="recording-row" key={recording.id}>
                  <span>
                    {formatDate(recording.createdAt)} · {Math.round(recording.duration)} 秒 ·{' '}
                    {(recording.size / 1048576).toFixed(1)} MB
                  </span>
                  <button
                    className="button subtle"
                    disabled={loading}
                    onClick={() => void play(recording.id)}
                  >
                    {loading ? '读取中…' : '播放回放'}
                  </button>
                </div>
              ))
            ) : (
              <p className="muted">本场会议没有保存录制。主持人可在会中开始录制。</p>
            )}
            {video && <video src={video} controls autoPlay playsInline className="history-video" />}
            <MinutesPanel meetingId={meeting.id} host={meeting.hostId === userId} />
            <h3>聊天记录</h3>
            {hasOlder && (
              <button className="text-button" disabled={fetchingOlder} onClick={() => void older()}>
                加载更早的消息
              </button>
            )}
            <div className="history-chat">
              {messages.length ? (
                messages.map((message) => (
                  <p key={message.id}>
                    <strong>{message.name}</strong>
                    <time>{formatTime(message.createdAt)}</time>
                    <span>{message.content}</span>
                  </p>
                ))
              ) : (
                <p className="muted">没有聊天消息。</p>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}
