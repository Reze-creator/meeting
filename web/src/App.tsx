import { useEffect, useState } from 'react'
import { api, session } from './api'
import type { AuthResult, Meeting, User } from './types'
import { AuthPage } from './pages/AuthPage'
import { Dashboard } from './pages/Dashboard'
import { MeetingSession } from './pages/MeetingSession'
import './App.css'
import './advanced.css'
import './challenge.css'

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(() => !!session.get())
  const [meeting, setMeeting] = useState<Meeting | null>(null)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    let alive = true
    if (session.get()) {
      void api<User>('/me')
        .then((user) => {
          if (alive) setUser(user)
        })
        .catch(() => {
          session.clear()
        })
        .finally(() => {
          if (alive) setLoading(false)
        })
    }
    const expired = () => {
      setUser(null)
      setMeeting(null)
      setNotice('登录已过期，请重新登录。')
    }
    window.addEventListener('comeet:unauthorized', expired)
    return () => {
      alive = false
      window.removeEventListener('comeet:unauthorized', expired)
    }
  }, [])
  function login(result: AuthResult) {
    session.set(result.token)
    setUser(result.user)
    setNotice('')
  }
  function logout() {
    session.clear()
    setUser(null)
    setMeeting(null)
  }
  if (loading)
    return (
      <div className="loading-screen">
        <span className="brand-symbol">C</span>
        <p>正在连接 Comeet…</p>
      </div>
    )
  if (!user) return <AuthPage onLogin={login} notice={notice} />
  if (meeting)
    return (
      <MeetingSession
        user={user}
        meeting={meeting}
        onExit={(message) => {
          setMeeting(null)
          setNotice(message)
        }}
      />
    )
  return <Dashboard user={user} notice={notice} onEnter={setMeeting} onLogout={logout} />
}
