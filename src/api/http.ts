// 共用的 HTTP 請求函式：寫法和打真實後端一模一樣（fetch + AbortSignal + 依狀態碼處理錯誤）
export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message)
  }
}

export const isAbortError = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

export type Transport = (input: string, init?: RequestInit) => Promise<Response>

let transport: Transport = (input, init) => fetch(input, init)

/** 換掉底層的 fetch。目前在 main.ts 換成 mock；接真後端時刪掉那一行即可 */
export function setTransport(t: Transport) {
  transport = t
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const res = await transport(url, {
    method,
    signal: options.signal,
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new HttpError(res.status, data?.message ?? `HTTP ${res.status}`, data?.details)
  return data as T
}
