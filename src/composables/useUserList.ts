import { onScopeDispose, reactive, ref, shallowRef } from 'vue'
import { usersApi } from '../api/users'
import { isAbortError } from '../api/http'
import type { SortKey, SortOrder, UserInput, UserRow } from '../types/user'

const BATCH = 500

/** 列表狀態：無限捲動載入、搜尋、排序，以及刪除/更新/釘選後同步畫面 */
export function useUserList() {
  // shallowRef：數萬筆資料不需要深層響應式，省記憶體也更快
  const rows = shallowRef<UserRow[]>([])
  const total = ref(0)
  const loading = ref(false)
  const hasMore = ref(true)
  const error = ref<string | null>(null)
  const resetKey = ref(0)
  const query = reactive<{ q: string; sortBy: SortKey | null; order: SortOrder }>({ q: '', sortBy: null, order: 'asc' })

  let cursor: string | null = null
  // 目前進行中的查詢。換搜尋字或排序時呼叫 abort()，舊請求就不會再佔用網路，也不會晚回來蓋掉新結果
  let controller: AbortController | null = null

  async function loadMore() {
    if (loading.value || !hasMore.value) return
    const current = (controller = new AbortController())
    loading.value = true
    error.value = null
    try {
      const res = await usersApi.list({ ...query, cursor, limit: BATCH }, current.signal)
      // 換成新陣列（而不是 push）：子元件的 props 才會偵測到變化
      rows.value = rows.value.concat(res.data)
      total.value = res.total
      cursor = res.nextCursor
      hasMore.value = res.hasMore
    } catch (requestError) {
      if (!isAbortError(requestError)) error.value = (requestError as Error).message
    } finally {
      if (controller === current) {
        loading.value = false
        controller = null
      }
    }
  }

  function reload() {
    controller?.abort()
    controller = null
    rows.value = []
    cursor = null
    hasMore.value = true
    loading.value = false
    resetKey.value++
    return loadMore()
  }

  /** 表頭點擊：未排序 → 升冪 → 降冪 → 未排序 */
  function toggleSort(key: SortKey) {
    if (query.sortBy !== key) Object.assign(query, { sortBy: key, order: 'asc' })
    else if (query.order === 'asc') query.order = 'desc'
    else Object.assign(query, { sortBy: null, order: 'asc' })
    return reload()
  }

  async function removeRow(id: number) {
    await usersApi.remove(id)
    const rowIndex = rows.value.findIndex((row) => row.id === id)
    if (rowIndex >= 0) {
      rows.value = rows.value.toSpliced(rowIndex, 1)
      // 後端快照也少了這一列，游標往前一格，下一批才不會漏掉資料
      if (cursor) cursor = String(Number(cursor) - 1)
    }
    total.value--
  }

  async function updateRow(id: number, input: UserInput) {
    const updated = await usersApi.update(id, input)
    const rowIndex = rows.value.findIndex((row) => row.id === id)
    if (rowIndex >= 0) {
      rows.value = rows.value.with(rowIndex, updated)
    }
    return updated
  }

  async function pinRow(id: number, position: number) {
    await usersApi.pin(id, position)
    await reload()
  }

  async function unpinRow(id: number) {
    await usersApi.unpin(id)
    await reload()
  }

  // 元件卸載時，取消還在路上的請求
  onScopeDispose(() => controller?.abort())

  return { rows, total, loading, hasMore, error, query, resetKey, loadMore, reload, toggleSort, removeRow, updateRow, pinRow, unpinRow }
}
