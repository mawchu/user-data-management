import { onScopeDispose, reactive, readonly, ref, shallowRef } from 'vue'
import { usersApi } from '../api/users'
import { HttpError, isAbortError } from '../api/http'
import { sleep } from '../utils/sleep'
import type {
  ConflictDetails,
  SortKey,
  SortOrder,
  User,
  UserInput,
  UserListQuery,
  UserListResponse,
} from '../types/user'

const BATCH = 500
// 第一批的快取：在幾個條件之間來回切換時，不用每次都重新查詢
const CACHE_TTL_MS = 30_000
const CACHE_LIMIT = 20
// 429 時最多等幾秒再自動重試
const MAX_RETRY_WAIT_SECONDS = 10

interface ListQuery {
  q: string
  sortBy: SortKey | null
  order: SortOrder
}

/**
 * 列表狀態：分批載入、搜尋、排序，以及新增/刪除/更新後同步畫面。
 *
 * 請求的規則：
 * - 查詢同時只有一個在進行；換條件時取消舊的，舊結果不能蓋掉新結果。
 * - 換條件時先保留舊資料（變淡），新的第一批回來才一次換掉，畫面不會閃成空白。
 * - 載入失敗就停下來等使用者按重試，不會自動一直重送。
 * - 後端回 429 時，依 Retry-After 等一下再自動重試一次。
 */
export function useUserList() {
  // shallowRef：數萬筆資料不需要深層響應式，省記憶體也更快
  const rows = shallowRef<User[]>([])
  const total = ref(0)
  const loading = ref(false)
  const hasMore = ref(true)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  /** 正在載入新條件，畫面上暫時還是舊條件的資料 */
  const stale = ref(false)
  const resetKey = ref(0)
  /** 這次查詢之後新增的資料，畫面上標示「新增」 */
  const newIds = shallowRef<ReadonlySet<number>>(new Set())
  const query = reactive<ListQuery>({ q: '', sortBy: null, order: 'asc' })
  /** 畫面上的資料實際對應的條件：新條件的第一批回來後才更新 */
  const applied = shallowRef<Readonly<ListQuery>>({ ...query })

  let cursor: string | null = null
  // 目前進行中的查詢。換條件時呼叫 abort()，舊請求就不會再佔用網路，也不會晚回來蓋掉新結果
  let controller: AbortController | null = null
  const firstPageCache = new Map<
    string,
    { response: UserListResponse; savedAt: number }
  >()
  const updatedListeners: ((user: User) => void)[] = []
  const removedListeners: ((id: number) => void)[] = []

  const cacheKey = (listQuery: ListQuery) =>
    JSON.stringify([
      listQuery.q,
      listQuery.sortBy,
      listQuery.sortBy ? listQuery.order : '',
    ])

  function remember(key: string, response: UserListResponse) {
    firstPageCache.delete(key)
    firstPageCache.set(key, { response, savedAt: Date.now() })
    // Map 依加入順序排列，第一個就是最久沒用的
    if (firstPageCache.size > CACHE_LIMIT)
      firstPageCache.delete(firstPageCache.keys().next().value!)
  }

  async function fetchPage(listQuery: UserListQuery, signal: AbortSignal) {
    try {
      return await usersApi.list(listQuery, signal)
    } catch (requestError) {
      if (!(requestError instanceof HttpError) || requestError.status !== 429)
        throw requestError
      const seconds = Math.min(
        requestError.retryAfter ?? 1,
        MAX_RETRY_WAIT_SECONDS,
      )
      notice.value = `查詢太頻繁，${seconds} 秒後自動重試`
      try {
        await sleep(seconds * 1000, signal)
      } finally {
        notice.value = null
      }
      return usersApi.list(listQuery, signal)
    }
  }

  function applyFirstPage(response: UserListResponse, listQuery: ListQuery) {
    rows.value = response.data
    newIds.value = new Set()
    total.value = response.total
    cursor = response.nextCursor
    hasMore.value = response.hasMore
    applied.value = listQuery
    stale.value = false
    resetKey.value++
  }

  /** 依目前的 query 從第一批重新查詢 */
  async function reload() {
    controller?.abort()
    controller = null
    error.value = null
    const listQuery = { ...query }
    const key = cacheKey(listQuery)
    const cached = firstPageCache.get(key)
    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      loading.value = false
      applyFirstPage(cached.response, listQuery)
      return
    }
    const current = (controller = new AbortController())
    loading.value = true
    stale.value = rows.value.length > 0
    try {
      const response = await fetchPage(
        { ...listQuery, limit: BATCH },
        current.signal,
      )
      remember(key, response)
      applyFirstPage(response, listQuery)
    } catch (requestError) {
      if (!isAbortError(requestError))
        error.value = (requestError as Error).message
    } finally {
      if (controller === current) {
        loading.value = false
        controller = null
      }
    }
  }

  /** 載入下一批（表格捲到接近底部時呼叫） */
  async function loadMore() {
    // 失敗後（error）不自動重送，要等使用者按重試；stale 時等新條件的第一批
    if (loading.value || !hasMore.value || error.value || stale.value) return
    const current = (controller = new AbortController())
    loading.value = true
    try {
      const response = await fetchPage(
        { ...applied.value, cursor, limit: BATCH },
        current.signal,
      )
      // 剛新增的資料已經放在最上面，之後的批次如果也有它，就略過
      const added = newIds.value
      const data = added.size
        ? response.data.filter((row) => !added.has(row.id))
        : response.data
      // 換成新陣列（而不是 push）：子元件的 props 才會偵測到變化
      rows.value = rows.value.concat(data)
      total.value = response.total + added.size
      cursor = response.nextCursor
      hasMore.value = response.hasMore
    } catch (requestError) {
      if (!isAbortError(requestError))
        error.value = (requestError as Error).message
    } finally {
      if (controller === current) {
        loading.value = false
        controller = null
      }
    }
  }

  /** 失敗後由使用者觸發重試 */
  function retry() {
    if (stale.value || !rows.value.length) return reload()
    error.value = null
    return loadMore()
  }

  /** 表頭點擊：未排序 → 升冪 → 降冪 → 未排序 */
  function toggleSort(key: SortKey) {
    if (query.sortBy !== key)
      Object.assign(query, { sortBy: key, order: 'asc' })
    else if (query.order === 'asc') query.order = 'desc'
    else Object.assign(query, { sortBy: null, order: 'asc' })
    return reload()
  }

  /** 手機的排序選單：直接指定欄位與方向 */
  function setSort(key: SortKey | null, order: SortOrder = 'asc') {
    Object.assign(query, { sortBy: key, order })
    return reload()
  }

  function search(keyword: string) {
    query.q = keyword
    return reload()
  }

  function replaceRow(user: User) {
    const rowIndex = rows.value.findIndex((row) => row.id === user.id)
    if (rowIndex >= 0) rows.value = rows.value.with(rowIndex, user)
    updatedListeners.forEach((listener) => listener(user))
  }

  /** 資料已經不存在（自己刪除，或被別人刪除）：從畫面上拿掉 */
  function forgetRow(id: number) {
    const rowIndex = rows.value.findIndex((row) => row.id === id)
    if (rowIndex >= 0) {
      rows.value = rows.value.toSpliced(rowIndex, 1)
      total.value--
    }
    if (newIds.value.has(id)) {
      const next = new Set(newIds.value)
      next.delete(id)
      newIds.value = next
    }
    removedListeners.forEach((listener) => listener(id))
  }

  async function createRow(input: UserInput) {
    const created = await usersApi.create(input)
    firstPageCache.clear()
    rows.value = [created, ...rows.value]
    newIds.value = new Set(newIds.value).add(created.id)
    total.value++
    // 捲回最上面，讓使用者看到剛新增的資料
    resetKey.value++
    return created
  }

  async function updateRow(id: number, input: UserInput, version: number) {
    try {
      const updated = await usersApi.update(id, input, version)
      firstPageCache.clear()
      replaceRow(updated)
      return updated
    } catch (requestError) {
      if (requestError instanceof HttpError) {
        if (requestError.status === 404) forgetRow(id)
        // 別人先改過：畫面先換成後端目前的內容，再由呼叫端讓使用者決定要不要覆蓋
        if (requestError.status === 409)
          replaceRow((requestError.details as ConflictDetails).current)
      }
      throw requestError
    }
  }

  async function removeRow(id: number) {
    try {
      await usersApi.remove(id)
    } catch (requestError) {
      // 已經被別人刪掉：結果一樣是不存在，畫面同步拿掉，但仍讓呼叫端知道
      if (requestError instanceof HttpError && requestError.status === 404)
        forgetRow(id)
      throw requestError
    }
    firstPageCache.clear()
    forgetRow(id)
  }

  // 元件卸載時，取消還在路上的請求
  onScopeDispose(() => controller?.abort())

  return {
    rows,
    total,
    loading,
    hasMore,
    error,
    notice,
    stale,
    newIds,
    query: readonly(query),
    applied,
    resetKey,
    reload,
    loadMore,
    retry,
    toggleSort,
    setSort,
    search,
    createRow,
    updateRow,
    removeRow,
    onUpdated: (listener: (user: User) => void) =>
      updatedListeners.push(listener),
    onRemoved: (listener: (id: number) => void) =>
      removedListeners.push(listener),
  }
}

export type UserList = ReturnType<typeof useUserList>
