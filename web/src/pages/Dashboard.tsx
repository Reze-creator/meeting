import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api, errorText, formatCode, formatDate, post } from '../api'
import type { Meeting, User } from '../types'
import { Icon } from '../components/Icon'

export function Dashboard({
  user,
  onEnter,
  onLogout,
  notice,
}: {
  user: User
  onEnter: (meeting: Meeting) => void
  onLogout: () => void
  notice: string
}) {
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const [now, setNow] = useState(() => new Date())
  const [code, setCode] = useState(new URLSearchParams(location.search).get('meeting') ?? '')
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState(`${user.name}的即时会议`)
  const load = useCallback(async () => {
    try {
      setMeetings(await api<Meeting[]>('/meetings'))
      setError('')
    } catch (error) {
      setError(errorText(error))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    queueMicrotask(() => {
      void load()
    })
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [load])
  async function join(id: string) {
    setBusy(true)
    setError('')
    try {
      onEnter(await post<Meeting>(`/meetings/${id.replace(/\D/g, '')}/join`))
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      onEnter(await post<Meeting>('/meetings', { title: title.trim() }))
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  const shown = meetings.filter((meeting) =>
    tab === 'active' ? !meeting.endedAt : !!meeting.endedAt,
  )
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-symbol">C</span>Comeet
        </a>
        <span className="sidebar-caption">我的空间</span>
        <button className="nav-item active">
          <Icon name="home" />
          会议工作台
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <Icon name="shield" />
            <strong>专注每一次对话</strong>
            <p>无需安装，打开浏览器即可相聚。</p>
          </div>
          <button className="profile" onClick={onLogout} title="退出登录">
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <span>
              <strong>{user.name}</strong>
              <small>@{user.username}</small>
            </span>
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>
      <main className="dashboard">
        <header className="dashboard-header">
          <span>
            工作台 <span className="muted">/ 我的会议</span>
          </span>
          <span className="secure-pill">
            <Icon name="shield" size={14} />
            连接，让协作发生
          </span>
        </header>
        <div className="welcome">
          <div>
            <span className="eyebrow">LET’S MAKE THINGS HAPPEN</span>
            <h1>
              {now.getHours() < 12 ? '上午好' : now.getHours() < 18 ? '下午好' : '晚上好'}，
              {user.name}
              <span className="wave">✦</span>
            </h1>
            <p className="muted">新的一场对话，新的无限可能。</p>
          </div>
          <div className="today">
            <Icon name="clock" size={16} />
            {now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}
          </div>
        </div>
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <section className="quick-actions">
          <div className="clock-card">
            <span className="mini-label">此刻，正是好时候</span>
            <div className="clock-time">
              {now.toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
              })}
              <small>{String(now.getSeconds()).padStart(2, '0')}</small>
            </div>
            <span className="muted">
              <span className="live-dot" />
              准备好，开启一场高效会议
            </span>
            <div className="clock-decoration" />
          </div>
          <button className="create-card" onClick={() => setCreating(true)} disabled={busy}>
            <span className="action-icon">
              <Icon name="video" size={28} />
            </span>
            <strong>发起会议</strong>
            <span>即刻开启，让灵感面对面</span>
            <span className="card-arrow">
              <Icon name="arrow" />
            </span>
          </button>
          <form
            className="join-card"
            onSubmit={(event) => {
              event.preventDefault()
              void join(code)
            }}
          >
            <span className="join-heading">
              <span className="action-icon light">
                <Icon name="link" size={25} />
              </span>
              <strong>加入会议</strong>
            </span>
            <span className="muted">输入会议号，与伙伴相聚</span>
            <div className="join-input">
              <input
                aria-label="会议号"
                placeholder="输入 9 位会议号"
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 9))}
                required
                pattern="[0-9]{9}"
              />
              <button aria-label="加入会议" disabled={busy || code.length !== 9}>
                <Icon name="arrow" />
              </button>
            </div>
          </form>
        </section>
        <section className="meetings-section">
          <div className="section-title">
            <h2>
              我的会议<span>{meetings.length}</span>
            </h2>
            <button className="text-button" onClick={() => void load()} disabled={loading}>
              ↻ 刷新列表
            </button>
          </div>
          <div className="list-tabs">
            <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>
              进行中<span>{meetings.filter((meeting) => !meeting.endedAt).length}</span>
            </button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
              已结束<span>{meetings.filter((meeting) => meeting.endedAt).length}</span>
            </button>
          </div>
          {loading ? (
            <div className="empty-state">正在加载会议…</div>
          ) : shown.length ? (
            <div className="meeting-list">
              {shown.map((meeting) => (
                <article className="meeting-row" key={meeting.id}>
                  <span className={`meeting-row-icon ${meeting.endedAt ? 'ended' : ''}`}>
                    <Icon name={meeting.endedAt ? 'clock' : 'video'} size={23} />
                  </span>
                  <div className="meeting-row-info">
                    <h3>
                      {meeting.title}
                      {meeting.hostId === user.id && <span className="host-tag">我主持</span>}
                    </h3>
                    <p>
                      <span>{formatCode(meeting.id)}</span>
                      <span>主持人：{meeting.hostName}</span>
                      <span>{formatDate(meeting.createdAt)}</span>
                    </p>
                  </div>
                  {meeting.endedAt ? (
                    <span className="muted row-status">已结束</span>
                  ) : (
                    <>
                      <span className="online-tag">
                        <span className="live-dot" />
                        可加入
                      </span>
                      <button
                        className="button subtle"
                        disabled={busy}
                        onClick={() => void join(meeting.id)}
                      >
                        加入会议
                        <Icon name="arrow" size={16} />
                      </button>
                    </>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <Icon name={tab === 'active' ? 'video' : 'clock'} size={34} />
              </div>
              <h3>{tab === 'active' ? '好对话，从一场会议开始' : '还没有已结束的会议'}</h3>
              <p>
                {tab === 'active'
                  ? '发起新会议，或输入会议号加入伙伴。'
                  : '主持人结束会议后，会议会保留在这里。'}
              </p>
              {tab === 'active' && (
                <button className="text-button" onClick={() => setCreating(true)}>
                  创建第一场会议 <Icon name="arrow" size={16} />
                </button>
              )}
            </div>
          )}
        </section>
        <footer className="dashboard-footer">
          <span>Comeet · 让沟通自然发生</span>
          <span>简单连接，共同创造。</span>
        </footer>
      </main>
      {creating && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
            <button className="close-button" aria-label="关闭" onClick={() => setCreating(false)}>
              <Icon name="close" />
            </button>
            <span className="action-icon light">
              <Icon name="video" size={26} />
            </span>
            <h2 id="create-title">开启一场新会议</h2>
            <p className="muted">给这次相聚取个名字。</p>
            <form onSubmit={create}>
              <label>
                会议主题
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={60}
                  required
                  autoFocus
                />
              </label>
              {error && (
                <div className="error" role="alert">
                  {error}
                </div>
              )}
              <button className="button primary full" disabled={busy || !title.trim()}>
                {busy ? '创建中…' : '创建并准备入会'}
                <Icon name="arrow" size={18} />
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
