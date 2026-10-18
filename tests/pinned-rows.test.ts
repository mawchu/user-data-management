import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UserDb } from '../src/mock/db'
import { createDirectBackend } from '../src/mock/backend'
import { createMockFetch } from '../src/mock/server'
import { setTransport } from '../src/api/http'
import { useUserList } from '../src/composables/useUserList'
import { usePinnedRows } from '../src/composables/usePinnedRows'
import { placePins } from '../src/utils/placePins'
import type { User } from '../src/types/user'

const user = (id: number, age: number): User => ({
  id,
  age,
  userName: `U${id}`,
  position: 'P',
  location: 'L',
  dateStart: '2020-01-01',
  version: 1,
})
const ids = (rows: User[]) => rows.map((r) => r.id)

describe('placePins：把釘選列插進已載入的資料', () => {
  const all = [user(1, 48), user(2, 22), user(3, 65), user(4, 54), user(5, 52)]
  const pin4 = [{ row: all[3], position: 2 }]

  it('不論後端回傳哪種排序，#4 都在第 2 列', () => {
    const ascending = [...all].sort((a, b) => a.age - b.age)
    expect(ids(placePins(all, pin4, false))).toEqual([1, 4, 2, 3, 5])
    expect(ids(placePins(ascending, pin4, false))).toEqual([2, 4, 1, 5, 3])
    expect(ids(placePins(ascending.reverse(), pin4, false))).toEqual([
      3, 4, 5, 1, 2,
    ])
  })

  it('目標位置還沒載入時先不顯示；資料載完時排在最後', () => {
    const farPin = [{ row: all[0], position: 100 }]
    expect(ids(placePins(all.slice(1), farPin, true))).toEqual([2, 3, 4, 5])
    expect(ids(placePins(all.slice(1), farPin, false))).toEqual([2, 3, 4, 5, 1])
  })
})

describe('usePinnedRows', () => {
  const storage = new Map<string, string>()
  beforeEach(() => {
    storage.clear()
    globalThis.localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    } as Storage
  })
  afterEach(() => {
    // @ts-expect-error 測試結束後移除假的 localStorage
    delete globalThis.localStorage
  })

  function setup() {
    const db = new UserDb(2000)
    setTransport(createMockFetch(createDirectBackend(db)))
    const scope = effectScope()
    return scope.run(() => {
      const list = useUserList()
      return { db, list, pinned: usePinnedRows(list) }
    })!
  }

  it('釘選後不重新查詢，換排序後仍在指定位置，並存進 localStorage', async () => {
    const { list, pinned } = setup()
    await list.reload()
    const target = list.rows.value[300]
    const before = list.rows.value
    pinned.pin(target, 2)
    expect(list.rows.value).toBe(before) // 沒有重新查詢
    expect(pinned.displayRows.value[1].id).toBe(target.id)
    for (const key of ['age', 'userName', 'dateStart'] as const) {
      await list.setSort(key, 'desc')
      expect(pinned.displayRows.value[1].id).toBe(target.id)
      expect(
        pinned.displayRows.value.filter((r) => r.id === target.id),
      ).toHaveLength(1)
    }
    expect(JSON.parse(storage.get('user-data-admin:pins:v1')!)).toEqual([
      [target.id, 2],
    ])
  })

  it('同一個位置只能釘一筆；搜尋不符合的釘選列不顯示', async () => {
    const { list, pinned } = setup()
    await list.reload()
    const [a, b] = list.rows.value
    pinned.pin(a, 1)
    expect(() => pinned.pin(b, 1)).toThrow(`第 1 列已被 #${a.id} 釘選`)
    await list.search('zzz-no-match')
    expect(pinned.displayRows.value).toHaveLength(0)
  })

  it('重新開啟頁面：從後端取回最新資料；已被刪除的釘選自動移除', async () => {
    storage.set(
      'user-data-admin:pins:v1',
      JSON.stringify([
        [5, 1],
        [6, 2],
      ]),
    )
    const { db, list, pinned } = setup()
    db.remove(6)
    await Promise.all([list.reload(), pinned.restore()])
    expect(pinned.displayRows.value[0].id).toBe(5)
    expect([...pinned.pins.value]).toEqual([[5, 1]])
  })

  it('釘選列被編輯或刪除時同步', async () => {
    const { list, pinned } = setup()
    await list.reload()
    const target = list.rows.value[50]
    pinned.pin(target, 1)
    await list.updateRow(
      target.id,
      { ...target, userName: 'Renamed' },
      target.version,
    )
    expect(pinned.displayRows.value[0].userName).toBe('Renamed')
    await list.removeRow(target.id)
    expect(pinned.pins.value.size).toBe(0)
  })
})
