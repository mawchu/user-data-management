/**
 * 使用者 API（完整契約見 docs/api.md）：
 *   GET    /api/users?q=&sortBy=&order=&cursor=&limit=500
 *   GET    /api/users/:id
 *   POST   /api/users
 *   PATCH  /api/users/:id   { ...欄位, version }
 *   DELETE /api/users/:id
 */
import { request } from './http'
import type {
  User,
  UserInput,
  UserListQuery,
  UserListResponse,
} from '../types/user'

function toSearchParams(query: UserListQuery) {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  if (query.sortBy) {
    params.set('sortBy', query.sortBy)
    params.set('order', query.order ?? 'asc')
  }
  if (query.cursor) params.set('cursor', query.cursor)
  if (query.limit) params.set('limit', String(query.limit))
  return params
}

export const usersApi = {
  /** 查詢可以被取消：換搜尋字或排序時，舊的請求就沒有意義了 */
  list: (query: UserListQuery, signal?: AbortSignal) =>
    request<UserListResponse>('GET', `/api/users?${toSearchParams(query)}`, {
      signal,
    }),
  get: (id: number, signal?: AbortSignal) =>
    request<User>('GET', `/api/users/${id}`, { signal }),
  // 修改類請求刻意不提供取消：請求一旦送出，後端可能已經改好了，前端取消只會讓畫面和資料不一致
  create: (input: UserInput) =>
    request<User>('POST', '/api/users', { body: input }),
  /** 帶上讀到的 version：別人先改過時後端回 409 */
  update: (id: number, input: UserInput, version: number) =>
    request<User>('PATCH', `/api/users/${id}`, {
      body: { ...input, version },
    }),
  remove: (id: number) => request<void>('DELETE', `/api/users/${id}`),
}
