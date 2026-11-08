import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useRoom } from './useRoom'
import type { Meeting } from '../types'

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  send = vi.fn()
  constructor() {
    FakeSocket.instances.push(this)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  event(type: string, data?: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) })
  }
}
const meeting: Meeting = {
  id: '123456789',
  title: '测试会议',
  hostId: 1,
  hostName: '主持人',
  createdAt: '',
  endedAt: null,
}

it('断线后提示重连，恢复时使用游标补齐消息，卸载后不再重连', async () => {
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  sessionStorage.setItem('comeet.token', 'test-jwt')
  const message = {
    id: 10,
    userId: 1,
    meetingId: meeting.id,
    name: '主持人',
    content: '第一条',
    clientId: 'a',
    createdAt: '',
  }
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [message] }) })
    .mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ ...message, id: 11, content: '断线期间' }] }),
    })
  vi.stubGlobal('fetch', fetchMock)
  const onExit = vi.fn()
  const onDisconnect = vi.fn()
  const { result, unmount } = renderHook(() =>
    useRoom({
      meeting,
      mic: false,
      camera: false,
      onSignal: vi.fn(),
      onMembers: vi.fn(),
      onDisconnect,
      onExit,
    }),
  )
  const first = FakeSocket.instances[0]
  act(() => {
    first.open()
    first.event('ready')
  })
  await waitFor(() => expect(result.current.messages).toHaveLength(1))
  expect(first.send).toHaveBeenCalledWith(expect.stringContaining('test-jwt'))
  vi.useFakeTimers()
  act(() => first.close())
  expect(result.current.status).toBe('reconnecting')
  expect(onDisconnect).toHaveBeenCalledOnce()
  act(() => vi.advanceTimersByTime(1400))
  const second = FakeSocket.instances[1]
  await act(async () => {
    second.open()
    second.event('ready')
  })
  expect(result.current.status).toBe('online')
  expect(fetchMock).toHaveBeenLastCalledWith(
    '/api/meetings/123456789/messages?after=10',
    expect.anything(),
  )
  expect(result.current.messages.map((item) => item.id)).toEqual([10, 11])
  act(() => second.event('replaced'))
  expect(onExit).toHaveBeenCalledWith(expect.stringContaining('其他标签页'))
  unmount()
  act(() => vi.advanceTimersByTime(30000))
  expect(FakeSocket.instances).toHaveLength(2)
})
