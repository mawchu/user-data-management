import { effectScope } from 'vue'
import { describe, expect, it } from 'vitest'
import { UserDb } from '../src/mock/db'
import { createDirectBackend } from '../src/mock/backend'
import { createMockFetch } from '../src/mock/server'
import { setTransport } from '../src/api/http'
import { useUserList } from '../src/composables/useUserList'

describe('useUserList 取消過期請求', () => {
  it('快速切換搜尋：舊請求被取消，畫面只留最後一次的結果', async () => {
    let aborted = 0
    const urls: string[] = []
    const mockFetch = createMockFetch(createDirectBackend(new UserDb(3000)), { latency: [30, 30], onAbort: () => aborted++ })
    setTransport((input, init) => (urls.push(input), mockFetch(input, init)))

    const scope = effectScope()
    const list = scope.run(() => useUserList())!
    list.query.q = 'c'
    void list.reload()
    list.query.q = 'ch'
    void list.reload()
    list.query.q = 'chen'
    await list.reload()

    expect(aborted).toBe(2)
    expect(urls).toHaveLength(3)
    expect(list.rows.value.length).toBeGreaterThan(0)
    expect(list.rows.value.every((r) => [r.userName, r.position, r.location, String(r.age), r.dateStart].some((v) => v.toLowerCase().includes('chen')))).toBe(true)
    expect(list.loading.value).toBe(false)
    expect(list.error.value).toBeNull()

    // 元件卸載時，進行中的請求也會被取消
    list.query.q = ''
    await list.reload()
    expect(list.hasMore.value).toBe(true)
    void list.loadMore()
    scope.stop()
    await new Promise((r) => setTimeout(r, 50))
    expect(aborted).toBe(3)
  })
})
