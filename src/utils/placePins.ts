import type { User } from '../types/user'

export interface PlacedPin {
  row: User
  /** 目標位置（1 起算） */
  position: number
}

/**
 * 把釘選列插進已載入的列表。
 *
 * 後端回傳的 rows 是「全域排序後的前 N 筆」，所以在這 N 筆裡依位置插入，結果也是全域正確的：
 * 換排序時後端給新的順序，前端再合併一次，釘選列就還在原本的位置。
 *
 * - pins 需依 position 由小到大排好。
 * - rows 裡如果也有釘選的那筆，先拿掉，避免同一筆出現兩次。
 * - 目標位置還沒載入到（hasMore 為 true）時先不顯示，捲到那裡、資料載入後才出現；
 *   資料已經全部載完，就依序排在最後。
 */
export function placePins(
  rows: User[],
  pins: PlacedPin[],
  hasMore: boolean,
): User[] {
  if (!pins.length) return rows
  const pinnedIds = new Set(pins.map((pin) => pin.row.id))
  const rest = rows.filter((row) => !pinnedIds.has(row.id))
  const result: User[] = []
  let restIndex = 0
  for (const pin of pins) {
    const targetIndex = pin.position - 1
    while (result.length < targetIndex && restIndex < rest.length)
      result.push(rest[restIndex++])
    if (result.length < targetIndex && hasMore) break
    result.push(pin.row)
  }
  while (restIndex < rest.length) result.push(rest[restIndex++])
  return result
}
