const TOKEN_KEY = 'comeet.token'

// 使用会话存储；不同标签页可独立登录，关闭标签页后清除登录态。
export const session = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (token: string) => sessionStorage.setItem(TOKEN_KEY, token),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
}

export class ApiError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function api<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 15000, ...requestOptions } = options
  const token = session.get()
  const response = await fetch(`/api${path}`, {
    ...requestOptions,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  const result = await response.json()
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/')) {
      session.clear()
      window.dispatchEvent(new Event('comeet:unauthorized'))
    }
    throw new ApiError(
      result.error?.message ?? '请求失败，请重试',
      result.error?.code ?? 'UNKNOWN',
      response.status,
    )
  }
  return result.data as T
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) })
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '发生错误，请稍后重试'
}
export const formatCode = (id: string) => id.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3')
export const formatTime = (value: string) =>
  new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
export const formatDate = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
