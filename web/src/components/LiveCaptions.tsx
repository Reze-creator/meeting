import { useEffect, useState } from 'react'
import { api, errorText, formatTime } from '../api'
import type { IntelligenceStatus } from '../types'
import type { useCaptions } from '../hooks/useCaptions'

export function LiveCaptions({
  captions,
  mic,
  setEnabled,
}: {
  captions: ReturnType<typeof useCaptions>
  mic: boolean
  setEnabled: (value: boolean) => void
}) {
  const [status, setStatus] = useState<IntelligenceStatus>()
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(true)
  useEffect(() => {
    const controller = new AbortController()
    void api<IntelligenceStatus>('/intelligence', { signal: controller.signal })
      .then(setStatus)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorText(error))
      })
    return () => controller.abort()
  }, [])
  return (
    <section className="live-captions" aria-label="实时字幕">
      <div className="caption-controls">
        <button onClick={() => setExpanded((old) => !old)} aria-expanded={expanded}>
          {expanded ? '收起字幕' : '显示字幕'}
        </button>
        <label>
          <input
            type="checkbox"
            checked={captions.enabled}
            disabled={!status?.captions}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          识别本人发言
        </label>
        <select
          aria-label="字幕识别语言"
          value={captions.language}
          onChange={(event) => captions.setLanguage(event.target.value)}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
        <span role="status">
          {captions.recognizing
            ? '正在识别…'
            : captions.enabled
              ? mic
                ? '已开启'
                : '麦克风关闭，识别已暂停'
              : '未识别本人发言'}
        </span>
      </div>
      {expanded && (
        <>
          <p className="caption-hint">
            开启后，本人的麦克风会按约 4
            秒片段发送到配置的语音服务；转写供本场参会者查看。静音即暂停。
          </p>
          {!status?.captions && (
            <p className="caption-hint">STT 服务未配置，按挑战档文档启动后重新进入会议。</p>
          )}
          {(captions.error || error) && (
            <p role="alert" className="error">
              {captions.error || error}
            </p>
          )}
          <div className="caption-lines" aria-live="polite" aria-relevant="additions text">
            {captions.items.slice(-3).map((item) => (
              <p key={item.id}>
                <time>{formatTime(item.startedAt)}</time>
                <strong>{item.name}</strong>
                <span>{item.text}</span>
              </p>
            ))}
            {!captions.items.length && <p className="muted">等待成员开启字幕并发言…</p>}
          </div>
        </>
      )}
    </section>
  )
}
