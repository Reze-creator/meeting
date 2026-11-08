import { useState } from 'react'
import type { FormEvent } from 'react'
import { errorText, post } from '../api'
import type { AuthResult } from '../types'
import { Icon } from '../components/Icon'

export function AuthPage({
  onLogin,
  notice,
}: {
  onLogin: (auth: AuthResult) => void
  notice: string
}) {
  const [register, setRegister] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      onLogin(
        await post<AuthResult>(`/auth/${register ? 'register' : 'login'}`, {
          username: data.get('username'),
          password: data.get('password'),
          ...(register ? { name: data.get('name') } : {}),
        }),
      )
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <a href="/" className="brand">
          <span className="brand-symbol">C</span>Comeet<span className="brand-dot">●</span>
        </a>
        <div className="story-copy">
          <span className="eyebrow">BETTER TOGETHER</span>
          <h1>
            让每一次连接，
            <br />
            都更有价值。
          </h1>
          <p>
            从一个想法，到一次共识。
            <br />
            打开浏览器，让好想法即刻相遇。
          </p>
        </div>
        <div className="meeting-illustration" aria-hidden="true">
          <div className="illustration-top">
            <span className="live-dot" />
            团队灵感时刻<span>•••</span>
          </div>
          <div className="illustration-grid">
            <div>
              <span className="illustration-avatar peach">林</span>
              <small>林小满</small>
            </div>
            <div>
              <span className="illustration-avatar blue">周</span>
              <small>周知行</small>
            </div>
            <div>
              <span className="illustration-avatar purple">你</span>
              <small>正在分享好想法</small>
            </div>
          </div>
          <div className="illustration-bottom">
            <Icon name="mic" />
            <Icon name="video" />
            <Icon name="chat" />
            <span>保持连接，灵感不设限</span>
          </div>
        </div>
        <div className="story-footer">
          <Icon name="shield" size={16} />
          轻量入会 · 实时协作 · 专注沟通
        </div>
      </div>
      <main className="auth-main">
        <div className="auth-box">
          <span className="mini-label">YOUR NEXT CONVERSATION STARTS HERE</span>
          <h2>{register ? '创建你的账号' : '欢迎回来'}</h2>
          <p className="muted">
            {register ? '只需几步，开启你的第一场会议。' : '登录 Comeet，开始今天的精彩对话。'}
          </p>
          <div className="auth-tabs">
            <button
              className={!register ? 'active' : ''}
              onClick={() => {
                setRegister(false)
                setError('')
              }}
            >
              登录
            </button>
            <button
              className={register ? 'active' : ''}
              onClick={() => {
                setRegister(true)
                setError('')
              }}
            >
              注册账号
            </button>
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
          <form onSubmit={submit} key={String(register)}>
            <label>
              账号
              <input
                name="username"
                placeholder="3–24 位字母、数字或下划线"
                autoComplete="username"
                pattern="[A-Za-z0-9_]{3,24}"
                maxLength={24}
                required
                autoFocus
              />
            </label>
            {register && (
              <label>
                昵称
                <input
                  name="name"
                  placeholder="希望大家如何称呼你"
                  autoComplete="nickname"
                  maxLength={24}
                  required
                />
              </label>
            )}
            <label>
              密码
              <input
                name="password"
                type="password"
                placeholder={register ? '至少 8 位，最多 72 字节' : '请输入密码'}
                autoComplete={register ? 'new-password' : 'current-password'}
                minLength={register ? 8 : 1}
                maxLength={72}
                required
              />
            </label>
            <button className="button primary full" disabled={busy}>
              {busy ? '请稍候…' : register ? '注册并登录' : '登录 Comeet'}
              <Icon name="arrow" size={18} />
            </button>
          </form>
          <div className="auth-hint">
            <Icon name="shield" size={16} />
            <span>密码经加密存储，让每一次连接安心发生。</span>
          </div>
        </div>
        <footer>Comeet · 把距离留给地图，把交流带到眼前。</footer>
      </main>
    </div>
  )
}
