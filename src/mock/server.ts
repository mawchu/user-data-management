/**
 * 假的 fetch：接收和 fetch 一樣的參數，依「方法 + 網址」分派給 mock 資料庫，回傳真正的 Response 物件。
 * 呼叫端完全照真實 API 的寫法（fetch + signal + res.json()），之後接真後端只要把 transport 換成 window.fetch。
 */
import { ApiError } from './db'
import type { MockBackend } from './backend'
import type { MockRequest } from './worker'
import type { SortKey, UserListQuery } from '../types/user'

export interface MockFetchOptions {
  /** 模擬網路延遲（毫秒），回傳 [最短, 最長] */
  latency?: [number, number]
  /** 每次請求被取消時呼叫，方便畫面顯示統計 */
  onAbort?: (method: string, url: string) => void
  /** 模擬後端限流：查詢在 windowMs 內超過 limit 次就回 429 */
  rateLimit?: { limit: number; windowMs: number }
}

type Route = {
  method: string
  pattern: RegExp
  toRequest: (match: RegExpMatchArray, url: URL, body: any) => MockRequest
  status?: number
}

const SORT_KEYS: SortKey[] = [
  'userName',
  'position',
  'location',
  'age',
  'dateStart',
]

const ROUTES: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/users$/,
    toRequest: (_match, url) => {
      const params = url.searchParams
      const sortBy = params.get('sortBy') as SortKey | null
      const query: UserListQuery = {
        q: params.get('q') ?? '',
        sortBy: sortBy && SORT_KEYS.includes(sortBy) ? sortBy : null,
        order: params.get('order') === 'desc' ? 'desc' : 'asc',
        cursor: params.get('cursor'),
        limit: params.has('limit') ? Number(params.get('limit')) : undefined,
      }
      return { method: 'list', args: [query] }
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/users$/,
    toRequest: (_match, _url, body) => ({ method: 'create', args: [body] }),
    status: 201,
  },
  {
    method: 'GET',
    pattern: /^\/api\/users\/(\d+)$/,
    toRequest: (match) => ({ method: 'get', args: [Number(match[1])] }),
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/users\/(\d+)$/,
    toRequest: (match, _url, body) => {
      const { version, ...input } = body ?? {}
      return { method: 'update', args: [Number(match[1]), input, version] }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/users\/(\d+)$/,
    toRequest: (match) => ({ method: 'remove', args: [Number(match[1])] }),
    status: 204,
  },
]

const abortError = () =>
  new DOMException('The operation was aborted.', 'AbortError')

/** 可被 signal 中斷的等待 */
function sleep(durationMs: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, durationMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 等 promise 完成，但 signal 一取消就立刻 reject（結果直接丟掉） */
function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort))
  })
}

const json = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

export function createMockFetch(
  backend: MockBackend,
  options: MockFetchOptions = {},
) {
  const [minMs, maxMs] = options.latency ?? [0, 0]
  const listRequestTimes: number[] = []

  return async function mockFetch(
    input: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase()
    const url = new URL(input, 'http://mock.local')
    const signal = init.signal
    try {
      // 1. 模擬「請求在網路上傳送」：這段時間內取消，後端完全不會收到
      await sleep(minMs + Math.random() * (maxMs - minMs), signal)

      if (
        options.rateLimit &&
        method === 'GET' &&
        url.pathname === '/api/users'
      ) {
        const { limit, windowMs } = options.rateLimit
        const now = Date.now()
        while (listRequestTimes.length && now - listRequestTimes[0] >= windowMs)
          listRequestTimes.shift()
        if (listRequestTimes.length >= limit) {
          const retryAfter = Math.ceil(
            (windowMs - (now - listRequestTimes[0])) / 1000,
          )
          return json(
            429,
            { message: '查詢太頻繁，請稍後再試' },
            { 'Retry-After': String(retryAfter) },
          )
        }
        listRequestTimes.push(now)
      }

      const route = ROUTES.find(
        (candidate) =>
          candidate.method === method && candidate.pattern.test(url.pathname),
      )
      if (!route)
        return json(404, { message: `找不到 ${method} ${url.pathname}` })
      const body =
        typeof init.body === 'string' && init.body
          ? JSON.parse(init.body)
          : undefined
      const request = route.toRequest(
        url.pathname.match(route.pattern)!,
        url,
        body,
      )

      // 2. 後端已在處理：取消後瀏覽器不再等結果，但後端可能已經執行完（真實 HTTP 也是如此）
      const result = await raceAbort(backend.call(request), signal)
      return route.status === 204
        ? new Response(null, { status: 204 })
        : json(route.status ?? 200, result)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        options.onAbort?.(method, input)
        throw error
      }
      if (error instanceof ApiError)
        return json(error.status, {
          message: error.message,
          details: error.details,
        })
      return json(500, { message: (error as Error).message })
    }
  }
}
