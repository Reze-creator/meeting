import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { MinutesPanel } from './MinutesPanel'

function configure(failGenerate = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: RequestInit) => {
      if (options?.method === 'POST' && failGenerate)
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: { message: '模型繁忙，请重试' } }),
        }
      const data = path.includes('/intelligence')
        ? { minutes: true, captions: true }
        : path.includes('/captions')
          ? []
          : {
              stale: false,
              minutes: {
                model: 'deepseek-flash',
                createdAt: '2026-11-11T00:00:00Z',
                sourceHash: 'hash',
                content: {
                  overview: '<img src=x onerror=alert(1)>',
                  decisions: ['周五验收'],
                  actions: [{ task: '补充测试', owner: '小王', due: '周四' }],
                  risks: [],
                },
              },
            }
      return { ok: true, json: async () => ({ data }) }
    }),
  )
}
it('不把模型输出当 HTML 执行，普通成员只能读取纪要', async () => {
  configure()
  const { container } = render(<MinutesPanel meetingId="123456789" host={false} />)
  await screen.findByText('<img src=x onerror=alert(1)>')
  expect(container.querySelector('img')).toBeNull()
  expect(screen.queryByRole('button', { name: '更新纪要' })).toBeNull()
  expect(screen.getByText('周五验收')).toBeDefined()
})
it('模型请求失败时旧版纪要继续显示', async () => {
  configure(true)
  render(<MinutesPanel meetingId="123456789" host />)
  fireEvent.click(await screen.findByRole('button', { name: '更新纪要' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('模型繁忙'))
  expect(screen.getByText('周五验收')).toBeDefined()
})
