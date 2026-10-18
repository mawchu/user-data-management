/**
 * 千萬筆使用者資料的記憶體資料庫（mock 後端）。
 *
 * 每個欄位存成一個 TypedArray（固定型別的數字陣列），字串欄位只存「字典編號」：
 * 例如 position 只有十幾種值，每列只要 1 byte 記它是第幾種。1,000 萬列約佔 70MB。
 * 因為每個欄位的不同值都不多，排序用 counting sort（計數排序，O(n)），不用一般比較排序。
 *
 * 這裡只是讓前端能在接近題目的資料量下測試的 mock 後端，不是這份作業的重點。
 * 對外的行為（API 契約）寫在 docs/api.md。
 */
import type {
  SortKey,
  SortOrder,
  User,
  UserInput,
  UserListQuery,
  UserListResponse,
} from '../types/user'
import { validateUserInput } from '../utils/validate'
import { matchesKeyword, normalizeKeyword } from '../utils/match'

export const MAX_LIMIT = 500

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

const FIRST_NAMES = [
  'Aaron',
  'Abby',
  'Adam',
  'Alice',
  'Amy',
  'Andy',
  'Angela',
  'Ben',
  'Bella',
  'Brian',
  'Carol',
  'Chloe',
  'Chris',
  'Cindy',
  'Daniel',
  'David',
  'Eason',
  'Emma',
  'Eric',
  'Evan',
  'Fiona',
  'Frank',
  'Grace',
  'Gary',
  'Hannah',
  'Henry',
  'Ian',
  'Irene',
  'Ivy',
  'Jack',
  'Jason',
  'Jenny',
  'Joyce',
  'Kevin',
  'Kelly',
  'Leo',
  'Lily',
  'Mandy',
  'Mark',
  'Nina',
  'Oscar',
  'Peggy',
  'Peter',
  'Rachel',
  'Ray',
  'Sam',
  'Sandy',
  'Tina',
  'Tom',
  'Vivian',
]
const LAST_NAMES = [
  'Chen',
  'Lin',
  'Huang',
  'Chang',
  'Lee',
  'Wang',
  'Wu',
  'Liu',
  'Tsai',
  'Yang',
  'Hsu',
  'Cheng',
  'Hsieh',
  'Kuo',
  'Hung',
  'Tseng',
  'Chiu',
  'Liao',
  'Lai',
  'Chou',
  'Yeh',
  'Su',
  'Chuang',
  'Lu',
  'Chiang',
  'Ho',
  'Lo',
  'Kao',
  'Hsiao',
  'Pan',
]
const POSITIONS = [
  'Frontend Engineer',
  'Backend Engineer',
  'Full-stack Engineer',
  'Product Manager',
  'UI Designer',
  'UX Researcher',
  'QA Engineer',
  'Data Analyst',
  'DevOps Engineer',
  'Customer Support',
  'Marketing Specialist',
  'HR Specialist',
]
const LOCATIONS = [
  'Taipei',
  'New Taipei',
  'Taoyuan',
  'Hsinchu',
  'Taichung',
  'Tainan',
  'Kaohsiung',
  'Tokyo',
  'Osaka',
  'Singapore',
  'Hong Kong',
  'Seoul',
]

// 日期存成「1950-01-01 起算的天數」，Uint16 可表示到 2129 年
const EPOCH = Date.UTC(1950, 0, 1)
const DAY_MS = 86_400_000
const toDay = (iso: string) =>
  Math.round((Date.parse(`${iso}T00:00:00Z`) - EPOCH) / DAY_MS)
const dateStringCache: string[] = []
function dayToDateString(day: number): string {
  return (dateStringCache[day] ??= new Date(EPOCH + day * DAY_MS)
    .toISOString()
    .slice(0, 10))
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** 字串字典：字串 <-> 編號，並可算出每個編號的排序名次 */
class Dict {
  readonly values: string[] = []
  private index = new Map<string, number>()
  private rankCache: Uint32Array | null = null
  constructor(
    private readonly cap: number,
    initial: string[] = [],
  ) {
    initial.forEach((value) => this.add(value))
  }
  add(value: string): number {
    let id = this.index.get(value)
    if (id !== undefined) return id
    if (this.values.length >= this.cap)
      throw new ApiError(507, '此欄位的不同值已達 mock 上限')
    id = this.values.length
    this.values.push(value)
    this.index.set(value, id)
    this.rankCache = null
    return id
  }
  /** rank[編號] = 依字母排序後的名次 */
  rank(): Uint32Array {
    if (this.rankCache) return this.rankCache
    const idsInOrder = this.values
      .map((_, id) => id)
      .sort(
        (idA, idB) =>
          collator.compare(this.values[idA], this.values[idB]) || idA - idB,
      )
    const rank = new Uint32Array(this.values.length)
    idsInOrder.forEach((id, position) => (rank[id] = position))
    return (this.rankCache = rank)
  }
}

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

interface Snapshot {
  key: string
  keyword: string
  sortBy: SortKey | null
  order: SortOrder
  /** 符合條件的列索引，已排序（建立後才刪除的列仍在裡面，輸出時跳過） */
  view: Uint32Array
  /** 建立快照當下每列的排序欄位值（字串欄位是字典編號），之後有人修改也不影響二分搜尋 */
  codes: Uint32Array | null
  /** 建立快照當下字串欄位的名次表 */
  rank: Uint32Array | null
  length: number
  /** 建立快照當下的列數，之後新增的列不在快照裡 */
  builtRowCount: number
  /** 建立後被刪除、且原本在快照裡的列數 */
  removed: number
}

/** cursor 內容：上一批最後一筆的排序值與 id。前端只原樣帶回，不解析 */
interface CursorData {
  code: number
  id: number
}

const SORT_KEYS: SortKey[] = [
  'userName',
  'position',
  'location',
  'age',
  'dateStart',
]

export class UserDb {
  private names = new Dict(0xffff)
  private positions = new Dict(0xff, POSITIONS)
  private locations = new Dict(0xff, LOCATIONS)
  // 每個欄位一條陣列，第 rowIndex 格就是第 rowIndex 列的值（字串欄位存字典編號）。id = rowIndex + 1
  private nameIds: Uint16Array
  private positionIds: Uint8Array
  private locationIds: Uint8Array
  private ages: Uint8Array
  private startDays: Uint16Array // 1950-01-01 起算的天數
  private versions: Uint32Array
  private deleted: Uint8Array
  /** 已使用的列數（含已刪除）；下一筆新增的 id = rowCount + 1 */
  private rowCount: number
  private liveCount: number
  private bufferA: Uint32Array
  private bufferB: Uint32Array | null = null
  private codeBuffer: Uint32Array | null = null
  private snapshot: Snapshot | null = null

  constructor(size = 10_000_000, seed = 20261017) {
    this.rowCount = size
    this.liveCount = size
    const capacity = Math.max(size, 16)
    this.nameIds = new Uint16Array(capacity)
    this.positionIds = new Uint8Array(capacity)
    this.locationIds = new Uint8Array(capacity)
    this.ages = new Uint8Array(capacity)
    this.startDays = new Uint16Array(capacity)
    this.versions = new Uint32Array(capacity).fill(1)
    this.deleted = new Uint8Array(capacity)
    this.bufferA = new Uint32Array(capacity)

    for (const firstName of FIRST_NAMES)
      for (const lastName of LAST_NAMES)
        this.names.add(`${firstName} ${lastName}`)
    const random = mulberry32(seed)
    const nameCount = this.names.values.length
    const dayFrom = toDay('2010-01-01')
    const daySpan = toDay('2026-10-17') - dayFrom + 1
    for (let rowIndex = 0; rowIndex < size; rowIndex++) {
      this.nameIds[rowIndex] = (random() * nameCount) | 0
      this.positionIds[rowIndex] = (random() * POSITIONS.length) | 0
      this.locationIds[rowIndex] = (random() * LOCATIONS.length) | 0
      this.ages[rowIndex] = 20 + ((random() * 46) | 0)
      this.startDays[rowIndex] = dayFrom + ((random() * daySpan) | 0)
    }
  }

  get count() {
    return this.liveCount
  }

  /**
   * GET /api/users
   * cursor 是「上一批最後一筆的排序值 + id」（keyset）。下一批從排在它後面的第一筆開始，
   * 所以中途有人新增、刪除，或快照被別人的查詢重建，都不會漏掉或重複。
   */
  list(query: UserListQuery = {}): UserListResponse {
    const keyword = normalizeKeyword(query.q ?? '')
    const sortBy =
      query.sortBy && SORT_KEYS.includes(query.sortBy) ? query.sortBy : null
    const order: SortOrder = query.order === 'desc' ? 'desc' : 'asc'
    const limit = Math.min(
      Math.max(1, Math.trunc(query.limit ?? MAX_LIMIT)),
      MAX_LIMIT,
    )
    const key = `${keyword}\u0000${sortBy}\u0000${sortBy ? order : ''}`
    const cursor = query.cursor == null ? null : this.parseCursor(query.cursor)

    // 第一批一律重算；之後的批次沿用快照。字典在建立後新增過值時也要重算，名次才對得上
    if (
      !cursor ||
      this.snapshot?.key !== key ||
      (this.snapshot.rank && cursor.code >= this.snapshot.rank.length)
    )
      this.snapshot = this.build(key, keyword, sortBy, order)
    const snapshot = this.snapshot

    let position = cursor ? this.positionAfter(snapshot, cursor) : 0
    const data: User[] = []
    let last = -1
    for (; position < snapshot.length && data.length < limit; position++) {
      const rowIndex = snapshot.view[position]
      if (this.deleted[rowIndex]) continue
      data.push(this.toUser(rowIndex))
      last = position
    }
    while (position < snapshot.length && this.deleted[snapshot.view[position]])
      position++
    const hasMore = position < snapshot.length
    return {
      data,
      nextCursor: hasMore ? this.makeCursor(snapshot, last) : null,
      hasMore,
      total: snapshot.length - snapshot.removed,
    }
  }

  /** GET /api/users/:id */
  get(id: number): User {
    return this.toUser(this.indexOf(id))
  }

  /** POST /api/users */
  create(input: UserInput): User {
    this.validate(input)
    const rowIndex = this.rowCount
    if (rowIndex >= this.ages.length) this.grow(this.ages.length * 2)
    this.write(rowIndex, input)
    this.versions[rowIndex] = 1
    this.rowCount++
    this.liveCount++
    return this.toUser(rowIndex)
  }

  /**
   * PATCH /api/users/:id
   * 帶了 version 時，和目前版本不同就回 409，避免默默蓋掉別人剛改的內容。
   */
  update(id: number, input: UserInput, version?: number): User {
    const rowIndex = this.indexOf(id)
    if (version !== undefined && version !== this.versions[rowIndex])
      throw new ApiError(409, '這筆資料已被其他人修改', {
        current: this.toUser(rowIndex),
      })
    this.validate(input)
    this.write(rowIndex, input)
    this.versions[rowIndex]++
    // 已載入的快照不重排：剛改的列留在原位，下次重新查詢才會依新值排序
    return this.toUser(rowIndex)
  }

  /** DELETE /api/users/:id */
  remove(id: number): void {
    const rowIndex = this.indexOf(id)
    const snapshot = this.snapshot
    if (
      snapshot &&
      rowIndex < snapshot.builtRowCount &&
      this.matches(rowIndex, snapshot.keyword)
    )
      snapshot.removed++
    this.deleted[rowIndex] = 1
    this.liveCount--
  }

  private validate(input: UserInput) {
    const errors = validateUserInput(input)
    if (Object.keys(errors).length)
      throw new ApiError(422, '資料驗證失敗', errors)
  }

  private write(rowIndex: number, input: UserInput) {
    // 先把三個字典都加好，任何一個爆上限就整筆不改
    const nameId = this.names.add(input.userName.trim())
    const positionId = this.positions.add(input.position.trim())
    const locationId = this.locations.add(input.location.trim())
    this.nameIds[rowIndex] = nameId
    this.positionIds[rowIndex] = positionId
    this.locationIds[rowIndex] = locationId
    this.ages[rowIndex] = input.age
    this.startDays[rowIndex] = toDay(input.dateStart)
  }

  /** 新增資料時容量不夠：配置更大的陣列再複製 */
  private grow(capacity: number) {
    const copy = <T extends { length: number; set(array: T): void }>(
      array: T,
      make: (length: number) => T,
    ) => {
      const next = make(capacity)
      next.set(array)
      return next
    }
    this.nameIds = copy(this.nameIds, (n) => new Uint16Array(n))
    this.positionIds = copy(this.positionIds, (n) => new Uint8Array(n))
    this.locationIds = copy(this.locationIds, (n) => new Uint8Array(n))
    this.ages = copy(this.ages, (n) => new Uint8Array(n))
    this.startDays = copy(this.startDays, (n) => new Uint16Array(n))
    this.versions = copy(this.versions, (n) => new Uint32Array(n))
    this.deleted = copy(this.deleted, (n) => new Uint8Array(n))
    this.bufferA = new Uint32Array(capacity)
    this.bufferB = null
    this.codeBuffer = null
    this.snapshot = null
  }

  private indexOf(id: number): number {
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      id > this.rowCount ||
      this.deleted[id - 1]
    )
      throw new ApiError(404, `找不到使用者 #${id}`)
    return id - 1
  }

  private toUser(rowIndex: number): User {
    return {
      id: rowIndex + 1,
      userName: this.names.values[this.nameIds[rowIndex]],
      position: this.positions.values[this.positionIds[rowIndex]],
      location: this.locations.values[this.locationIds[rowIndex]],
      age: this.ages[rowIndex],
      dateStart: dayToDateString(this.startDays[rowIndex]),
      version: this.versions[rowIndex],
    }
  }

  private parseCursor(cursor: string): CursorData {
    const [code, id] = cursor.split('.').map(Number)
    if (!Number.isInteger(code) || !Number.isInteger(id) || id < 1)
      throw new ApiError(400, 'cursor 格式錯誤')
    return { code, id }
  }

  private makeCursor(snapshot: Snapshot, position: number): string {
    const rowIndex = snapshot.view[position]
    const code = snapshot.codes ? snapshot.codes[position] : 0
    return `${code}.${rowIndex + 1}`
  }

  /** 排序用的比較值：快照依「比較值由小到大、同值時 id 由小到大」排列 */
  private sortValue(snapshot: Snapshot, code: number): number {
    const value = snapshot.rank ? snapshot.rank[code] : code
    if (snapshot.order === 'asc') return value
    const buckets = snapshot.rank
      ? snapshot.rank.length
      : this.buckets(snapshot.sortBy!)
    return buckets - 1 - value
  }

  /** 二分搜尋：快照中第一個排在 cursor 後面的位置 */
  private positionAfter(snapshot: Snapshot, cursor: CursorData): number {
    const target = snapshot.codes ? this.sortValue(snapshot, cursor.code) : 0
    const targetRow = cursor.id - 1
    let low = 0
    let high = snapshot.length
    while (low < high) {
      const middle = (low + high) >>> 1
      const value = snapshot.codes
        ? this.sortValue(snapshot, snapshot.codes[middle])
        : 0
      const isAfter =
        value > target ||
        (value === target && snapshot.view[middle] > targetRow)
      if (isAfter) high = middle
      else low = middle + 1
    }
    return low
  }

  private buckets(sortBy: SortKey): number {
    return sortBy === 'age' ? 256 : 0x10000
  }

  private build(
    key: string,
    keyword: string,
    sortBy: SortKey | null,
    order: SortOrder,
  ): Snapshot {
    const { rowCount, deleted } = this
    let view = this.bufferA
    let length = 0

    if (!keyword) {
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex++)
        if (!deleted[rowIndex]) view[length++] = rowIndex
    } else {
      // 先在「字典」上比對關鍵字（每欄只有幾十到幾千種值），再用查表掃 1,000 萬列
      const matchTable = (values: string[]) =>
        Uint8Array.from(values, (value) =>
          value.toLowerCase().includes(keyword) ? 1 : 0,
        )
      const nameHit = matchTable(this.names.values)
      const positionHit = matchTable(this.positions.values)
      const locationHit = matchTable(this.locations.values)
      const ageHit = Uint8Array.from({ length: 256 }, (_, ageValue) =>
        String(ageValue).includes(keyword) ? 1 : 0,
      )
      const dayHit = this.dayHitTable(keyword)
      const { nameIds, positionIds, locationIds, ages, startDays } = this
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
        if (deleted[rowIndex]) continue
        if (
          nameHit[nameIds[rowIndex]] ||
          positionHit[positionIds[rowIndex]] ||
          locationHit[locationIds[rowIndex]] ||
          ageHit[ages[rowIndex]] ||
          dayHit[startDays[rowIndex]]
        )
          view[length++] = rowIndex
      }
    }

    let codes: Uint32Array | null = null
    let rank: Uint32Array | null = null
    if (sortBy) {
      const sorted = this.countingSort(view, length, sortBy, order)
      view = sorted.view
      rank = sorted.rank
      const column = this.column(sortBy)
      codes = this.codeBuffer ??= new Uint32Array(this.bufferA.length)
      for (let position = 0; position < length; position++)
        codes[position] = column[view[position]]
    }
    return {
      key,
      keyword,
      sortBy,
      order,
      view,
      codes,
      rank,
      length,
      builtRowCount: rowCount,
      removed: 0,
    }
  }

  private column(sortBy: SortKey): ArrayLike<number> {
    switch (sortBy) {
      case 'userName':
        return this.nameIds
      case 'position':
        return this.positionIds
      case 'location':
        return this.locationIds
      case 'age':
        return this.ages
      case 'dateStart':
        return this.startDays
    }
  }

  private dayHitTable(keyword: string): Uint8Array {
    const table = new Uint8Array(0x10000)
    if (!/^[\d-]+$/.test(keyword)) return table
    const { startDays, rowCount } = this
    // 只算實際出現過的日期，避免格式化 65,536 個字串
    const seen = new Uint8Array(0x10000)
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++)
      seen[startDays[rowIndex]] = 1
    for (let day = 0; day < 0x10000; day++)
      if (seen[day] && dayToDateString(day).includes(keyword)) table[day] = 1
    return table
  }

  private matches(rowIndex: number, keyword: string): boolean {
    return matchesKeyword(this.toUser(rowIndex), keyword)
  }

  /** 計數排序：穩定排序，同值時保持 id 由小到大 */
  private countingSort(
    source: Uint32Array,
    length: number,
    sortBy: SortKey,
    order: SortOrder,
  ): { view: Uint32Array; rank: Uint32Array | null } {
    const column = this.column(sortBy)
    let rank: Uint32Array | null = null
    let buckets: number
    if (sortBy === 'userName') rank = this.names.rank()
    else if (sortBy === 'position') rank = this.positions.rank()
    else if (sortBy === 'location') rank = this.locations.rank()
    if (rank) buckets = rank.length
    else buckets = this.buckets(sortBy)
    const keyOf = (rowIndex: number) => {
      const value = rank ? rank[column[rowIndex]] : column[rowIndex]
      return order === 'asc' ? value : buckets - 1 - value
    }
    const counts = new Uint32Array(buckets + 1)
    for (let position = 0; position < length; position++)
      counts[keyOf(source[position]) + 1]++
    for (let bucket = 0; bucket < buckets; bucket++)
      counts[bucket + 1] += counts[bucket]
    const sorted = (this.bufferB ??= new Uint32Array(this.bufferA.length))
    for (let position = 0; position < length; position++)
      sorted[counts[keyOf(source[position])]++] = source[position]
    // 交換兩個緩衝區，下次查詢重複使用，不必再配置 40MB
    this.bufferB = source
    this.bufferA = sorted
    return { view: sorted, rank }
  }
}
