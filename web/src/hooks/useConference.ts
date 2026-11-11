import { useCallback, useEffect, useRef, useState } from 'react'
import { Room, RoomEvent, Track, VideoPresets, VideoQuality, ConnectionState } from 'livekit-client'
import type { LocalTrackPublication } from 'livekit-client'
import { post, errorText } from '../api'
import { usePeers } from './usePeers'
import type { Signal } from './usePeers'
import type { Member } from '../types'

type Mode = 'connecting' | 'p2p' | 'livekit'
interface Options {
  meetingId: string
  userId: number
  online: boolean
  members: Member[]
  stream?: MediaStream
  screen?: MediaStream
  muted: boolean
  mic: boolean
  camera: boolean
  send: (payload: unknown) => boolean
  layout: string
  focusedId?: number
  generation: number
}

/** 统一 P2P 和 SFU 生命周期。配置 SFU 后连接失败会明确报错，不静默降级。 */
export function useConference(options: Options) {
  const [mode, setMode] = useState<Mode>('connecting')
  const [error, setError] = useState('')
  const [streams, setStreams] = useState<Record<number, MediaStream>>({})
  const [screens, setScreens] = useState<Record<number, MediaStream>>({})
  const [speaker, setSpeaker] = useState<number>()
  const [revision, setRevision] = useState(0)
  const [connected, setConnected] = useState(false)
  const roomRef = useRef<Room | null>(null)
  const publishing = useRef(Promise.resolve())
  const p2p = usePeers(
    mode === 'p2p' ? options.stream : undefined,
    options.userId,
    (target, signal) => options.send({ type: 'signal', target, signal }),
    mode === 'p2p' ? options.screen : undefined,
  )
  const { syncMembers, reset: resetPeers, receive: receivePeer } = p2p
  useEffect(() => {
    if (mode === 'p2p' && options.online) syncMembers(options.members)
  }, [mode, options.members, options.online, syncMembers])
  useEffect(() => {
    if (!options.online) return
    let disposed = false
    let room: Room | undefined
    async function connect() {
      try {
        const config = await post<{ mode: 'p2p' | 'livekit'; url?: string; token?: string }>(
          `/meetings/${options.meetingId}/media-token`,
        )
        if (disposed) return
        setMode(config.mode)
        setError('')
        if (config.mode === 'p2p') {
          setConnected(true)
          return
        }
        room = new Room({
          adaptiveStream: false,
          dynacast: true,
          publishDefaults: {
            simulcast: true,
            videoCodec: 'vp8',
            videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          },
        })
        roomRef.current = room
        const refresh = () => {
          if (disposed || !room) return
          const videos: Record<number, MediaStream> = {}
          const shares: Record<number, MediaStream> = {}
          room.remoteParticipants.forEach((participant) => {
            const camera = new MediaStream()
            const screen = new MediaStream()
            participant.trackPublications.forEach((publication) => {
              if (!publication.track || publication.isMuted) return
              const stream = publication.source === Track.Source.ScreenShare ? screen : camera
              stream.addTrack(publication.track.mediaStreamTrack)
            })
            const id = Number(participant.identity)
            if (camera.getTracks().length) videos[id] = camera
            if (screen.getTracks().length) shares[id] = screen
          })
          setStreams(videos)
          setScreens(shares)
        }
        room
          .on(RoomEvent.TrackSubscribed, refresh)
          .on(RoomEvent.TrackUnsubscribed, refresh)
          .on(RoomEvent.TrackMuted, refresh)
          .on(RoomEvent.TrackUnmuted, refresh)
          .on(RoomEvent.ParticipantDisconnected, refresh)
        room.on(RoomEvent.ActiveSpeakersChanged, (participants) =>
          setSpeaker(participants[0] ? Number(participants[0].identity) : undefined),
        )
        room.on(RoomEvent.Reconnecting, () => {
          if (disposed) return
          setConnected(false)
          setError('媒体连接中断，SFU 正在重连…')
        })
        room.on(RoomEvent.Reconnected, () => {
          if (disposed) return
          setConnected(true)
          setError('')
          refresh()
          setRevision((value) => value + 1)
        })
        room.on(RoomEvent.Disconnected, () => {
          if (!disposed) {
            setConnected(false)
            setError('媒体连接已关闭，可点击“重连媒体”恢复。')
          }
        })
        await room.connect(config.url!, config.token!, { autoSubscribe: true })
        if (disposed) {
          await room.disconnect(false)
          return
        }
        setConnected(true)
        setRevision((value) => value + 1)
        refresh()
      } catch (error) {
        if (!disposed) {
          setConnected(false)
          setError(`媒体连接失败：${errorText(error)}`)
        }
      }
    }
    void connect()
    return () => {
      disposed = true
      // 新连接必须重新完成握手，不能沿用上一条媒体连接的“已连接”状态。
      setConnected(false)
      if (roomRef.current === room) roomRef.current = null
      void room?.disconnect(false)
      resetPeers()
    }
  }, [options.meetingId, options.online, options.generation, resetPeers])

  // 串行发布/替换，避免设备切换和共享操作交错产生重复 TrackPublication。
  useEffect(() => {
    const room = roomRef.current
    if (mode !== 'livekit' || !room || room.state !== ConnectionState.Connected) return
    let disposed = false
    publishing.current = publishing.current
      .catch(() => {})
      .then(async () => {
        if (disposed) return
        const desired = new Map<Track.Source, MediaStreamTrack | undefined>([
          [
            Track.Source.Microphone,
            options.muted ? undefined : options.stream?.getAudioTracks()[0],
          ],
          [Track.Source.Camera, options.stream?.getVideoTracks()[0]],
          [Track.Source.ScreenShare, options.screen?.getVideoTracks()[0]],
        ])
        for (const [source, track] of desired) {
          if (disposed || roomRef.current !== room) return
          const publication = room.localParticipant.getTrackPublication(source) as
            LocalTrackPublication | undefined
          if (publication?.track?.mediaStreamTrack === track) {
            if (publication) {
              const enabled =
                source === Track.Source.Microphone
                  ? options.mic
                  : source === Track.Source.Camera
                    ? options.camera
                    : true
              if (enabled) await publication.unmute()
              else await publication.mute()
            }
            continue
          }
          if (publication?.track)
            await room.localParticipant.unpublishTrack(publication.track, false)
          if (track) {
            const next = await room.localParticipant.publishTrack(track, {
              source,
              simulcast: source === Track.Source.Camera,
              videoCodec: 'vp8',
              videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
            })
            const enabled =
              source === Track.Source.Microphone
                ? options.mic
                : source === Track.Source.Camera
                  ? options.camera
                  : true
            if (!enabled) await next.mute()
          }
        }
      })
      .catch((error) => {
        if (!disposed) setError(errorText(error))
      })
    return () => {
      disposed = true
    }
  }, [options.stream, options.screen, options.muted, options.mic, options.camera, mode, revision])

  useEffect(() => {
    const room = roomRef.current
    if (!room) return
    room.remoteParticipants.forEach((participant) =>
      participant.videoTrackPublications.forEach((publication) => {
        // 宫格接收中等清晰度；演讲者/共享主画面优先高清，其他摄像头请求低层。
        const primary =
          publication.source === Track.Source.ScreenShare ||
          Number(participant.identity) === options.focusedId
        publication.setVideoQuality(
          primary
            ? VideoQuality.HIGH
            : options.layout === 'grid'
              ? VideoQuality.MEDIUM
              : VideoQuality.LOW,
        )
      }),
    )
  }, [options.layout, options.focusedId, revision, streams])
  const receive = useCallback(
    (from: number, sessionId: string, signal: Signal) => {
      receivePeer(from, sessionId, signal)
    },
    [receivePeer],
  )
  const reset = useCallback(() => {
    resetPeers()
  }, [resetPeers])
  return {
    mode,
    error,
    streams: mode === 'livekit' ? streams : p2p.streams,
    screens: mode === 'livekit' ? screens : p2p.screens,
    speaker,
    failures: p2p.failures,
    connected: options.online && connected,
    receive,
    reset,
  }
}
