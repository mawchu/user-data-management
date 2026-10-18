// 開發與 demo 用：把 fetch 換成 mock。接真後端時，在 main.ts 拿掉 setupMock() 即可
import { ref } from 'vue'
import { setTransport } from '../api/http'
import { createWorkerBackend } from './backend'
import { createMockFetch } from './server'

/** 已取消的請求數，畫面上顯示用 */
export const abortedRequests = ref(0)

export function setupMock() {
  // 網址加 ?size=5000 可用較少資料除錯；預設 1,000 萬筆
  const params = new URLSearchParams(location.search)
  const size = Number(params.get('size')) || 10_000_000
  // ?rateLimit=0 關閉限流（e2e 用），?rateLimit=3 可以手動觸發 429
  const rateLimit = params.has('rateLimit')
    ? Number(params.get('rateLimit'))
    : 30
  const { backend, ready } = createWorkerBackend(size)
  setTransport(
    createMockFetch(backend, {
      latency: [150, 400],
      onAbort: () => abortedRequests.value++,
      // 模擬後端限流：10 秒內超過 30 次查詢回 429，用來展示前端的處理
      rateLimit:
        rateLimit > 0 ? { limit: rateLimit, windowMs: 10_000 } : undefined,
    }),
  )
  return ready
}
