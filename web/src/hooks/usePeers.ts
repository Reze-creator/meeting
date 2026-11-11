import { useCallback, useEffect, useRef, useState } from 'react'
import type { Member } from '../types'

export interface Signal {
  description?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  screenId?: string
}
interface Peer {
  pc: RTCPeerConnection
  sessionId: string
  makingOffer: boolean
  ignoreOffer: boolean
  settingAnswer: boolean
  polite: boolean
  stream: MediaStream
  queue: Promise<void>
  senders: Map<string, RTCRtpSender>
  screenId?: string
}
type SendSignal = (target: number, signal: Signal) => void

/** 小规模会议使用 P2P；服务端只转发信令，音视频由浏览器直接传输。 */
export function usePeers(
  localStream: MediaStream | undefined,
  selfId: number,
  sendSignal: SendSignal,
  screenStream?: MediaStream,
) {
  const peers = useRef(new Map<number, Peer>())
  const local = useRef(localStream)
  const send = useRef(sendSignal)
  const screen = useRef(screenStream)
  const [screens, setScreens] = useState<Record<number, MediaStream>>({})
  const [streams, setStreams] = useState<Record<number, MediaStream>>({})
  const [failures, setFailures] = useState<number[]>([])
  useEffect(() => {
    local.current = localStream
    send.current = sendSignal
    screen.current = screenStream
  }, [localStream, sendSignal, screenStream])

  const destroy = useCallback((id: number) => {
    peers.current.get(id)?.pc.close()
    peers.current.delete(id)
    setScreens((old) => {
      const next = { ...old }
      delete next[id]
      return next
    })
    setStreams((old) => {
      const next = { ...old }
      delete next[id]
      return next
    })
    setFailures((old) => old.filter((value) => value !== id))
  }, [])

  const ensure = useCallback(
    (member: Member) => {
      let peer = peers.current.get(member.id)
      if (peer?.sessionId === member.sessionId) return peer
      if (peer) destroy(member.id)
      const urls = (import.meta.env.VITE_STUN_URL ?? 'stun:stun.l.google.com:19302')
        .split(',')
        .filter(Boolean)
      const turn = import.meta.env.VITE_TURN_URL
      const iceServers: RTCIceServer[] = urls.length ? [{ urls }] : []
      if (turn)
        iceServers.push({
          urls: turn,
          username: import.meta.env.VITE_TURN_USERNAME,
          credential: import.meta.env.VITE_TURN_CREDENTIAL,
        })
      const pc = new RTCPeerConnection({ iceServers })
      peer = {
        pc,
        sessionId: member.sessionId,
        makingOffer: false,
        ignoreOffer: false,
        settingAnswer: false,
        polite: selfId > member.id,
        stream: new MediaStream(),
        queue: Promise.resolve(),
        senders: new Map(),
      }
      const current = peer
      peers.current.set(member.id, peer)
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) send.current(member.id, { candidate: candidate.toJSON() })
      }
      pc.ontrack = ({ track, streams: remoteStreams }) => {
        if (current.screenId && remoteStreams[0]?.id === current.screenId) {
          setScreens((old) => ({ ...old, [member.id]: new MediaStream([track]) }))
          return
        }
        current.stream.addTrack(track)
        setStreams((old) => ({ ...old, [member.id]: new MediaStream(current.stream.getTracks()) }))
        track.onended = () => {
          current.stream.removeTrack(track)
          setStreams((old) => ({
            ...old,
            [member.id]: new MediaStream(current.stream.getTracks()),
          }))
        }
      }
      pc.onconnectionstatechange = () => {
        if (peers.current.get(member.id) !== current) return
        setFailures((old) =>
          pc.connectionState === 'failed'
            ? [...new Set([...old, member.id])]
            : old.filter((id) => id !== member.id),
        )
      }
      // 使用完美协商模式处理双方同时发起 offer 时的冲突。
      pc.onnegotiationneeded = async () => {
        try {
          current.makingOffer = true
          await pc.setLocalDescription()
          send.current(member.id, {
            description: pc.localDescription!.toJSON(),
            screenId: screen.current?.id,
          })
        } catch {
          if (pc.signalingState !== 'closed')
            setFailures((old) => [...new Set([...old, member.id])])
        } finally {
          current.makingOffer = false
        }
      }
      for (const track of local.current?.getTracks() ?? [])
        current.senders.set(track.kind, pc.addTrack(track, local.current!))
      for (const track of screen.current?.getTracks() ?? [])
        current.senders.set('screen', pc.addTrack(track, screen.current!))
      return peer
    },
    [destroy, selfId],
  )

  const syncMembers = useCallback(
    (members: Member[]) => {
      const remote = members.filter((member) => member.id !== selfId)
      for (const id of peers.current.keys())
        if (!remote.some((member) => member.id === id)) destroy(id)
      remote.forEach(ensure)
    },
    [selfId, ensure, destroy],
  )

  const receive = useCallback((from: number, sessionId: string, signal: Signal) => {
    const peer = peers.current.get(from)
    if (!peer || peer.sessionId !== sessionId) return
    const { pc } = peer
    // 每个远端的 SDP/ICE 串行处理，防止 ICE 抢在对应 SDP 之前执行。
    peer.queue = peer.queue.then(async () => {
      try {
        if (signal.description) {
          peer.screenId = signal.screenId
          const readyForOffer =
            !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer)
          const collision = signal.description.type === 'offer' && !readyForOffer
          peer.ignoreOffer = !peer.polite && collision
          if (peer.ignoreOffer) return
          peer.settingAnswer = signal.description.type === 'answer'
          await pc.setRemoteDescription(signal.description)
          peer.settingAnswer = false
          if (signal.description.type === 'offer') {
            await pc.setLocalDescription()
            send.current(from, {
              description: pc.localDescription!.toJSON(),
              screenId: screen.current?.id,
            })
          }
        } else if (signal.candidate) {
          try {
            await pc.addIceCandidate(signal.candidate)
          } catch (error) {
            if (!peer.ignoreOffer) throw error
          }
        }
      } catch {
        if (pc.signalingState !== 'closed') setFailures((old) => [...new Set([...old, from])])
      }
    })
  }, [])

  useEffect(() => {
    for (const peer of peers.current.values()) {
      for (const kind of ['audio', 'video']) {
        const track = localStream?.getTracks().find((track) => track.kind === kind)
        const sender = peer.senders.get(kind)
        if (sender) void sender.replaceTrack(track ?? null).catch(() => {})
        else if (track) peer.senders.set(kind, peer.pc.addTrack(track, localStream!))
      }
    }
  }, [localStream])
  useEffect(() => {
    for (const peer of peers.current.values()) {
      const track = screenStream?.getVideoTracks()[0]
      const sender = peer.senders.get('screen')
      if (sender && sender.track !== track) {
        peer.pc.removeTrack(sender)
        peer.senders.delete('screen')
      }
      if (track && !peer.senders.has('screen'))
        peer.senders.set('screen', peer.pc.addTrack(track, screenStream!))
    }
  }, [screenStream])
  const reset = useCallback(() => {
    for (const peer of peers.current.values()) peer.pc.close()
    peers.current.clear()
    setStreams({})
    setScreens({})
    setFailures([])
  }, [])
  useEffect(
    () => () => {
      for (const peer of peers.current.values()) peer.pc.close()
      peers.current.clear()
    },
    [],
  )
  return { streams, screens, failures, syncMembers, receive, reset }
}
