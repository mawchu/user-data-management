// 千萬筆效能量測：npm run perf（平常 npm test 會跳過）
import { describe, expect, it } from 'vitest'
import { UserDb } from '../src/mock/db'
import type { SortKey } from '../src/types/user'

const time = <T>(label: string, fn: () => T): T => {
  const t = performance.now()
  const r = fn()
  console.log(`${label.padEnd(32)} ${(performance.now() - t).toFixed(0).padStart(6)} ms`)
  return r
}

describe.skipIf(!process.env.PERF)('10,000,000 筆效能', () => {
  it('產生、查詢、排序、搜尋、釘選', () => {
    const db = time('產生 10,000,000 筆', () => new UserDb())
    const first = time('第一批（無排序）', () => db.list())
    expect(first.total).toBe(10_000_000)
    time('下一批（沿用快照）', () => db.list({ cursor: first.nextCursor }))
    for (const sortBy of ['userName', 'position', 'location', 'age', 'dateStart'] as SortKey[]) {
      time(`排序 ${sortBy} desc`, () => db.list({ sortBy, order: 'desc' }))
    }
    for (const q of ['chen', 'engineer', '42', '2015-03']) {
      const r = time(`搜尋 "${q}"`, () => db.list({ q, sortBy: 'age' }))
      console.log(`  → 符合 ${r.total.toLocaleString()} 筆`)
    }
    db.pin(9_999_999, 1)
    const pinned = time('釘選後重新查詢（排序 age）', () => db.list({ sortBy: 'age' }))
    expect(pinned.data[0].id).toBe(9_999_999)
    time('刪除一筆（含更新快照）', () => db.remove(pinned.data[5].id))
    time('最後一批', () => db.list({ sortBy: 'age', cursor: String(db.count - 100) }))
    console.log(`記憶體 heapUsed+arrayBuffers ≈ ${((process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers) / 1e6).toFixed(0)} MB`)
  }, 120_000)
})
