/**
 * 千萬筆使用者資料的記憶體資料庫（mock 後端）。
 *
 * 每個欄位存成一個 TypedArray（固定型別的數字陣列），字串欄位只存「字典編號」：
 * 例如 position 只有十幾種值，每列只要 1 byte 記它是第幾種。1,000 萬列約佔 70MB。
 * 因為每個欄位的不同值都不多，排序用 counting sort（計數排序，O(n)），不用一般比較排序。
 */
import type { PinInfo, SortKey, User, UserInput, UserListQuery, UserListResponse, UserRow } from '../types/user'
import { validateUserInput } from '../utils/validate'

export const MAX_LIMIT = 500

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message)
  }
}

const FIRST = ['Aaron', 'Abby', 'Adam', 'Alice', 'Amy', 'Andy', 'Angela', 'Ben', 'Bella', 'Brian', 'Carol', 'Chloe', 'Chris', 'Cindy', 'Daniel', 'David', 'Eason', 'Emma', 'Eric', 'Evan', 'Fiona', 'Frank', 'Grace', 'Gary', 'Hannah', 'Henry', 'Ian', 'Irene', 'Ivy', 'Jack', 'Jason', 'Jenny', 'Joyce', 'Kevin', 'Kelly', 'Leo', 'Lily', 'Mandy', 'Mark', 'Nina', 'Oscar', 'Peggy', 'Peter', 'Rachel', 'Ray', 'Sam', 'Sandy', 'Tina', 'Tom', 'Vivian']
const LAST = ['Chen', 'Lin', 'Huang', 'Chang', 'Lee', 'Wang', 'Wu', 'Liu', 'Tsai', 'Yang', 'Hsu', 'Cheng', 'Hsieh', 'Kuo', 'Hung', 'Tseng', 'Chiu', 'Liao', 'Lai', 'Chou', 'Yeh', 'Su', 'Chuang', 'Lu', 'Chiang', 'Ho', 'Lo', 'Kao', 'Hsiao', 'Pan']
const POSITIONS = ['Frontend Engineer', 'Backend Engineer', 'Full-stack Engineer', 'Product Manager', 'UI Designer', 'UX Researcher', 'QA Engineer', 'Data Analyst', 'DevOps Engineer', 'Customer Support', 'Marketing Specialist', 'HR Specialist']
const LOCATIONS = ['Taipei', 'New Taipei', 'Taoyuan', 'Hsinchu', 'Taichung', 'Tainan', 'Kaohsiung', 'Tokyo', 'Osaka', 'Singapore', 'Hong Kong', 'Seoul']

// 日期存成「1950-01-01 起算的天數」，Uint16 可表示到 2129 年
const EPOCH = Date.UTC(1950, 0, 1)
const DAY_MS = 86_400_000
const toDay = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - EPOCH) / DAY_MS)
const dayStrCache: string[] = []
function dayToStr(day: number): string {
  return (dayStrCache[day] ??= new Date(EPOCH + day * DAY_MS).toISOString().slice(0, 10))
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** 字串字典：字串 <-> 編號，並可算出每個編號的排序名次 */
class Dict {
  readonly values: string[] = []
  private index = new Map<string, number>()
  private rankCache: Uint32Array | null = null
  constructor(private readonly cap: number, initial: string[] = []) {
    initial.forEach((v) => this.add(v))
  }
  add(value: string): number {
    let id = this.index.get(value)
    if (id !== undefined) return id
    if (this.values.length >= this.cap) throw new ApiError(507, '此欄位的不同值已達 mock 上限')
    id = this.values.length
    this.values.push(value)
    this.index.set(value, id)
    this.rankCache = null
    return id
  }
  /** rank[編號] = 依字母排序後的名次 */
  rank(): Uint32Array {
    if (this.rankCache) return this.rankCache
    const order = this.values.map((_, i) => i).sort((a, b) => collator.compare(this.values[a], this.values[b]) || a - b)
    const rank = new Uint32Array(this.values.length)
    order.forEach((id, r) => (rank[id] = r))
    return (this.rankCache = rank)
  }
}

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

interface Snapshot {
  key: string
  keyword: string
  view: Uint32Array // 未釘選、符合條件的列索引，已排序
  length: number
  pins: PinInfo[] // 符合條件的釘選列，依位置排序
}

export class UserDb {
  readonly size: number
  private names = new Dict(0xffff)
  private positions = new Dict(0xff, POSITIONS)
  private locations = new Dict(0xff, LOCATIONS)
  private name: Uint16Array
  private pos: Uint8Array
  private loc: Uint8Array
  private age: Uint8Array
  private day: Uint16Array
  private deleted: Uint8Array
  private pinnedFlag: Uint8Array
  private pins = new Map<number, number>() // id -> 目標位置（1 起算）
  private liveCount: number
  private bufA: Uint32Array
  private bufB: Uint32Array | null = null
  private snapshot: Snapshot | null = null

  constructor(size = 10_000_000, seed = 20261017) {
    this.size = size
    this.liveCount = size
    this.name = new Uint16Array(size)
    this.pos = new Uint8Array(size)
    this.loc = new Uint8Array(size)
    this.age = new Uint8Array(size)
    this.day = new Uint16Array(size)
    this.deleted = new Uint8Array(size)
    this.pinnedFlag = new Uint8Array(size)
    this.bufA = new Uint32Array(size)

    for (const f of FIRST) for (const l of LAST) this.names.add(`${f} ${l}`)
    const rand = mulberry32(seed)
    const nNames = this.names.values.length
    const dayFrom = toDay('2010-01-01')
    const daySpan = toDay('2026-10-17') - dayFrom + 1
    for (let i = 0; i < size; i++) {
      this.name[i] = (rand() * nNames) | 0
      this.pos[i] = (rand() * POSITIONS.length) | 0
      this.loc[i] = (rand() * LOCATIONS.length) | 0
      this.age[i] = 20 + ((rand() * 46) | 0)
      this.day[i] = dayFrom + ((rand() * daySpan) | 0)
    }
  }

  get count() {
    return this.liveCount
  }

  /** GET /api/users */
  list(query: UserListQuery = {}): UserListResponse {
    const keyword = (query.q ?? '').trim().toLowerCase()
    const sortBy = query.sortBy ?? null
    const order = query.order === 'desc' ? 'desc' : 'asc'
    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? MAX_LIMIT)), MAX_LIMIT)
    const key = `${keyword}\u0000${sortBy}\u0000${sortBy ? order : ''}`

    let offset = 0
    if (query.cursor != null) {
      offset = Number(query.cursor)
      if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, 'cursor 格式錯誤')
    }
    // 第一批一律重算；之後的批次沿用同一份快照，資料才不會在捲動中跳動
    if (offset === 0 || this.snapshot?.key !== key) this.snapshot = this.build(key, keyword, sortBy, order)

    const snap = this.snapshot
    const total = snap.length + snap.pins.length
    const end = Math.min(offset + limit, total)
    const data: UserRow[] = []
    const eff = this.effectivePinPositions(snap)
    let j = 0
    while (j < eff.length && eff[j] < offset) j++
    let u = offset - j
    for (let k = offset; k < end; k++) {
      if (j < eff.length && eff[j] === k) {
        const pin = snap.pins[j++]
        data.push({ ...this.toUser(pin.id - 1), pinnedAt: pin.position })
      } else {
        data.push({ ...this.toUser(snap.view[u++]), pinnedAt: null })
      }
    }
    const hasMore = end < total
    return { data, nextCursor: hasMore ? String(end) : null, hasMore, total }
  }

  /** GET /api/users/:id */
  get(id: number): UserRow {
    const i = this.indexOf(id)
    return { ...this.toUser(i), pinnedAt: this.pins.get(id) ?? null }
  }

  /** PATCH /api/users/:id */
  update(id: number, input: UserInput): UserRow {
    const i = this.indexOf(id)
    const errors = validateUserInput(input)
    if (Object.keys(errors).length) throw new ApiError(422, '資料驗證失敗', errors)
    // 先把三個字典都加好，任何一個爆上限就整筆不改
    const n = this.names.add(input.userName.trim())
    const p = this.positions.add(input.position.trim())
    const l = this.locations.add(input.location.trim())
    this.name[i] = n
    this.pos[i] = p
    this.loc[i] = l
    this.age[i] = input.age
    this.day[i] = toDay(input.dateStart)
    // 已載入的快照不重排：使用者剛改的列留在原位，下次重新查詢才會依新值排序
    return this.get(id)
  }

  /** DELETE /api/users/:id */
  remove(id: number): void {
    const i = this.indexOf(id)
    this.deleted[i] = 1
    this.liveCount--
    const snap = this.snapshot
    if (this.pins.delete(id)) {
      this.pinnedFlag[i] = 0
      if (snap) snap.pins = snap.pins.filter((p) => p.id !== id)
    } else if (snap) {
      const at = snap.view.subarray(0, snap.length).indexOf(i)
      if (at >= 0) {
        snap.view.copyWithin(at, at + 1, snap.length)
        snap.length--
      }
    }
  }

  /** PUT /api/users/:id/pin */
  pin(id: number, position: number): UserRow {
    const i = this.indexOf(id)
    if (!Number.isInteger(position) || position < 1) throw new ApiError(422, '位置需為 1 以上的整數')
    for (const [otherId, p] of this.pins) {
      if (p === position && otherId !== id) throw new ApiError(409, `第 ${position} 列已被 #${otherId} 釘選`)
    }
    this.pins.set(id, position)
    this.pinnedFlag[i] = 1
    this.snapshot = null
    return this.get(id)
  }

  /** DELETE /api/users/:id/pin */
  unpin(id: number): UserRow {
    const i = this.indexOf(id)
    this.pins.delete(id)
    this.pinnedFlag[i] = 0
    this.snapshot = null
    return this.get(id)
  }

  /** GET /api/pins */
  listPins(): PinInfo[] {
    return [...this.pins].map(([id, position]) => ({ id, position })).sort((a, b) => a.position - b.position)
  }

  private indexOf(id: number): number {
    if (!Number.isInteger(id) || id < 1 || id > this.size || this.deleted[id - 1]) throw new ApiError(404, `找不到使用者 #${id}`)
    return id - 1
  }

  private toUser(i: number): User {
    return {
      id: i + 1,
      userName: this.names.values[this.name[i]],
      position: this.positions.values[this.pos[i]],
      location: this.locations.values[this.loc[i]],
      age: this.age[i],
      dateStart: dayToStr(this.day[i]),
    }
  }

  /**
   * 釘選列的實際位置（0 起算）。目標位置超過資料總數時，依序排在最後面。
   * 例：只剩 3 筆一般資料，釘在第 100 列的資料會出現在第 4 列。
   */
  private effectivePinPositions(snap: Snapshot): number[] {
    return snap.pins.map((p, i) => Math.min(p.position - 1, snap.length + i))
  }

  private build(key: string, keyword: string, sortBy: SortKey | null, order: 'asc' | 'desc'): Snapshot {
    const { size, deleted, pinnedFlag } = this
    let view = this.bufA
    let length = 0

    if (!keyword) {
      for (let i = 0; i < size; i++) if (!deleted[i] && !pinnedFlag[i]) view[length++] = i
    } else {
      // 先在「字典」上比對關鍵字（每欄只有幾十到幾千種值），再用查表掃 1,000 萬列
      const hit = (values: string[]) => Uint8Array.from(values, (v) => (v.toLowerCase().includes(keyword) ? 1 : 0))
      const nameHit = hit(this.names.values)
      const posHit = hit(this.positions.values)
      const locHit = hit(this.locations.values)
      const ageHit = Uint8Array.from({ length: 256 }, (_, a) => (String(a).includes(keyword) ? 1 : 0))
      const dayHit = this.dayHitTable(keyword)
      const { name, pos, loc, age, day } = this
      for (let i = 0; i < size; i++) {
        if (deleted[i] || pinnedFlag[i]) continue
        if (nameHit[name[i]] || posHit[pos[i]] || locHit[loc[i]] || ageHit[age[i]] || dayHit[day[i]]) view[length++] = i
      }
    }

    if (sortBy) view = this.countingSort(view, length, sortBy, order)

    const pins = this.listPins().filter((p) => !keyword || this.matches(p.id - 1, keyword))
    return { key, keyword, view, length, pins }
  }

  private dayHitTable(keyword: string): Uint8Array {
    const table = new Uint8Array(0x10000)
    if (!/^[\d-]+$/.test(keyword)) return table
    const { day, size } = this
    // 只算實際出現過的日期，避免格式化 65,536 個字串
    const seen = new Uint8Array(0x10000)
    for (let i = 0; i < size; i++) seen[day[i]] = 1
    for (let d = 0; d < 0x10000; d++) if (seen[d] && dayToStr(d).includes(keyword)) table[d] = 1
    return table
  }

  private matches(i: number, keyword: string): boolean {
    const u = this.toUser(i)
    return [u.userName, u.position, u.location, String(u.age), u.dateStart].some((v) => v.toLowerCase().includes(keyword))
  }

  /** 計數排序：穩定排序，同值時保持 id 由小到大 */
  private countingSort(src: Uint32Array, length: number, sortBy: SortKey, order: 'asc' | 'desc'): Uint32Array {
    let col: ArrayLike<number>
    let rank: ArrayLike<number> | null = null
    let buckets: number
    switch (sortBy) {
      case 'userName': col = this.name; rank = this.names.rank(); buckets = this.names.values.length; break
      case 'position': col = this.pos; rank = this.positions.rank(); buckets = this.positions.values.length; break
      case 'location': col = this.loc; rank = this.locations.rank(); buckets = this.locations.values.length; break
      case 'age': col = this.age; buckets = 256; break
      case 'dateStart': col = this.day; buckets = 0x10000; break
    }
    const keyOf = rank
      ? (i: number) => (order === 'asc' ? rank[col[i]] : buckets - 1 - rank[col[i]])
      : (i: number) => (order === 'asc' ? col[i] : buckets - 1 - col[i])
    const counts = new Uint32Array(buckets + 1)
    for (let k = 0; k < length; k++) counts[keyOf(src[k]) + 1]++
    for (let b = 0; b < buckets; b++) counts[b + 1] += counts[b]
    const dst = (this.bufB ??= new Uint32Array(this.size))
    for (let k = 0; k < length; k++) dst[counts[keyOf(src[k])]++] = src[k]
    // 交換兩個緩衝區，下次查詢重複使用，不必再配置 40MB
    this.bufB = src
    this.bufA = dst
    return dst
  }
}
