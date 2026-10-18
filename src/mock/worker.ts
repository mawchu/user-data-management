/// <reference lib="webworker" />
// 把 mock 資料庫放在 Web Worker（瀏覽器的背景執行緒），產生與排序千萬筆時畫面不會卡住
import { ApiError, UserDb } from './db'

export type MockRequest =
  | { method: 'init'; args: [size: number] }
  | { method: 'list'; args: Parameters<UserDb['list']> }
  | { method: 'update'; args: Parameters<UserDb['update']> }
  | { method: 'remove'; args: Parameters<UserDb['remove']> }
  | { method: 'pin'; args: Parameters<UserDb['pin']> }
  | { method: 'unpin'; args: Parameters<UserDb['unpin']> }

export type MockResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; status: number; message: string; details?: unknown }

let db: UserDb | null = null

self.onmessage = (e: MessageEvent<{ id: number } & MockRequest>) => {
  const { id, method, args } = e.data
  try {
    let result: unknown
    if (method === 'init') {
      db = new UserDb(args[0])
      result = { total: db.count }
    } else {
      if (!db) throw new ApiError(503, 'mock 資料庫尚未初始化')
      result = (db[method] as (...a: unknown[]) => unknown)(...args)
    }
    self.postMessage({ id, ok: true, result } satisfies MockResponse)
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500
    const details = err instanceof ApiError ? err.details : undefined
    self.postMessage({ id, ok: false, status, message: (err as Error).message, details } satisfies MockResponse)
  }
}
