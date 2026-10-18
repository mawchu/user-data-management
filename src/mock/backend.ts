// 把 mock 資料庫包成「呼叫方法、回傳 Promise」的介面。瀏覽器用 Web Worker，測試直接用 UserDb。
import { ApiError, UserDb } from './db'
import type { MockRequest, MockResponse } from './worker'

export interface MockBackend {
  call(req: MockRequest): Promise<unknown>
}

/** 測試用：同一個執行緒直接呼叫 UserDb */
export function createDirectBackend(db: UserDb): MockBackend {
  return {
    async call({ method, args }) {
      if (method === 'init') return { total: db.count }
      return (db[method] as (...a: unknown[]) => unknown)(...args)
    },
  }
}

/** 瀏覽器用：資料庫跑在 Web Worker，產生與排序千萬筆時畫面不會卡住 */
export function createWorkerBackend(size: number): { backend: MockBackend; ready: Promise<unknown> } {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let seq = 0
  worker.onmessage = (e: MessageEvent<MockResponse>) => {
    const msg = e.data
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new ApiError(msg.status, msg.message, msg.details))
  }
  const backend: MockBackend = {
    call(req) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, ...req })
      })
    },
  }
  return { backend, ready: backend.call({ method: 'init', args: [size] }) }
}
