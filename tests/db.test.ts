import { describe, expect, it } from 'vitest'
import { ApiError, UserDb } from '../src/mock/db'
import type { SortKey, User, UserListQuery } from '../src/types/user'
import { matchesKeyword, normalizeKeyword } from '../src/utils/match'

const SORT_KEYS: SortKey[] = [
  'userName',
  'position',
  'location',
  'age',
  'dateStart',
]
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** 把所有批次接起來，模擬使用者一路捲到底 */
function loadAll(db: UserDb, query: Omit<UserListQuery, 'cursor'>): User[] {
  const rows: User[] = []
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
  const kw = normalizeKeyword(q)
  const rows = all.filter((u) => matchesKeyword(u, kw))
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

const allUsers = (db: UserDb): User[] => loadAll(db, {})

const INPUT = {
  userName: 'Mawchu Test',
  position: 'Tech Lead',
  location: 'Remote',
  age: 99,
  dateStart: '2026-10-17',
}

describe('UserDb', () => {
  it('分批載入：每批最多 500 筆，接起來剛好是全部資料且不重複', () => {
    const db = new UserDb(1234)
    const first = db.list({ limit: 9999 })
    expect(first.data).toHaveLength(500)
    const ids = loadAll(db, {}).map((r) => r.id)
    expect(ids).toHaveLength(1234)
    expect(new Set(ids).size).toBe(1234)
    expect(ids[0]).toBe(1)
  })

  it('資料型別：age 是整數、dateStart 是 YYYY-MM-DD、version 從 1 開始', () => {
    const db = new UserDb(2000)
    for (const u of allUsers(db)) {
      expect(Number.isInteger(u.age)).toBe(true)
      expect(u.dateStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof u.userName).toBe('string')
      expect(u.version).toBe(1)
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

  it('keyset cursor：捲動途中刪除已載入或未載入的資料，都不會漏掉或重複', () => {
    const db = new UserDb(1500)
    const query = { sortBy: 'age', order: 'desc' } as const
    const first = db.list(query)
    // 刪掉已載入的一筆、還沒載入的一筆、以及上一批的最後一筆（cursor 指向的那筆）
    const removed = [first.data[10].id, first.data[499].id]
    const notYet = reference(allUsers(db), '', 'age', 'desc')[800]
    removed.push(notYet)
    removed.forEach((id) => db.remove(id))
    const rest: User[] = []
    let cursor = first.nextCursor
    while (cursor) {
      const res = db.list({ ...query, cursor })
      rest.push(...res.data)
      cursor = res.nextCursor
    }
    const ids = [
      ...first.data.filter((r) => !removed.includes(r.id)),
      ...rest,
    ].map((r) => r.id)
    expect(ids).toEqual(reference(allUsers(db), '', 'age', 'desc'))
    expect(ids).toHaveLength(1497)
    expect(db.list(query).total).toBe(1497)
  })

  it('多人：別人的查詢重建了快照，我的下一批仍然接得上', () => {
    const db = new UserDb(1500)
    const mine = db.list({ sortBy: 'userName' })
    db.list({ q: 'chen', sortBy: 'age' }) // 另一個人查詢，快照被換掉
    const next = db.list({ sortBy: 'userName', cursor: mine.nextCursor })
    const expected = reference(allUsers(db), '', 'userName', 'asc')
    expect([...mine.data, ...next.data].map((r) => r.id)).toEqual(
      expected.slice(0, 1000),
    )
  })

  it('新增：取得新 id，之後的查詢可以搜尋、排序到它；超過容量會自動擴充', () => {
    const db = new UserDb(20)
    const created = Array.from({ length: 30 }, (_, i) =>
      db.create({ ...INPUT, age: 16 + i }),
    )
    expect(created[0]).toMatchObject({ id: 21, version: 1, age: 16 })
    expect(db.count).toBe(50)
    expect(loadAll(db, { q: 'mawchu' }).map((r) => r.id)).toEqual(
      created.map((r) => r.id),
    )
    expect(loadAll(db, { sortBy: 'age' })[0].id).toBe(21)
    expect(() => db.create({ ...INPUT, userName: '' })).toThrow(
      expect.objectContaining({ status: 422 }),
    )
  })

  it('更新：驗證欄位；版本號不同時回 409 並附上目前的資料', () => {
    const db = new UserDb(1000)
    try {
      db.update(1, {
        ...INPUT,
        userName: '',
        age: 30.5,
        dateStart: '2024-02-30',
      })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).details).toMatchObject({
        userName: '必填',
        age: '請輸入整數',
      })
    }
    const updated = db.update(42, { ...INPUT, userName: '  Mawchu Test ' }, 1)
    expect(updated).toMatchObject({
      id: 42,
      userName: 'Mawchu Test',
      version: 2,
    })
    // 另一個人拿著舊版本（1）更新
    try {
      db.update(42, { ...INPUT, age: 50 }, 1)
      expect.unreachable()
    } catch (e) {
      expect((e as ApiError).status).toBe(409)
      expect((e as ApiError).details).toMatchObject({
        current: { id: 42, version: 2, age: 99 },
      })
    }
    expect(loadAll(db, { q: 'mawchu' }).map((r) => r.id)).toEqual([42])
    expect(loadAll(db, { sortBy: 'age', order: 'desc' })[0].id).toBe(42)
  })

  it('刪除：資料消失、總數減少，再刪一次回 404', () => {
    const db = new UserDb(100)
    db.remove(5)
    expect(db.count).toBe(99)
    expect(() => db.get(5)).toThrow(/找不到/)
    expect(() => db.remove(5)).toThrow(expect.objectContaining({ status: 404 }))
    expect(loadAll(db, {}).some((r) => r.id === 5)).toBe(false)
  })

  it('錯誤：不存在的 id 回 404，cursor 格式錯誤回 400', () => {
    const db = new UserDb(100)
    expect(() => db.get(101)).toThrow(expect.objectContaining({ status: 404 }))
    expect(() => db.list({ cursor: 'abc' })).toThrow(
      expect.objectContaining({ status: 400 }),
    )
  })
})
