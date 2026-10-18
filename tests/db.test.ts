import { describe, expect, it } from 'vitest'
import { ApiError, UserDb } from '../src/mock/db'
import type { SortKey, User, UserListQuery, UserRow } from '../src/types/user'

const SORT_KEYS: SortKey[] = [
  'userName',
  'position',
  'location',
  'age',
  'dateStart',
]
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** 把所有批次接起來，模擬使用者一路捲到底 */
function loadAll(db: UserDb, query: Omit<UserListQuery, 'cursor'>): UserRow[] {
  const rows: UserRow[] = []
  let cursor: string | null = null
  do {
    const res = db.list({ ...query, cursor })
    rows.push(...res.data)
    cursor = res.nextCursor
  } while (cursor)
  return rows
}

/** 用最直白的方式算出「應該」的結果，拿來對照 */
function reference(
  all: User[],
  q: string,
  sortBy: SortKey | null,
  order: 'asc' | 'desc',
): number[] {
  const kw = q.trim().toLowerCase()
  const rows = all.filter(
    (u) =>
      !kw ||
      [u.userName, u.position, u.location, String(u.age), u.dateStart].some(
        (v) => v.toLowerCase().includes(kw),
      ),
  )
  if (sortBy) {
    const dir = order === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      const va = a[sortBy],
        vb = b[sortBy]
      const c =
        typeof va === 'number'
          ? va - (vb as number)
          : collator.compare(va, vb as string)
      return c * dir || a.id - b.id
    })
  }
  return rows.map((u) => u.id)
}

function allUsers(db: UserDb): User[] {
  return loadAll(db, {}).map(({ pinnedAt, ...u }) => u)
}

describe('UserDb', () => {
  it('分批載入：每批最多 500 筆，接起來剛好是全部資料且不重複', () => {
    const db = new UserDb(1234)
    const first = db.list({ limit: 9999 })
    expect(first.data).toHaveLength(500)
    expect(first.nextCursor).toBe('500')
    const ids = loadAll(db, {}).map((r) => r.id)
    expect(ids).toHaveLength(1234)
    expect(new Set(ids).size).toBe(1234)
    expect(ids[0]).toBe(1)
  })

  it('資料型別：age 是整數、dateStart 是 YYYY-MM-DD', () => {
    const db = new UserDb(2000)
    for (const u of allUsers(db)) {
      expect(Number.isInteger(u.age)).toBe(true)
      expect(u.dateStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof u.userName).toBe('string')
    }
  })

  it.each(
    SORT_KEYS.flatMap(
      (k) =>
        [
          [k, 'asc'],
          [k, 'desc'],
        ] as const,
    ),
  )('排序 %s %s 與參考實作一致', (sortBy, order) => {
    const db = new UserDb(3000)
    const expected = reference(allUsers(db), '', sortBy, order)
    expect(loadAll(db, { sortBy, order }).map((r) => r.id)).toEqual(expected)
  })

  it.each(['chen', 'ENGINEER', 'tai', '42', '2015-03', '-12-', 'zzz-no-match'])(
    '搜尋 "%s" 與參考實作一致',
    (q) => {
      const db = new UserDb(3000)
      const all = allUsers(db)
      expect(loadAll(db, { q }).map((r) => r.id)).toEqual(
        reference(all, q, null, 'asc'),
      )
      expect(
        loadAll(db, { q, sortBy: 'age', order: 'desc' }).map((r) => r.id),
      ).toEqual(reference(all, q, 'age', 'desc'))
    },
  )

  it('釘選：不論怎麼排序，釘選列都在指定位置', () => {
    const db = new UserDb(3000)
    db.pin(2500, 1)
    db.pin(10, 3)
    db.pin(777, 600) // 在第二批
    for (const sortBy of [null, ...SORT_KEYS]) {
      for (const order of ['asc', 'desc'] as const) {
        const rows = loadAll(db, { sortBy, order })
        expect(rows).toHaveLength(3000)
        expect(rows[0].id).toBe(2500)
        expect(rows[2].id).toBe(10)
        expect(rows[599].id).toBe(777)
        expect(rows[599].pinnedAt).toBe(600)
        // 其餘資料仍依排序規則
        const rest = rows.filter((r) => r.pinnedAt === null).map((r) => r.id)
        const expected = reference(
          allUsers(new UserDb(3000)),
          '',
          sortBy,
          order,
        ).filter((id) => ![2500, 10, 777].includes(id))
        expect(rest).toEqual(expected)
      }
    }
  })

  it('釘選位置超過資料量時排在最後；搜尋不符合的釘選列不顯示', () => {
    const db = new UserDb(3000)
    const target = db.get(5)
    db.pin(5, 2)
    db.pin(6, 99999)
    const all = loadAll(db, {})
    expect(all.at(-1)!.id).toBe(6)
    const q = target.userName.toLowerCase()
    const filtered = loadAll(db, { q })
    expect(filtered[1].id).toBe(5)
    const sixMatches = [
      db.get(6).userName,
      db.get(6).position,
      db.get(6).location,
      String(db.get(6).age),
      db.get(6).dateStart,
    ].some((v) => v.toLowerCase().includes(q))
    expect(filtered.some((r) => r.id === 6)).toBe(sixMatches)
  })

  it('同一位置不能釘兩筆；取消釘選後回到排序位置', () => {
    const db = new UserDb(1000)
    db.pin(1, 5)
    expect(() => db.pin(2, 5)).toThrow(ApiError)
    db.unpin(1)
    expect(loadAll(db, {})[0].id).toBe(1)
    expect(db.listPins()).toEqual([])
  })

  it('刪除：資料消失、總數減少，已載入的捲動批次不會跳號或重複', () => {
    const db = new UserDb(1200)
    const first = db.list({ sortBy: 'age' })
    const victim = first.data[10].id
    db.remove(victim)
    // 前端把被刪的列從畫面移除後，已載入 499 筆，下一批從 499 接著拿
    const rest: UserRow[] = []
    let cursor: string | null = String(first.data.length - 1)
    while (cursor) {
      const res = db.list({ sortBy: 'age', cursor })
      rest.push(...res.data)
      cursor = res.nextCursor
    }
    const ids = [...first.data.filter((r) => r.id !== victim), ...rest].map(
      (r) => r.id,
    )
    expect(ids).toEqual(reference(allUsers(db), '', 'age', 'asc'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(1199)
    expect(db.count).toBe(1199)
    expect(() => db.get(victim)).toThrow(/找不到/)
    expect(loadAll(db, {}).some((r) => r.id === victim)).toBe(false)
  })

  it('刪除釘選列時一併移除釘選', () => {
    const db = new UserDb(1000)
    db.pin(3, 1)
    db.remove(3)
    expect(db.listPins()).toEqual([])
    expect(loadAll(db, {})).toHaveLength(999)
  })

  it('更新：驗證欄位，成功後可被搜尋、重新排序時位置正確', () => {
    const db = new UserDb(1000)
    expect(() =>
      db.update(1, {
        userName: '',
        position: 'x',
        location: 'y',
        age: 30.5,
        dateStart: '2024-02-30',
      }),
    ).toThrow(ApiError)
    try {
      db.update(1, {
        userName: '',
        position: 'x',
        location: 'y',
        age: 30.5,
        dateStart: '2024-02-30',
      })
    } catch (e) {
      expect((e as ApiError).details).toMatchObject({
        userName: '必填',
        age: '請輸入整數',
      })
      expect((e as ApiError).details).toHaveProperty('dateStart')
    }
    const updated = db.update(42, {
      userName: '  Mawchu Test ',
      position: 'Tech Lead',
      location: 'Remote',
      age: 99,
      dateStart: '2026-10-17',
    })
    expect(updated).toMatchObject({
      id: 42,
      userName: 'Mawchu Test',
      position: 'Tech Lead',
      age: 99,
    })
    expect(loadAll(db, { q: 'mawchu' }).map((r) => r.id)).toEqual([42])
    expect(loadAll(db, { sortBy: 'age', order: 'desc' })[0].id).toBe(42)
    expect(loadAll(db, { sortBy: 'dateStart', order: 'desc' })[0].id).toBe(42)
  })

  it('錯誤：不存在的 id 回 404，cursor 格式錯誤回 400', () => {
    const db = new UserDb(100)
    expect(() => db.get(101)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => db.list({ cursor: 'abc' })).toThrow(
      expect.objectContaining({ status: 400 }),
    )
  })
})
