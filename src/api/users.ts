/**
 * 使用者 API。對應的 HTTP 介面：
 *   GET    /api/users?q=&sortBy=&order=&cursor=&limit=500
 *   PATCH  /api/users/:id
 *   DELETE /api/users/:id
 *   PUT    /api/users/:id/pin   { position }
 *   DELETE /api/users/:id/pin
 * 目前直接呼叫 Web Worker 裡的 mock 資料庫。
 */
import type { UserInput, UserListQuery, UserListResponse, UserRow } from '../types/user'
import type { MockRequest, MockResponse } from '../mock/worker'

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message)
  }
}

// 網址加 ?size=5000 可用較少資料開發除錯；預設 1,000 萬筆
const size = Number(new URLSearchParams(location.search).get('size')) || 10_000_000
const worker = new Worker(new URL('../mock/worker.ts', import.meta.url), { type: 'module' })
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
let seq = 0

worker.onmessage = (e: MessageEvent<MockResponse>) => {
  const msg = e.data
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.ok) p.resolve(msg.result)
  else p.reject(new HttpError(msg.status, msg.message, msg.details))
}

function call<T>(req: MockRequest): Promise<T> {
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker.postMessage({ id, ...req })
  })
}

export const usersApi = {
  /** 產生 mock 資料；其他請求會排在它後面 */
  ready: call<{ total: number }>({ method: 'init', args: [size] }),
  list: (query: UserListQuery) => call<UserListResponse>({ method: 'list', args: [query] }),
  update: (id: number, input: UserInput) => call<UserRow>({ method: 'update', args: [id, input] }),
  remove: (id: number) => call<void>({ method: 'remove', args: [id] }),
  pin: (id: number, position: number) => call<UserRow>({ method: 'pin', args: [id, position] }),
  unpin: (id: number) => call<UserRow>({ method: 'unpin', args: [id] }),
}
