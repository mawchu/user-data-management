/**
 * 使用者 API：
 *   GET    /api/users?q=&sortBy=&order=&cursor=&limit=500
 *   PATCH  /api/users/:id
 *   DELETE /api/users/:id
 *   PUT    /api/users/:id/pin   { position }
 *   DELETE /api/users/:id/pin
 */
import { request } from './http'
import type {
  UserInput,
  UserListQuery,
  UserListResponse,
  UserRow,
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
  // 修改類請求刻意不提供取消：請求一旦送出，後端可能已經改好了，前端取消只會讓畫面和資料不一致
  update: (id: number, input: UserInput) =>
    request<UserRow>('PATCH', `/api/users/${id}`, { body: input }),
  remove: (id: number) => request<void>('DELETE', `/api/users/${id}`),
  pin: (id: number, position: number) =>
    request<UserRow>('PUT', `/api/users/${id}/pin`, { body: { position } }),
  unpin: (id: number) => request<UserRow>('DELETE', `/api/users/${id}/pin`),
}
