/** 一筆使用者資料：題目的 5 個欄位 + 唯一識別碼 id */
export interface User {
  id: number
  userName: string
  position: string
  location: string
  /** 整數 */
  age: number
  /** YYYY-MM-DD */
  dateStart: string
}

/** 可編輯的欄位（id 不能改） */
export type UserInput = Omit<User, 'id'>

export type SortKey = keyof UserInput
export type SortOrder = 'asc' | 'desc'

/** GET /api/users 的查詢參數 */
export interface UserListQuery {
  /** 關鍵字，比對所有欄位（不分大小寫、部分符合） */
  q?: string
  sortBy?: SortKey | null
  order?: SortOrder
  /** 上一批回傳的 nextCursor；第一批不帶 */
  cursor?: string | null
  /** 每批筆數，最多 500 */
  limit?: number
}

/** 列表中的一列：資料 + 釘選資訊 */
export interface UserRow extends User {
  /** 被釘選時的目標位置（1 起算）；沒釘選為 null */
  pinnedAt: number | null
}

/** GET /api/users 的回應 */
export interface UserListResponse {
  data: UserRow[]
  nextCursor: string | null
  hasMore: boolean
  /** 符合條件的總筆數（含釘選列） */
  total: number
}

export interface PinInfo {
  id: number
  position: number
}
