import { useEffect, useState } from 'react'
import { api, errorText, formatDate, session } from '../api'
import type { Caption, IntelligenceStatus, MinutesContent, MinutesResult } from '../types'

function saveText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function minutesText(content: MinutesContent) {
  return `# 会议纪要\n\n${content.overview}\n\n## 已明确决定\n${content.decisions.map((item) => `- ${item}`).join('\n')}\n\n## 行动项\n${content.actions.map((item) => `- ${item.task}；负责人：${item.owner}；期限：${item.due}`).join('\n')}\n\n## 风险与待确认\n${content.risks.map((item) => `- ${item}`).join('\n')}\n`
}

/** 会中与会后共用同一份服务端纪要；模型输出作为纯文本渲染，不能注入 HTML。 */
export function MinutesPanel({ meetingId, host }: { meetingId: string; host: boolean }) {
  const [result, setResult] = useState<MinutesResult>()
  const [status, setStatus] = useState<IntelligenceStatus>()
  const [captions, setCaptions] = useState<Caption[]>([])
  const [hasOlder, setHasOlder] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      api<MinutesResult>(`/meetings/${meetingId}/minutes`, { signal: controller.signal }),
      api<IntelligenceStatus>('/intelligence', { signal: controller.signal }),
      api<Caption[]>(`/meetings/${meetingId}/captions`, { signal: controller.signal }),
    ])
      .then(([minutes, config, transcript]) => {
        if (controller.signal.aborted) return
        setResult(minutes)
        setStatus(config)
        setCaptions(transcript)
        setHasOlder(transcript.length === 100)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error))
      })
    return () => controller.abort()
  }, [meetingId])
  async function generate() {
    setBusy(true)
    setError('')
    try {
      setResult(
        await api<MinutesResult>(`/meetings/${meetingId}/minutes`, {
          method: 'POST',
          body: '{}',
          timeoutMs: 125000,
        }),
      )
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function exportTranscript() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/meetings/${meetingId}/transcript`, {
        headers: { Authorization: `Bearer ${session.get()}` },
        signal: AbortSignal.timeout(30000),
      })
      if (!response.ok) throw new Error('转写导出失败，请稍后重试')
      saveText(`${meetingId}-transcript.txt`, await response.text())
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  async function older() {
    setBusy(true)
    try {
      const page = await api<Caption[]>(`/meetings/${meetingId}/captions?before=${captions[0].id}`)
      setCaptions((old) => [...page, ...old])
      setHasOlder(page.length === 100)
    } catch (error) {
      setError(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  const minutes = result?.minutes
  return (
    <section className="minutes-panel" aria-label="字幕与 AI 纪要">
      <h3>AI 会议纪要</h3>
      <p className="muted">
        生成时会将本场已保存的字幕和聊天发送给 DeepSeek。结果仅供参考，请核对决定、负责人和期限。
      </p>
      {!status?.minutes && (
        <p className="muted">DeepSeek 尚未配置，请在后端 .env 设置 DEEPSEEK_API_KEY。</p>
      )}
      <div className="minutes-actions">
        {host && (
          <button
            className="button primary"
            disabled={busy || !status?.minutes}
            onClick={() => void generate()}
          >
            {busy ? '处理中…' : minutes ? '更新纪要' : '生成纪要'}
          </button>
        )}
        <button className="button subtle" disabled={busy} onClick={() => void exportTranscript()}>
          导出全部转写
        </button>
        {minutes && (
          <button
            className="button subtle"
            onClick={() => saveText(`${meetingId}-minutes.md`, minutesText(minutes.content))}
          >
            导出纪要
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {result?.stale && <p className="notice">生成后又有新增资料，主持人可更新纪要。</p>}
      {minutes ? (
        <div className="minutes-content">
          <p className="muted">
            {minutes.model} · {formatDate(minutes.createdAt)}
          </p>
          <p>{minutes.content.overview}</p>
          <h4>已明确决定</h4>
          {minutes.content.decisions.length ? (
            <ul>
              {minutes.content.decisions.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>没有明确决定。</p>
          )}
          <h4>行动项</h4>
          {minutes.content.actions.length ? (
            <ul>
              {minutes.content.actions.map((item, index) => (
                <li key={index}>
                  {item.task}
                  <small>
                    负责人：{item.owner} · 期限：{item.due}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p>没有明确行动项。</p>
          )}
          <h4>风险与待确认</h4>
          {minutes.content.risks.length ? (
            <ul>
              {minutes.content.risks.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : (
            <p>没有记录到待确认问题。</p>
          )}
        </div>
      ) : (
        <p className="muted">尚未生成纪要。需要先保存字幕或发送聊天消息。</p>
      )}
      <h3>语音转写</h3>
      {hasOlder && (
        <button className="text-button" disabled={busy} onClick={() => void older()}>
          加载更早的字幕
        </button>
      )}
      <div className="transcript-history">
        {captions.length ? (
          captions.map((caption) => (
            <p key={caption.id}>
              <time>{formatDate(caption.startedAt)}</time>
              <strong>{caption.name}</strong>
              <span>{caption.text}</span>
            </p>
          ))
        ) : (
          <p className="muted">没有语音转写。成员可在会中自行开启本人字幕。</p>
        )}
      </div>
    </section>
  )
}
