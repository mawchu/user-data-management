/** 一筆使用者資料：題目的 5 個欄位 + 唯一識別碼 id + 版本號 */
export interface User {
  id: number
  userName: string
  position: string
  location: string
  /** 整數 */
  age: number
  /** YYYY-MM-DD */
  dateStart: string
  /** 每次更新加 1。更新時帶上，後端用它判斷是否有人先改過（見 docs/api.md） */
  version: number
}

/** 新增、編輯時可填的欄位 */
export type UserInput = Omit<User, 'id' | 'version'>

export type SortKey = keyof UserInput
export type SortOrder = 'asc' | 'desc'

/** GET /api/users 的查詢參數 */
export interface UserListQuery {
  /** 關鍵字，比對所有欄位（不分大小寫、部分符合） */
  q?: string
  sortBy?: SortKey | null
  order?: SortOrder
  /** 上一批回傳的 nextCursor；第一批不帶。前端不解析內容 */
  cursor?: string | null
  /** 每批筆數，最多 500 */
  limit?: number
}

/** GET /api/users 的回應 */
export interface UserListResponse {
  data: User[]
  nextCursor: string | null
  hasMore: boolean
  /** 符合條件的總筆數 */
  total: number
}

/** 409 的 details：後端目前的版本，讓前端顯示差異 */
export interface ConflictDetails {
  current: User
}
