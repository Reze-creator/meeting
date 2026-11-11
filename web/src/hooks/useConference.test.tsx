import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useConference } from './useConference'

const sdk = vi.hoisted(() => {
  class Room {
    static instances: Room[] = []
    state = 'connected'
    remoteParticipants = new Map()
    callbacks = new Map<string, () => void>()
    publications = new Map()
    localParticipant = {
      getTrackPublication: (source: string) => this.publications.get(source),
      publishTrack: vi.fn(async (track: unknown, options: { source: string }) => {
        const publication = {
          track: { mediaStreamTrack: track },
          mute: vi.fn().mockResolvedValue(undefined),
          unmute: vi.fn().mockResolvedValue(undefined),
        }
        this.publications.set(options.source, publication)
        return publication
      }),
      unpublishTrack: vi.fn(async (track: unknown) => {
        for (const [key, value] of this.publications) {
          if (value.track === track) this.publications.delete(key)
        }
      }),
    }
    connect = vi.fn().mockResolvedValue(undefined)
    disconnect = vi.fn().mockResolvedValue(undefined)
    constructor() {
      Room.instances.push(this)
    }
    on(event: string, callback: () => void) {
      this.callbacks.set(event, callback)
      return this
    }
  }
  return {
    Room,
    RoomEvent: {
      TrackSubscribed: 'subscribed',
      TrackUnsubscribed: 'unsubscribed',
      TrackMuted: 'muted',
      TrackUnmuted: 'unmuted',
      ParticipantDisconnected: 'left',
      ActiveSpeakersChanged: 'speakers',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
      Disconnected: 'disconnected',
    },
    Track: { Source: { Microphone: 'microphone', Camera: 'camera', ScreenShare: 'screen' } },
    VideoPresets: { h180: { height: 180 }, h360: { height: 360 } },
    VideoQuality: { HIGH: 2, MEDIUM: 1, LOW: 0 },
    ConnectionState: { Connected: 'connected' },
  }
})
vi.mock('livekit-client', () => sdk)
class FakeStream {
  tracks: MediaStreamTrack[]
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks
  }
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video')
  }
}
beforeEach(() => {
  sdk.Room.instances = []
  vi.stubGlobal('MediaStream', FakeStream)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { mode: 'livekit', url: 'ws://media.test', token: 'room-only-token' },
      }),
    }),
  )
})
it('SFU 分别发布音频、Simulcast 摄像头与共享，静音状态保持同步', async () => {
  const audio = { kind: 'audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack
  const video = { kind: 'video', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack
  const screen = { kind: 'video', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack
  const stream = new FakeStream([audio, video]) as unknown as MediaStream
  const share = new FakeStream([screen]) as unknown as MediaStream
  const options = {
    meetingId: '123456789',
    userId: 1,
    online: true,
    members: [],
    stream,
    screen: share,
    muted: false,
    mic: false,
    camera: true,
    send: vi.fn(),
    layout: 'grid',
    generation: 0,
  }
  const { result, rerender, unmount } = renderHook(
    ({ muted }) => useConference({ ...options, muted }),
    { initialProps: { muted: false } },
  )
  await waitFor(() => expect(result.current.connected).toBe(true))
  const room = sdk.Room.instances[0]
  await waitFor(() => expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(3))
  expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
    video,
    expect.objectContaining({
      source: 'camera',
      simulcast: true,
      videoSimulcastLayers: [{ height: 180 }, { height: 360 }],
    }),
  )
  expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(
    screen,
    expect.objectContaining({ source: 'screen', simulcast: false }),
  )
  expect(room.publications.get('microphone').mute).toHaveBeenCalledOnce()
  rerender({ muted: true })
  await waitFor(() => expect(room.publications.has('microphone')).toBe(false))
  unmount()
  expect(room.disconnect).toHaveBeenCalledWith(false)
  expect(audio.stop).not.toHaveBeenCalled()
  expect(video.stop).not.toHaveBeenCalled()
})
it('SFU 重连和连接关闭会更新状态，避免只看信令就显示媒体连接正常', async () => {
  const { result, rerender } = renderHook(
    ({ generation }) =>
      useConference({
        meetingId: '123456789',
        userId: 1,
        online: true,
        members: [],
        muted: false,
        mic: false,
        camera: false,
        send: vi.fn(),
        layout: 'grid',
        generation,
      }),
    { initialProps: { generation: 0 } },
  )
  await waitFor(() => expect(result.current.connected).toBe(true))
  const room = sdk.Room.instances[0]
  act(() => room.callbacks.get('reconnecting')?.())
  expect(result.current.connected).toBe(false)
  act(() => room.callbacks.get('reconnected')?.())
  expect(result.current.connected).toBe(true)
  act(() => room.callbacks.get('disconnected')?.())
  expect(result.current.connected).toBe(false)
  expect(result.current.error).toContain('重连媒体')
  act(() => room.callbacks.get('reconnected')?.())
  expect(result.current.connected).toBe(true)
  // 手动重连期间令牌请求尚未返回，也必须显示媒体未连接；旧房间事件不能覆盖它。
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}))
  rerender({ generation: 1 })
  expect(result.current.connected).toBe(false)
  act(() => room.callbacks.get('reconnected')?.())
  expect(result.current.connected).toBe(false)
})
