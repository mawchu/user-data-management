/**
 * 千萬筆使用者資料的記憶體資料庫（mock 後端）。
 *
 * 每個欄位存成一個 TypedArray（固定型別的數字陣列），字串欄位只存「字典編號」：
 * 例如 position 只有十幾種值，每列只要 1 byte 記它是第幾種。1,000 萬列約佔 70MB。
 * 因為每個欄位的不同值都不多，排序用 counting sort（計數排序，O(n)），不用一般比較排序。
 */
import type {
  PinInfo,
  SortKey,
  User,
  UserInput,
  UserListQuery,
  UserListResponse,
  UserRow,
} from '../types/user'
import { validateUserInput } from '../utils/validate'

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
  view: Uint32Array // 未釘選、符合條件的列索引，已排序
  length: number
  pins: PinInfo[] // 符合條件的釘選列，依位置排序
}

export class UserDb {
  readonly size: number
  private names = new Dict(0xffff)
  private positions = new Dict(0xff, POSITIONS)
  private locations = new Dict(0xff, LOCATIONS)
  // 每個欄位一條陣列，第 rowIndex 格就是第 rowIndex 列的值（字串欄位存字典編號）
  private nameIds: Uint16Array
  private positionIds: Uint8Array
  private locationIds: Uint8Array
  private ages: Uint8Array
  private startDays: Uint16Array // 1950-01-01 起算的天數
  private deleted: Uint8Array
  private pinnedFlag: Uint8Array
  private pins = new Map<number, number>() // id -> 目標位置（1 起算）
  private liveCount: number
  private bufferA: Uint32Array
  private bufferB: Uint32Array | null = null
  private snapshot: Snapshot | null = null

  constructor(size = 10_000_000, seed = 20261017) {
    this.size = size
    this.liveCount = size
    this.nameIds = new Uint16Array(size)
    this.positionIds = new Uint8Array(size)
    this.locationIds = new Uint8Array(size)
    this.ages = new Uint8Array(size)
    this.startDays = new Uint16Array(size)
    this.deleted = new Uint8Array(size)
    this.pinnedFlag = new Uint8Array(size)
    this.bufferA = new Uint32Array(size)

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

  /** GET /api/users */
  list(query: UserListQuery = {}): UserListResponse {
    const keyword = (query.q ?? '').trim().toLowerCase()
    const sortBy = query.sortBy ?? null
    const order = query.order === 'desc' ? 'desc' : 'asc'
    const limit = Math.min(
      Math.max(1, Math.trunc(query.limit ?? MAX_LIMIT)),
      MAX_LIMIT,
    )
    const key = `${keyword}\u0000${sortBy}\u0000${sortBy ? order : ''}`

    let offset = 0
    if (query.cursor != null) {
      offset = Number(query.cursor)
      if (!Number.isInteger(offset) || offset < 0)
        throw new ApiError(400, 'cursor 格式錯誤')
    }
    // 第一批一律重算；之後的批次沿用同一份快照，資料才不會在捲動中跳動
    if (offset === 0 || this.snapshot?.key !== key)
      this.snapshot = this.build(key, keyword, sortBy, order)

    const snapshot = this.snapshot
    const total = snapshot.length + snapshot.pins.length
    const end = Math.min(offset + limit, total)
    const data: UserRow[] = []
    const pinSlots = this.effectivePinPositions(snapshot)
    // 跳過 offset 之前的釘選列；剩下的位置由一般列依序填入
    let pinIndex = 0
    while (pinIndex < pinSlots.length && pinSlots[pinIndex] < offset) pinIndex++
    let viewIndex = offset - pinIndex
    for (let position = offset; position < end; position++) {
      if (pinIndex < pinSlots.length && pinSlots[pinIndex] === position) {
        const pin = snapshot.pins[pinIndex++]
        data.push({ ...this.toUser(pin.id - 1), pinnedAt: pin.position })
      } else {
        data.push({
          ...this.toUser(snapshot.view[viewIndex++]),
          pinnedAt: null,
        })
      }
    }
    const hasMore = end < total
    return { data, nextCursor: hasMore ? String(end) : null, hasMore, total }
  }

  /** GET /api/users/:id */
  get(id: number): UserRow {
    const rowIndex = this.indexOf(id)
    return { ...this.toUser(rowIndex), pinnedAt: this.pins.get(id) ?? null }
  }

  /** PATCH /api/users/:id */
  update(id: number, input: UserInput): UserRow {
    const rowIndex = this.indexOf(id)
    const errors = validateUserInput(input)
    if (Object.keys(errors).length)
      throw new ApiError(422, '資料驗證失敗', errors)
    // 先把三個字典都加好，任何一個爆上限就整筆不改
    const nameId = this.names.add(input.userName.trim())
    const positionId = this.positions.add(input.position.trim())
    const locationId = this.locations.add(input.location.trim())
    this.nameIds[rowIndex] = nameId
    this.positionIds[rowIndex] = positionId
    this.locationIds[rowIndex] = locationId
    this.ages[rowIndex] = input.age
    this.startDays[rowIndex] = toDay(input.dateStart)
    // 已載入的快照不重排：使用者剛改的列留在原位，下次重新查詢才會依新值排序
    return this.get(id)
  }

  /** DELETE /api/users/:id */
  remove(id: number): void {
    const rowIndex = this.indexOf(id)
    this.deleted[rowIndex] = 1
    this.liveCount--
    const snapshot = this.snapshot
    if (this.pins.delete(id)) {
      this.pinnedFlag[rowIndex] = 0
      if (snapshot) snapshot.pins = snapshot.pins.filter((pin) => pin.id !== id)
    } else if (snapshot) {
      const viewIndex = snapshot.view
        .subarray(0, snapshot.length)
        .indexOf(rowIndex)
      if (viewIndex >= 0) {
        snapshot.view.copyWithin(viewIndex, viewIndex + 1, snapshot.length)
        snapshot.length--
      }
    }
  }

  /** PUT /api/users/:id/pin */
  pin(id: number, position: number): UserRow {
    const rowIndex = this.indexOf(id)
    if (!Number.isInteger(position) || position < 1)
      throw new ApiError(422, '位置需為 1 以上的整數')
    for (const [otherId, otherPosition] of this.pins) {
      if (otherPosition === position && otherId !== id)
        throw new ApiError(409, `第 ${position} 列已被 #${otherId} 釘選`)
    }
    this.pins.set(id, position)
    this.pinnedFlag[rowIndex] = 1
    this.snapshot = null
    return this.get(id)
  }

  /** DELETE /api/users/:id/pin */
  unpin(id: number): UserRow {
    const rowIndex = this.indexOf(id)
    this.pins.delete(id)
    this.pinnedFlag[rowIndex] = 0
    this.snapshot = null
    return this.get(id)
  }

  /** GET /api/pins */
  listPins(): PinInfo[] {
    return [...this.pins]
      .map(([id, position]) => ({ id, position }))
      .sort((pinA, pinB) => pinA.position - pinB.position)
  }

  private indexOf(id: number): number {
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      id > this.size ||
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
    }
  }

  /**
   * 釘選列的實際位置（0 起算）。目標位置超過資料總數時，依序排在最後面。
   * 例：只剩 3 筆一般資料，釘在第 100 列的資料會出現在第 4 列。
   */
  private effectivePinPositions(snapshot: Snapshot): number[] {
    return snapshot.pins.map((pin, pinOrder) =>
      Math.min(pin.position - 1, snapshot.length + pinOrder),
    )
  }

  private build(
    key: string,
    keyword: string,
    sortBy: SortKey | null,
    order: 'asc' | 'desc',
  ): Snapshot {
    const { size, deleted, pinnedFlag } = this
    let view = this.bufferA
    let length = 0

    if (!keyword) {
      for (let rowIndex = 0; rowIndex < size; rowIndex++)
        if (!deleted[rowIndex] && !pinnedFlag[rowIndex])
          view[length++] = rowIndex
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
      for (let rowIndex = 0; rowIndex < size; rowIndex++) {
        if (deleted[rowIndex] || pinnedFlag[rowIndex]) continue
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

    if (sortBy) view = this.countingSort(view, length, sortBy, order)

    const pins = this.listPins().filter(
      (pin) => !keyword || this.matches(pin.id - 1, keyword),
    )
    return { key, keyword, view, length, pins }
  }

  private dayHitTable(keyword: string): Uint8Array {
    const table = new Uint8Array(0x10000)
    if (!/^[\d-]+$/.test(keyword)) return table
    const { startDays, size } = this
    // 只算實際出現過的日期，避免格式化 65,536 個字串
    const seen = new Uint8Array(0x10000)
    for (let rowIndex = 0; rowIndex < size; rowIndex++)
      seen[startDays[rowIndex]] = 1
    for (let day = 0; day < 0x10000; day++)
      if (seen[day] && dayToDateString(day).includes(keyword)) table[day] = 1
    return table
  }

  private matches(rowIndex: number, keyword: string): boolean {
    const user = this.toUser(rowIndex)
    return [
      user.userName,
      user.position,
      user.location,
      String(user.age),
      user.dateStart,
    ].some((value) => value.toLowerCase().includes(keyword))
  }

  /** 計數排序：穩定排序，同值時保持 id 由小到大 */
  private countingSort(
    source: Uint32Array,
    length: number,
    sortBy: SortKey,
    order: 'asc' | 'desc',
  ): Uint32Array {
    let column: ArrayLike<number>
    let rank: ArrayLike<number> | null = null
    let buckets: number
    switch (sortBy) {
      case 'userName':
        column = this.nameIds
        rank = this.names.rank()
        buckets = this.names.values.length
        break
      case 'position':
        column = this.positionIds
        rank = this.positions.rank()
        buckets = this.positions.values.length
        break
      case 'location':
        column = this.locationIds
        rank = this.locations.rank()
        buckets = this.locations.values.length
        break
      case 'age':
        column = this.ages
        buckets = 256
        break
      case 'dateStart':
        column = this.startDays
        buckets = 0x10000
        break
    }
    const keyOf = rank
      ? (rowIndex: number) =>
          order === 'asc'
            ? rank[column[rowIndex]]
            : buckets - 1 - rank[column[rowIndex]]
      : (rowIndex: number) =>
          order === 'asc' ? column[rowIndex] : buckets - 1 - column[rowIndex]
    const counts = new Uint32Array(buckets + 1)
    for (let position = 0; position < length; position++)
      counts[keyOf(source[position]) + 1]++
    for (let bucket = 0; bucket < buckets; bucket++)
      counts[bucket + 1] += counts[bucket]
    const sorted = (this.bufferB ??= new Uint32Array(this.size))
    for (let position = 0; position < length; position++)
      sorted[counts[keyOf(source[position])]++] = source[position]
    // 交換兩個緩衝區，下次查詢重複使用，不必再配置 40MB
    this.bufferB = source
    this.bufferA = sorted
    return sorted
  }
}
