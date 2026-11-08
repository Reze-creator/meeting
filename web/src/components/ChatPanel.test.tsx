import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { ChatPanel } from './ChatPanel'

it('回车发送消息，服务端确认后只显示一条；中文输入法组合期间不提前发送', () => {
  const send = vi.fn(() => true)
  const user = { id: 1, username: 'alice', name: '爱丽丝' }
  const props = {
    user,
    messages: [],
    online: true,
    send,
    hasOlder: false,
    loadOlder: async () => {},
    loadingOlder: false,
  }
  const view = render(<ChatPanel {...props} />)
  const input = screen.getByLabelText('聊天消息')
  fireEvent.change(input, { target: { value: '你好' } })
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
  expect(send).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(send).toHaveBeenCalledOnce()
  const sent = send.mock.calls[0] as unknown as [{ clientId: string; content: string }]
  view.rerender(
    <ChatPanel
      {...props}
      messages={[
        {
          id: 1,
          meetingId: '123456789',
          userId: 1,
          name: user.name,
          content: sent[0].content,
          clientId: sent[0].clientId,
          createdAt: new Date().toISOString(),
        },
      ]}
    />,
  )
  expect(screen.getAllByText('你好')).toHaveLength(1)
  expect(screen.queryByText('发送中…')).toBeNull()
})
