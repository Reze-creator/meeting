import { useState } from 'react'
import { errorText, formatCode, post } from '../api'
import { Icon } from '../components/Icon'
import { Video } from '../components/Video'
import { useMedia } from '../hooks/useMedia'
import type { MediaController } from '../hooks/useMedia'
import type { Meeting, User } from '../types'
import { RoomPage } from './RoomPage'

export function DeviceControls({ media }: { media: MediaController }) {
  return (
    <>
      <div className="device-buttons">
        <button
          className={`device-button ${media.mic ? 'enabled' : ''}`}
          onClick={() => void media.toggle('audio')}
          disabled={media.busy}
        >
          <Icon name="mic" off={!media.mic} />
          {media.mic ? '关闭麦克风' : '开启麦克风'}
        </button>
        <button
          className={`device-button ${media.camera ? 'enabled' : ''}`}
          onClick={() => void media.toggle('video')}
          disabled={media.busy}
        >
          <Icon name="video" off={!media.camera} />
          {media.camera ? '关闭摄像头' : '开启摄像头'}
        </button>
      </div>
      <label className="device-select">
        麦克风
        <select
          value={media.deviceId}
          onChange={(event) => void media.selectMicrophone(event.target.value)}
          disabled={media.busy}
        >
          <option value="">系统默认设备</option>
          {media.devices
            .filter((device) => device.kind === 'audioinput' && device.deviceId !== 'default')
            .map((device, index) => (
              <option key={device.deviceId || index} value={device.deviceId}>
                {device.label || `麦克风 ${index + 1}`}
              </option>
            ))}
        </select>
      </label>
    </>
  )
}

export function MeetingSession({
  user,
  meeting,
  onExit,
}: {
  user: User
  meeting: Meeting
  onExit: (message: string) => void
}) {
  const media = useMedia()
  const [joined, setJoined] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  function exit(message: string) {
    media.stop()
    onExit(message)
  }
  async function enter() {
    setBusy(true)
    setError('')
    try {
      await post(`/meetings/${meeting.id}/join`)
      setJoined(true)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  if (joined) return <RoomPage user={user} meeting={meeting} media={media} onExit={exit} />
  return (
    <div className="prepare-page">
      <header className="prepare-header">
        <span className="brand">
          <span className="brand-symbol">C</span>Comeet
        </span>
        <button className="text-button" onClick={() => exit('')}>
          返回工作台
          <Icon name="close" size={18} />
        </button>
      </header>
      <main className="prepare-main">
        <div className="prepare-copy">
          <span className="eyebrow">READY WHEN YOU ARE</span>
          <h1>先准备，再相聚。</h1>
          <p className="muted">确认你的设备，以最好的状态开启对话。</p>
        </div>
        <div className="prepare-layout">
          <div>
            <div className="preview">
              <Video stream={media.stream} muted mirror />
              {!media.camera && (
                <div className="preview-placeholder">
                  <span className="large-avatar">{user.name.slice(0, 1)}</span>
                  <p>摄像头已关闭</p>
                </div>
              )}
              <span className="preview-name">{user.name}（我）</span>
              <span className="preview-badge">本地预览</span>
            </div>
            <DeviceControls media={media} />
            {media.error && (
              <div className="notice" role="alert">
                {media.error}
              </div>
            )}
          </div>
          <section className="prepare-details">
            <span className="action-icon light">
              <Icon name="video" size={28} />
            </span>
            <h2>{meeting.title}</h2>
            <p className="meeting-code">{formatCode(meeting.id)}</p>
            <dl>
              <div>
                <dt>主持人</dt>
                <dd>{meeting.hostName}</dd>
              </div>
              <div>
                <dt>你的昵称</dt>
                <dd>{user.name}</dd>
              </div>
              <div>
                <dt>入会状态</dt>
                <dd>{media.mic ? '麦克风已开启' : '静音入会'}</dd>
              </div>
            </dl>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <button
              className="button primary full"
              onClick={() => void enter()}
              disabled={busy || media.busy}
            >
              {busy ? '正在加入…' : '加入会议'}
              <Icon name="arrow" size={18} />
            </button>
            <p className="prepare-tip">
              <Icon name="shield" size={15} />
              设备默认关闭，你可以随时调整。
            </p>
          </section>
        </div>
      </main>
    </div>
  )
}
