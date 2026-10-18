import { effectScope, watchEffect } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { UserDb } from '../src/mock/db'
import { createDirectBackend } from '../src/mock/backend'
import { createMockFetch, type MockFetchOptions } from '../src/mock/server'
import { setTransport, type Transport } from '../src/api/http'
import { useUserList } from '../src/composables/useUserList'
import { matchesKeyword } from '../src/utils/match'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const INPUT = {
  userName: 'Mawchu Test',
  position: 'Tech Lead',
  location: 'Remote',
  age: 40,
  dateStart: '2026-10-18',
}

/** 建立 mock 後端，並記錄每個請求 */
function setup(size = 3000, options: MockFetchOptions = {}) {
  const db = new UserDb(size)
  const mockFetch = createMockFetch(createDirectBackend(db), options)
  const requests: string[] = []
  let transport: Transport = (input, init) => mockFetch(input, init)
  setTransport((input, init) => {
    requests.push(`${init?.method ?? 'GET'} ${input}`)
    return transport(input, init)
  })
  const scope = effectScope()
  const list = scope.run(() => useUserList())!
  scopes.push(scope)
  return {
    db,
    list,
    requests,
    mockFetch,
    /** 換掉底層傳輸，用來模擬失敗或延遲 */
    useTransport: (next: Transport) => (transport = next),
  }
}
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()))

describe('請求生命週期', () => {
  it('快速切換搜尋：舊請求被取消，畫面只留最後一次的結果', async () => {
    let aborted = 0
    const { list } = setup(3000, {
      latency: [30, 30],
      onAbort: () => aborted++,
    })
    void list.search('c')
    void list.search('ch')
    await list.search('chen')
    expect(aborted).toBe(2)
    expect(list.rows.value.length).toBeGreaterThan(0)
    expect(list.rows.value.every((r) => matchesKeyword(r, 'chen'))).toBe(true)
    expect(list.loading.value).toBe(false)
  })

  it('載入失敗後停下來，不會被預先載入一直觸發；按重試才再送', async () => {
    const { list, requests, useTransport, mockFetch } = setup()
    await list.reload()
    useTransport(
      async () => new Response('{"message":"壞了"}', { status: 500 }),
    )
    // 和 UserTable.vue 一樣的預先載入條件（畫面停在最上方，已載入不到 150 列以外）
    scopes[0].run(() =>
      watchEffect(() => {
        if (
          list.hasMore.value &&
          !list.loading.value &&
          !list.error.value &&
          !list.stale.value
        )
          void list.loadMore()
      }),
    )
    await wait(200)
    const failedRequests = requests.length - 1
    expect(failedRequests).toBe(1)
    expect(list.error.value).toBe('壞了')

    useTransport(mockFetch)
    await list.retry()
    expect(list.error.value).toBeNull()
    expect(list.rows.value.length).toBeGreaterThan(500)
  })

  it('載入下一批的途中刪除一筆：不會漏掉或重複', async () => {
    const { list, useTransport, mockFetch } = setup(1500)
    await list.reload()
    // 查詢比較慢，刪除比較快：刪除先到後端
    useTransport(async (input, init) => {
      if ((init?.method ?? 'GET') === 'GET') await wait(50)
      return mockFetch(input, init)
    })
    const victim = list.rows.value[10].id
    const pending = list.loadMore()
    await list.removeRow(victim)
    await pending
    while (list.hasMore.value) await list.loadMore()
    const ids = list.rows.value.map((r) => r.id)
    expect(ids).toHaveLength(1499)
    expect(new Set(ids).size).toBe(1499)
    expect(ids).not.toContain(victim)
  })

  it('換條件時保留舊資料（stale），新的第一批回來才換掉', async () => {
    const { list } = setup(3000, { latency: [30, 30] })
    await list.reload()
    const before = list.rows.value
    const pending = list.search('chen')
    expect(list.stale.value).toBe(true)
    expect(list.rows.value).toBe(before)
    await pending
    expect(list.stale.value).toBe(false)
    expect(list.rows.value).not.toBe(before)
  })

  it('第一批快取：切回剛才的條件不再送請求；修改資料後快取失效', async () => {
    const { list, requests } = setup()
    await list.reload()
    await list.toggleSort('age')
    const count = requests.length
    await list.setSort(null)
    expect(requests.length).toBe(count)
    await list.toggleSort('age')
    expect(requests.length).toBe(count)

    await list.removeRow(list.rows.value[0].id)
    await list.setSort(null)
    expect(requests.length).toBe(count + 2) // DELETE + 重新查詢
  })

  it('429：依 Retry-After 等待後自動重試一次，期間顯示提示', async () => {
    const { list, useTransport, mockFetch } = setup()
    let calls = 0
    useTransport(async (input, init) => {
      if (++calls === 1)
        return new Response('{"message":"太頻繁"}', {
          status: 429,
          headers: { 'Retry-After': '1' },
        })
      return mockFetch(input, init)
    })
    const pending = list.reload()
    await wait(20)
    expect(list.notice.value).toContain('1 秒後自動重試')
    await pending
    expect(list.notice.value).toBeNull()
    expect(list.rows.value).toHaveLength(500)
    expect(calls).toBe(2)
  })
})

describe('新增、更新、刪除與多人衝突', () => {
  it('新增：放在最上面並標示，之後的批次不會重複出現', async () => {
    const { list } = setup(600)
    await list.reload()
    const created = await list.createRow(INPUT)
    expect(list.rows.value[0]).toEqual(created)
    expect(list.newIds.value.has(created.id)).toBe(true)
    expect(list.total.value).toBe(601)
    while (list.hasMore.value) await list.loadMore()
    expect(list.rows.value.filter((r) => r.id === created.id)).toHaveLength(1)
    expect(list.rows.value).toHaveLength(601)
  })

  it('更新：成功後原地換掉並帶回新版本', async () => {
    const { list } = setup()
    await list.reload()
    const row = list.rows.value[3]
    const updated = await list.updateRow(row.id, INPUT, row.version)
    expect(updated.version).toBe(row.version + 1)
    expect(list.rows.value[3]).toEqual(updated)
  })

  it('409：別人先改過，列表換成最新內容，錯誤交給畫面處理', async () => {
    const { db, list } = setup()
    await list.reload()
    const row = list.rows.value[3]
    db.update(row.id, { ...INPUT, userName: 'Someone Else' }, row.version) // 另一個人
    await expect(
      list.updateRow(row.id, INPUT, row.version),
    ).rejects.toMatchObject({ status: 409 })
    expect(list.rows.value[3]).toMatchObject({
      userName: 'Someone Else',
      version: 2,
    })
    // 使用者選擇覆蓋：帶上最新版本再送一次
    await list.updateRow(row.id, INPUT, 2)
    expect(list.rows.value[3]).toMatchObject({ userName: 'Mawchu Test' })
  })

  it('404：資料已被別人刪除，更新或刪除時都會從列表拿掉', async () => {
    const { db, list } = setup()
    await list.reload()
    const [first, second] = list.rows.value
    db.remove(first.id)
    db.remove(second.id)
    await expect(
      list.updateRow(first.id, INPUT, first.version),
    ).rejects.toMatchObject({ status: 404 })
    await expect(list.removeRow(second.id)).rejects.toMatchObject({
      status: 404,
    })
    expect(
      list.rows.value.some((r) => r.id === first.id || r.id === second.id),
    ).toBe(false)
  })

  it('元件卸載時，進行中的請求會被取消', async () => {
    let aborted = 0
    const { list } = setup(3000, {
      latency: [30, 30],
      onAbort: () => aborted++,
    })
    void list.reload()
    scopes[0].stop()
    await wait(50)
    expect(aborted).toBe(1)
  })
})
