// 開發與 demo 用：把 fetch 換成 mock。接真後端時，在 main.ts 拿掉 setupMock() 即可
import { ref } from 'vue'
import { setTransport } from '../api/http'
import { createWorkerBackend } from './backend'
import { createMockFetch } from './server'

/** 已取消的請求數，畫面上顯示用 */
export const abortedRequests = ref(0)

export function setupMock() {
  // 網址加 ?size=5000 可用較少資料除錯；預設 1,000 萬筆
  const size =
    Number(new URLSearchParams(location.search).get('size')) || 10_000_000
  const { backend, ready } = createWorkerBackend(size)
  setTransport(
    createMockFetch(backend, {
      latency: [150, 400],
      onAbort: () => abortedRequests.value++,
    }),
  )
  return ready
}
