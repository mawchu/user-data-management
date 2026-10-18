// 把 mock 資料庫包成「呼叫方法、回傳 Promise」的介面。瀏覽器用 Web Worker，測試直接用 UserDb。
import { ApiError, UserDb } from './db'
import type { MockRequest, MockResponse } from './worker'

export interface MockBackend {
  call(request: MockRequest): Promise<unknown>
}

/** 測試用：同一個執行緒直接呼叫 UserDb */
export function createDirectBackend(db: UserDb): MockBackend {
  return {
    async call({ method, args }) {
      if (method === 'init') return { total: db.count }
      return (db[method] as (...methodArgs: unknown[]) => unknown)(...args)
    },
  }
}

/** 瀏覽器用：資料庫跑在 Web Worker，產生與排序千萬筆時畫面不會卡住 */
export function createWorkerBackend(size: number): {
  backend: MockBackend
  ready: Promise<unknown>
} {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  })
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >()
  let lastRequestId = 0
  worker.onmessage = (event: MessageEvent<MockResponse>) => {
    const response = event.data
    const handlers = pending.get(response.id)
    if (!handlers) return
    pending.delete(response.id)
    if (response.ok) handlers.resolve(response.result)
    else
      handlers.reject(
        new ApiError(response.status, response.message, response.details),
      )
  }
  const backend: MockBackend = {
    call(request) {
      const id = ++lastRequestId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, ...request })
      })
    },
  }
  return { backend, ready: backend.call({ method: 'init', args: [size] }) }
}
