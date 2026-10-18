// 共用的 HTTP 請求函式：寫法和打真實後端一模一樣（fetch + AbortSignal + 依狀態碼處理錯誤）
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
    /** 429 時後端建議等待的秒數（Retry-After 標頭） */
    public retryAfter?: number,
  ) {
    super(message)
  }
}

export const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError'

export type Transport = (input: string, init?: RequestInit) => Promise<Response>

let transport: Transport = (input, init) => fetch(input, init)

/** 換掉底層的 fetch。目前在 main.ts 換成 mock；接真後端時刪掉那一行即可 */
export function setTransport(nextTransport: Transport) {
  transport = nextTransport
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  options: { body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await transport(url, {
    method,
    signal: options.signal,
    headers:
      options.body !== undefined
        ? { 'Content-Type': 'application/json' }
        : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  if (response.status === 204) return undefined as T
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    throw new HttpError(
      response.status,
      data?.message ?? `HTTP ${response.status}`,
      data?.details,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    )
  }
  return data as T
}
