import { computed, shallowRef } from 'vue'
import { usersApi } from '../api/users'
import { HttpError } from '../api/http'
import { matchesKeyword, normalizeKeyword } from '../utils/match'
import { placePins, type PlacedPin } from '../utils/placePins'
import type { User } from '../types/user'
import type { UserList } from './useUserList'

const STORAGE_KEY = 'user-data-admin:pins:v1'

/** 讀取存在瀏覽器的釘選設定；無痕模式或資料損毀時當作沒有釘選 */
function loadPins(): Map<number, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    return new Map(
      (saved as [number, number][]).filter(
        ([id, position]) => Number.isInteger(id) && Number.isInteger(position),
      ),
    )
  } catch {
    return new Map()
  }
}

/**
 * 釘選：每個使用者自己的顯示設定，存在 localStorage，不影響其他人。
 *
 * 後端只負責給排序好的資料；前端把釘選列插進已載入的資料（placePins），
 * 所以釘選、取消釘選都不用重新查詢，捲動位置和已載入的資料都會保留。
 */
export function usePinnedRows(list: UserList) {
  /** id -> 目標位置（1 起算） */
  const pins = shallowRef<ReadonlyMap<number, number>>(loadPins())
  /** 釘選列的資料。不一定在已載入的批次裡（例如釘在第 3,000 列），所以另外保存 */
  const pinnedRows = shallowRef<ReadonlyMap<number, User>>(new Map())

  function save(next: Map<number, number>) {
    pins.value = next
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
    } catch {
      // 無法寫入（例如無痕模式）時，釘選只在這次瀏覽有效
    }
  }

  /** 開啟頁面時，向後端取回釘選列的最新資料；已被刪除的就移除釘選 */
  async function restore() {
    const ids = [...pins.value.keys()]
    const results = await Promise.allSettled(ids.map((id) => usersApi.get(id)))
    const rowsById = new Map<number, User>()
    const nextPins = new Map(pins.value)
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') rowsById.set(ids[index], result.value)
      else if (
        result.reason instanceof HttpError &&
        result.reason.status === 404
      )
        nextPins.delete(ids[index])
    })
    pinnedRows.value = rowsById
    if (nextPins.size !== pins.value.size) save(nextPins)
  }

  function pin(row: User, position: number) {
    if (!Number.isInteger(position) || position < 1)
      throw new Error('位置需為 1 以上的整數')
    for (const [otherId, otherPosition] of pins.value)
      if (otherPosition === position && otherId !== row.id)
        throw new Error(`第 ${position} 列已被 #${otherId} 釘選`)
    save(new Map(pins.value).set(row.id, position))
    pinnedRows.value = new Map(pinnedRows.value).set(row.id, row)
  }

  function unpin(id: number) {
    if (!pins.value.has(id)) return
    const nextPins = new Map(pins.value)
    nextPins.delete(id)
    save(nextPins)
    const nextRows = new Map(pinnedRows.value)
    nextRows.delete(id)
    pinnedRows.value = nextRows
  }

  // 釘選列被編輯或刪除時同步
  list.onUpdated((user) => {
    if (pinnedRows.value.has(user.id))
      pinnedRows.value = new Map(pinnedRows.value).set(user.id, user)
  })
  list.onRemoved(unpin)

  /** 目前要顯示的釘選列：不符合搜尋條件的不顯示（搜尋就是篩選） */
  const visiblePins = computed<PlacedPin[]>(() => {
    const keyword = normalizeKeyword(list.applied.value.q)
    const result: PlacedPin[] = []
    for (const [id, position] of pins.value) {
      const row = pinnedRows.value.get(id)
      if (row && matchesKeyword(row, keyword)) result.push({ row, position })
    }
    return result.sort((pinA, pinB) => pinA.position - pinB.position)
  })

  /** 畫面上的列表 = 後端排序好的資料 + 插入釘選列 */
  const displayRows = computed(() =>
    placePins(list.rows.value, visiblePins.value, list.hasMore.value),
  )

  return { pins, displayRows, restore, pin, unpin }
}
