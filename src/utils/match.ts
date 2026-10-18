import type { User } from '../types/user'

/** 搜尋關鍵字的正規化：去掉前後空白、轉小寫 */
export const normalizeKeyword = (keyword: string) =>
  keyword.trim().toLowerCase()

/**
 * 搜尋規則：任一欄位包含關鍵字（不分大小寫）。
 * 前端（判斷釘選列要不要顯示）和 mock 後端共用，兩邊規則才不會不一致。
 */
export function matchesKeyword(user: User, keyword: string): boolean {
  if (!keyword) return true
  return [
    user.userName,
    user.position,
    user.location,
    String(user.age),
    user.dateStart,
  ].some((value) => value.toLowerCase().includes(keyword))
}
