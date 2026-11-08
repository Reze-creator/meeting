import { useEffect, useRef, useState } from 'react'
import { errorText, formatCode, post } from '../api'
import { ChatPanel } from '../components/ChatPanel'
import { Icon } from '../components/Icon'
import { Video } from '../components/Video'
import type { MediaController } from '../hooks/useMedia'
import { usePeers } from '../hooks/usePeers'
import { useRoom } from '../hooks/useRoom'
import type { Meeting, User } from '../types'
import { DeviceControls } from './MeetingSession'

export function RoomPage({
  user,
  meeting,
  media,
  onExit,
}: {
  user: User
  meeting: Meeting
  media: MediaController
  onExit: (message: string) => void
}) {
  const sendRef = useRef<(payload: unknown) => boolean>(() => false)
  const peers = usePeers(media.stream, user.id, (target, signal) => {
    sendRef.current({ type: 'signal', target, signal })
  })
  const room = useRoom({
    meeting,
    mic: media.mic,
    camera: media.camera,
    onSignal: peers.receive,
    onMembers: peers.syncMembers,
    onDisconnect: peers.reset,
    onExit,
  })
  useEffect(() => {
    sendRef.current = room.send
  }, [room.send])
  const [panel, setPanel] = useState<'chat' | 'members'>('chat')
  const [showSettings, setShowSettings] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [started] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [started])
  function leave() {
    // 即使离会请求失败，也立即释放本地设备；服务端会通过断线事件清理成员。
    room.send({ type: 'leave' })
    media.stop()
    onExit('你已离开会议。')
  }
  async function end() {
    setBusy(true)
    try {
      await post(`/meetings/${meeting.id}/end`)
      onExit('会议已结束。')
    } catch (error) {
      room.setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(meeting.id)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      room.setError(`请手动复制会议号：${meeting.id}`)
    }
  }
  const members = [...room.members].sort(
    (a, b) =>
      Number(b.id === user.id) - Number(a.id === user.id) ||
      Number(b.host) - Number(a.host) ||
      a.id - b.id,
  )
  const tiles = members.length
    ? members
    : [
        {
          id: user.id,
          name: user.name,
          host: meeting.hostId === user.id,
          mic: media.mic,
          camera: media.camera,
          sessionId: 'local',
        },
      ]
  return (
    <div className="room-page">
      <header className="room-header">
        <span className="brand-symbol">C</span>
        <div className="room-title">
          <h1>{meeting.title}</h1>
          <button onClick={() => void copy()} title="复制会议号">
            会议号 {formatCode(meeting.id)}
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
        </div>
        <div
          className={`connection-badge ${room.status === 'online' ? '' : 'offline'}`}
          role="status"
        >
          <span className="live-dot" />
          {room.status === 'online'
            ? '连接正常'
            : room.status === 'connecting'
              ? '正在连接…'
              : '断线重连中…'}
        </div>
        <time className="elapsed">
          {String(Math.floor(elapsed / 3600)).padStart(2, '0')}:
          {String(Math.floor(elapsed / 60) % 60).padStart(2, '0')}:
          {String(elapsed % 60).padStart(2, '0')}
        </time>
      </header>
      {(room.error || media.error) && (
        <div className="room-alert" role="alert">
          {room.error || media.error}
          <button aria-label="关闭提示" onClick={() => room.setError('')}>
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {room.status === 'reconnecting' && (
        <div className="reconnect-banner" role="status">
          连接暂时中断，正在自动重连。成员列表将在恢复后同步，聊天记录会自动补齐。
        </div>
      )}
      {peers.failures.length > 0 && (
        <div className="reconnect-banner">
          部分成员的媒体连接失败。可尝试重新入会；跨网络连接可能需要配置 TURN 中继。
        </div>
      )}
      <main className="room-main">
        <section className={`video-grid count-${Math.min(tiles.length, 4)}`} aria-label="会议画面">
          {tiles.map((member) => {
            const self = member.id === user.id
            const stream = self ? media.stream : peers.streams[member.id]
            return (
              <article className={`video-tile ${member.camera ? 'camera-on' : ''}`} key={member.id}>
                <Video stream={stream} muted={self} mirror={self} />
                {(!member.camera || !stream) && (
                  <div className="tile-placeholder">
                    <span className={`participant-avatar color-${member.id % 4}`}>
                      {member.name.slice(0, 1)}
                    </span>
                    <p>
                      {member.name}
                      {self && '（我）'}
                    </p>
                    <small>{member.camera ? '正在连接视频…' : '摄像头已关闭'}</small>
                  </div>
                )}
                <div className="tile-label">
                  <span>
                    {member.name}
                    {self && '（我）'}
                  </span>
                  {member.host && <span className="room-host">主持人</span>}
                  <Icon name="mic" off={!member.mic} size={15} />
                </div>
              </article>
            )
          })}
        </section>
        <aside className="room-side">
          <div className="room-side-tabs">
            <button className={panel === 'chat' ? 'active' : ''} onClick={() => setPanel('chat')}>
              <Icon name="chat" size={17} />
              聊天
            </button>
            <button
              className={panel === 'members' ? 'active' : ''}
              onClick={() => setPanel('members')}
            >
              <Icon name="users" size={17} />
              成员 {room.members.length}
            </button>
          </div>
          <div className={panel === 'chat' ? 'panel-body' : 'panel-hidden'}>
            <ChatPanel
              user={user}
              messages={room.messages}
              online={room.status === 'online'}
              send={room.send}
              hasOlder={room.hasOlder}
              loadOlder={room.loadOlder}
              loadingOlder={room.loadingOlder}
            />
          </div>
          {panel === 'members' && (
            <div className="member-list">
              <p>会议成员 · {room.members.length} 人</p>
              {members.map((member) => (
                <div className="member-row" key={member.id}>
                  <span className={`avatar color-${member.id % 4}`}>{member.name.slice(0, 1)}</span>
                  <div>
                    <strong>
                      {member.name}
                      {member.id === user.id && '（我）'}
                    </strong>
                    <small>{member.host ? '主持人' : '参会成员'}</small>
                  </div>
                  <Icon name="mic" size={16} off={!member.mic} />
                  <Icon name="video" size={16} off={!member.camera} />
                </div>
              ))}
            </div>
          )}
        </aside>
      </main>
      <footer className="room-toolbar">
        <div className="toolbar-devices">
          <button
            className={`toolbar-button ${!media.mic ? 'off' : ''}`}
            disabled={media.busy}
            onClick={() => void media.toggle('audio')}
          >
            <Icon name="mic" off={!media.mic} size={23} />
            <span>{media.mic ? '静音' : '取消静音'}</span>
          </button>
          <button
            className={`toolbar-button ${!media.camera ? 'off' : ''}`}
            disabled={media.busy}
            onClick={() => void media.toggle('video')}
          >
            <Icon name="video" off={!media.camera} size={23} />
            <span>{media.camera ? '关闭摄像头' : '开启摄像头'}</span>
          </button>
          <button className="toolbar-button" onClick={() => setShowSettings(true)}>
            <Icon name="settings" size={23} />
            <span>设备设置</span>
          </button>
        </div>
        <div className="toolbar-middle">
          <button className="toolbar-button" onClick={() => setPanel('members')}>
            <Icon name="users" size={23} />
            <span>成员（{room.members.length}）</span>
          </button>
          <button className="toolbar-button" onClick={() => setPanel('chat')}>
            <Icon name="chat" size={23} />
            <span>聊天</span>
          </button>
          <button
            className="toolbar-button"
            onClick={() =>
              void Promise.allSettled(
                [...document.querySelectorAll('video')].map((video) => video.play()),
              )
            }
          >
            <Icon name="check" size={23} />
            <span>启用声音播放</span>
          </button>
        </div>
        <div className="leave-actions">
          <button className="button leave" onClick={() => void leave()}>
            离开会议
          </button>
          {meeting.hostId === user.id && (
            <button className="button danger" onClick={() => setConfirmEnd(true)}>
              结束会议
            </button>
          )}
        </div>
      </footer>
      {showSettings && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="close-button"
              aria-label="关闭设备设置"
              onClick={() => setShowSettings(false)}
              autoFocus
            >
              <Icon name="close" />
            </button>
            <h2 id="settings-title">设备设置</h2>
            <p className="muted">设备状态会实时同步给其他成员。</p>
            <DeviceControls media={media} />
            {media.error && (
              <div className="error" role="alert">
                {media.error}
              </div>
            )}
          </section>
        </div>
      )}
      {confirmEnd && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="end-title">
            <h2 id="end-title">结束所有人的会议？</h2>
            <p className="muted">所有参会者将离开，会议无法再次加入。聊天记录仍会保存。</p>
            <div className="modal-actions">
              <button className="button subtle" onClick={() => setConfirmEnd(false)} autoFocus>
                继续会议
              </button>
              <button className="button danger" onClick={() => void end()} disabled={busy}>
                {busy ? '正在结束…' : '确认结束'}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
