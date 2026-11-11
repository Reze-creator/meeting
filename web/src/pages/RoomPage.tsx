import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { errorText, formatCode, post } from '../api'
import { ChatPanel } from '../components/ChatPanel'
import { Icon } from '../components/Icon'
import { Video } from '../components/Video'
import type { MediaController } from '../hooks/useMedia'
import { useConference } from '../hooks/useConference'
import type { Signal } from '../hooks/usePeers'
import { useRoom } from '../hooks/useRoom'
import { useScreenShare } from '../hooks/useScreenShare'
import { useRecording } from '../hooks/useRecording'
import { useCaptions } from '../hooks/useCaptions'
import { LiveCaptions } from '../components/LiveCaptions'
import { MinutesPanel } from '../components/MinutesPanel'
import type { Caption } from '../types'
import type { RecordingSource } from '../hooks/useRecording'
import type { Meeting, User } from '../types'
import { DeviceControls } from './MeetingSession'

type Layout = 'grid' | 'speaker' | 'share'
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
  const share = useScreenShare()
  const sources = useRef<RecordingSource[]>([])
  const getSources = useCallback(() => sources.current, [])
  const recorder = useRecording(meeting.id, getSources)
  const receiveRef = useRef<(from: number, id: string, signal: Signal) => void>(() => {})
  const resetRef = useRef<() => void>(() => {})
  const exiting = useRef(false)
  const [pendingExit, setPendingExit] = useState('')
  const [busy, setBusy] = useState(false)
  const [mutedByHost, setMutedByHost] = useState(false)
  const [layout, setLayout] = useState<Layout>('grid')
  const [pinned, setPinned] = useState<number>()
  const [panel, setPanel] = useState<'chat' | 'members'>('chat')
  const [settings, setSettings] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<number>()
  const [copied, setCopied] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [started] = useState(() => Date.now())
  const [mediaGeneration, setMediaGeneration] = useState(0)
  const [unread, setUnread] = useState(0)
  const [captionEnabled, setCaptionEnabled] = useState(false)
  const [showMinutes, setShowMinutes] = useState(false)
  const captionReceiver = useRef<(caption: Caption) => void>(() => {})
  const seen = useRef(new Set<number>())

  async function finish(message: string) {
    if (exiting.current) return
    exiting.current = true
    setBusy(true)
    const saved = await recorder.stop()
    media.stop()
    share.stop()
    if (saved) onExit(message)
    else {
      setPendingExit(message)
      setBusy(false)
    }
  }
  const room = useRoom({
    meeting,
    mic: media.mic,
    camera: media.camera,
    screen: !!share.stream,
    recording: recorder.active,
    captioning: captionEnabled,
    onCaption: (caption) => captionReceiver.current(caption),
    onSignal: (from, id, signal) => receiveRef.current(from, id, signal),
    onMembers: (members) => {
      const own = members.find((member) => member.id === user.id)
      if (own) {
        setMutedByHost(!!own.mutedByHost)
        if (own.mutedByHost) media.mute()
      }
    },
    onDisconnect: () => resetRef.current(),
    onModeration: (muted) => {
      setMutedByHost(muted)
      if (muted) media.mute()
    },
    onExit: (message) => {
      void finish(message)
    },
  })
  const self = room.members.find((member) => member.id === user.id)
  const locked = mutedByHost || !!self?.mutedByHost
  const captions = useCaptions({
    meetingId: meeting.id,
    sessionId: room.sessionId,
    online: room.status === 'online' && !pendingExit,
    mic: media.mic && !locked,
    stream: media.rawStream,
    enabled: captionEnabled,
  })
  useEffect(() => {
    captionReceiver.current = captions.receive
  }, [captions.receive])
  const mute = media.mute
  const conference = useConference({
    meetingId: meeting.id,
    userId: user.id,
    online: room.status === 'online' && !pendingExit,
    members: room.members,
    stream: media.stream,
    screen: share.stream,
    muted: locked,
    mic: media.mic,
    camera: media.camera,
    send: room.send,
    layout,
    focusedId: pinned,
    generation: mediaGeneration,
  })
  useEffect(() => {
    receiveRef.current = conference.receive
    resetRef.current = conference.reset
  }, [conference.receive, conference.reset])
  useEffect(() => {
    if (self?.mutedByHost && media.mic) mute()
  }, [self?.mutedByHost, media.mic, mute])
  useEffect(() => {
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [started])
  useEffect(() => {
    const fresh = room.messages.filter(
      (message) => !seen.current.has(message.id) && message.userId !== user.id,
    )
    room.messages.forEach((message) => seen.current.add(message.id))
    if (panel !== 'chat' && fresh.length) setUnread((old) => old + fresh.length)
  }, [room.messages, user.id, panel])
  const members = useMemo(
    () =>
      [...room.members].sort(
        (a, b) => Number(b.id === user.id) - Number(a.id === user.id) || a.id - b.id,
      ),
    [room.members, user.id],
  )
  const tiles = useMemo(
    () =>
      members.length
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
          ],
    [members, user.id, user.name, meeting.hostId, media.mic, media.camera],
  )
  const shared = useMemo(() => members.filter((member) => member.screen), [members])
  const screenOwner = shared.find((member) => member.id === pinned) ?? shared[0]
  const screenStream =
    screenOwner?.id === user.id
      ? share.stream
      : screenOwner
        ? conference.screens[screenOwner.id]
        : undefined
  const focus = pinned ?? conference.speaker ?? members.find((member) => member.host)?.id ?? user.id
  useEffect(() => {
    sources.current = tiles.map((member) => ({
      id: member.id,
      name: member.name,
      stream: member.id === user.id ? media.stream : conference.streams[member.id],
    }))
    for (const member of shared) {
      const stream = member.id === user.id ? share.stream : conference.screens[member.id]
      if (stream) sources.current.push({ id: -member.id, name: `${member.name}的屏幕`, stream })
    }
  }, [tiles, shared, media.stream, share.stream, conference.streams, conference.screens, user.id])

  function leave() {
    room.send({ type: 'leave' })
    void finish('你已离开会议。')
  }
  async function end() {
    setBusy(true)
    try {
      const saved = await recorder.stop()
      if (!saved) {
        setConfirmEnd(false)
        return
      }
      await post(`/meetings/${meeting.id}/end`)
      void finish('会议已结束。')
    } catch (error) {
      room.setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function moderate(target: number, action: 'mute' | 'allow-mic' | 'remove') {
    setBusy(true)
    try {
      await post(`/meetings/${meeting.id}/moderation`, { target, action })
      setConfirmRemove(undefined)
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
      room.setError(`请手动复制：${meeting.id}`)
    }
  }
  const alert = room.error || media.error || share.error || conference.error
  return (
    <div className="room-page">
      <header className="room-header">
        <span className="brand-symbol">C</span>
        <div className="room-title">
          <h1>{meeting.title}</h1>
          <button onClick={() => void copy()}>
            会议号 {formatCode(meeting.id)}
            <Icon name={copied ? 'check' : 'copy'} size={13} />
          </button>
        </div>
        <span className="connection-badge">
          {conference.mode === 'livekit'
            ? 'SFU · Simulcast'
            : conference.mode === 'p2p'
              ? 'P2P 模式'
              : '媒体准备中'}{' '}
          ·{' '}
          {room.status !== 'online'
            ? '信令恢复中…'
            : conference.connected
              ? '连接正常'
              : '媒体未连接'}
        </span>
        <time className="elapsed">
          {String(Math.floor(elapsed / 60)).padStart(2, '0')}:
          {String(elapsed % 60).padStart(2, '0')}
        </time>
      </header>
      {alert && (
        <div className="room-alert" role="alert">
          {alert}
          <button onClick={() => setMediaGeneration((value) => value + 1)}>重连媒体</button>
        </div>
      )}
      {locked && (
        <div className="reconnect-banner">主持人已限制你的麦克风。解除限制后，你可以自行开启。</div>
      )}
      {room.status === 'reconnecting' && (
        <div className="reconnect-banner" role="status">
          信令断开，正在自动重连并补齐消息…
        </div>
      )}
      {room.members.some((member) => member.recording) && (
        <div className="recording-banner" role="status">
          ● 主持人正在录制会议画面和声音，录制将供本场参会者回放。
        </div>
      )}
      {(recorder.error || recorder.busy) && (
        <div className="reconnect-banner" role="status">
          {recorder.busy ? '正在保存录制，请稍候…' : recorder.error}
          {recorder.backup && (
            <a href={recorder.backup} download={`${meeting.id}.webm`}>
              下载录制备份
            </a>
          )}
          {pendingExit && <button onClick={() => onExit(pendingExit)}>返回工作台</button>}
        </div>
      )}
      <div className="layout-toolbar">
        <button onClick={() => setShowMinutes(true)}>字幕记录与 AI 纪要</button>
        <label>
          画面布局
          <select
            aria-label="画面布局"
            value={layout}
            onChange={(event) => setLayout(event.target.value as Layout)}
          >
            <option value="grid">宫格视图</option>
            <option value="speaker">演讲者视图</option>
            <option value="share">共享主画面</option>
          </select>
        </label>
        {layout !== 'grid' && (
          <label>
            主画面
            <select
              aria-label="选择主画面"
              value={pinned ?? ''}
              onChange={(event) =>
                setPinned(event.target.value ? Number(event.target.value) : undefined)
              }
            >
              <option value="">自动选择</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {share.stream && <span>你正在共享屏幕</span>}
      </div>
      <LiveCaptions captions={captions} mic={media.mic && !locked} setEnabled={setCaptionEnabled} />
      <main className="room-main">
        <section
          className={`video-grid count-${Math.min(tiles.length, 4)} layout-${layout}`}
          aria-label="会议画面"
        >
          {screenStream && layout !== 'speaker' && (
            <article className="video-tile share-tile">
              <Video stream={screenStream} muted />
              <div className="tile-label">{screenOwner?.name} · 屏幕共享</div>
            </article>
          )}
          {layout === 'share' && !screenStream && (
            <div className="share-empty">尚无人共享屏幕，等待发起共享…</div>
          )}
          {tiles.map((member) => {
            const own = member.id === user.id
            const stream = own ? media.stream : conference.streams[member.id]
            return (
              <article
                className={`video-tile ${member.camera ? 'camera-on' : ''} ${layout === 'speaker' && member.id === focus ? 'focused-tile' : ''}`}
                key={member.id}
              >
                <Video stream={stream} muted={own || !!member.mutedByHost} mirror={own} />
                {(!member.camera || !stream) && (
                  <div className="tile-placeholder">
                    <span className={`participant-avatar color-${member.id % 4}`}>
                      {member.name.slice(0, 1)}
                    </span>
                    <p>
                      {member.name}
                      {own && '（我）'}
                    </p>
                    <small>{member.camera ? '连接视频中…' : '摄像头已关闭'}</small>
                  </div>
                )}
                <div className="tile-label">
                  <span>
                    {member.name}
                    {own && '（我）'}
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
            <button
              className={panel === 'chat' ? 'active' : ''}
              onClick={() => {
                setPanel('chat')
                setUnread(0)
              }}
            >
              <Icon name="chat" size={17} />
              聊天 {unread > 0 && <span className="unread-badge">{unread}</span>}
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
              {members.map((member) => (
                <div className="member-row advanced-member" key={member.id}>
                  <span className={`avatar color-${member.id % 4}`}>{member.name.slice(0, 1)}</span>
                  <div>
                    <strong>
                      {member.name}
                      {member.id === user.id && '（我）'}
                    </strong>
                    <small>
                      {member.host ? '主持人' : member.mutedByHost ? '麦克风受限' : '参会成员'}
                    </small>
                    {meeting.hostId === user.id && member.id !== user.id && (
                      <div className="member-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void moderate(member.id, member.mutedByHost ? 'allow-mic' : 'mute')
                          }
                        >
                          {member.mutedByHost ? '允许开麦' : '静音'}
                        </button>
                        <button disabled={busy} onClick={() => setConfirmRemove(member.id)}>
                          移出
                        </button>
                      </div>
                    )}
                  </div>
                  <Icon name="mic" off={!member.mic} size={16} />
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
            disabled={media.busy || locked}
            onClick={() => void media.toggle('audio')}
          >
            <Icon name="mic" off={!media.mic} />
            <span>{media.mic ? '静音' : '取消静音'}</span>
          </button>
          <button
            className="toolbar-button"
            disabled={media.busy}
            onClick={() => void media.toggle('video')}
          >
            <Icon name="video" off={!media.camera} />
            <span>{media.camera ? '关闭摄像头' : '开启摄像头'}</span>
          </button>
          <button className="toolbar-button" onClick={() => setSettings(true)}>
            <Icon name="settings" />
            <span>设备检测</span>
          </button>
          <button
            className="toolbar-button"
            disabled={share.busy || busy}
            onClick={() => {
              if (share.stream) share.stop()
              else {
                setLayout('share')
                void share.start()
              }
            }}
          >
            <Icon name="link" />
            <span>{share.stream ? '停止共享' : '共享屏幕'}</span>
          </button>
          {meeting.hostId === user.id && (
            <button
              className="toolbar-button"
              disabled={recorder.busy || busy}
              onClick={() => {
                if (recorder.active) void recorder.stop()
                else void recorder.start()
              }}
            >
              <Icon name="clock" />
              <span>{recorder.active ? '停止并保存' : '录制会议'}</span>
            </button>
          )}
          <button
            className="toolbar-button"
            onClick={() =>
              void Promise.allSettled(
                [...document.querySelectorAll('video')].map((video) => video.play()),
              )
            }
          >
            <Icon name="check" />
            <span>播放声音</span>
          </button>
        </div>
        <div className="leave-actions">
          <button className="button leave" disabled={busy || recorder.busy} onClick={leave}>
            离开会议
          </button>
          {meeting.hostId === user.id && (
            <button
              className="button danger"
              disabled={busy || recorder.busy}
              onClick={() => setConfirmEnd(true)}
            >
              结束会议
            </button>
          )}
        </div>
      </footer>
      {settings && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <button
              className="close-button"
              onClick={() => setSettings(false)}
              aria-label="关闭设备设置"
              autoFocus
            >
              <Icon name="close" />
            </button>
            <h2 id="settings-title">设备设置与检测</h2>
            <DeviceControls media={media} mutedByHost={locked} />
          </section>
        </div>
      )}
      {showMinutes && (
        <div className="modal-backdrop">
          <section
            className="modal history-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="本场字幕与纪要"
          >
            <button
              className="close-button"
              aria-label="关闭字幕与纪要"
              onClick={() => setShowMinutes(false)}
              autoFocus
            >
              <Icon name="close" />
            </button>
            <MinutesPanel meetingId={meeting.id} host={meeting.hostId === user.id} />
          </section>
        </div>
      )}
      {confirmEnd && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true">
            <h2>结束所有人的会议？</h2>
            <p>正在进行的录制会先保存，随后所有成员离会。</p>
            <div className="modal-actions">
              <button className="button subtle" onClick={() => setConfirmEnd(false)}>
                继续会议
              </button>
              <button className="button danger" disabled={busy} onClick={() => void end()}>
                确认结束
              </button>
            </div>
          </section>
        </div>
      )}
      {confirmRemove !== undefined && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true">
            <h2>移出这位成员？</h2>
            <p>移出后，该账号不能再次加入本场会议。</p>
            <div className="modal-actions">
              <button className="button subtle" onClick={() => setConfirmRemove(undefined)}>
                取消
              </button>
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void moderate(confirmRemove, 'remove')}
              >
                确认移出
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
