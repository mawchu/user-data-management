/// <reference lib="webworker" />
// 把 mock 資料庫放在 Web Worker（瀏覽器的背景執行緒），產生與排序千萬筆時畫面不會卡住
import { ApiError, UserDb } from './db'

export type MockRequest =
  | { method: 'init'; args: [size: number] }
  | { method: 'list'; args: Parameters<UserDb['list']> }
  | { method: 'get'; args: Parameters<UserDb['get']> }
  | { method: 'create'; args: Parameters<UserDb['create']> }
  | { method: 'update'; args: Parameters<UserDb['update']> }
  | { method: 'remove'; args: Parameters<UserDb['remove']> }

export type MockResponse =
  | { id: number; ok: true; result: unknown }
  | {
      id: number
      ok: false
      status: number
      message: string
      details?: unknown
    }

let db: UserDb | null = null

self.onmessage = (event: MessageEvent<{ id: number } & MockRequest>) => {
  const { id, method, args } = event.data
  try {
    let result: unknown
    if (method === 'init') {
      db = new UserDb(args[0])
      result = { total: db.count }
    } else {
      if (!db) throw new ApiError(503, 'mock 資料庫尚未初始化')
      result = (db[method] as (...methodArgs: unknown[]) => unknown)(...args)
    }
    self.postMessage({ id, ok: true, result } satisfies MockResponse)
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500
    const details = error instanceof ApiError ? error.details : undefined
    self.postMessage({
      id,
      ok: false,
      status,
      message: (error as Error).message,
      details,
    } satisfies MockResponse)
  }
}
