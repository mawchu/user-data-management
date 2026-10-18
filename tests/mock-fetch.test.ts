import { describe, expect, it, vi } from 'vitest'
import { UserDb } from '../src/mock/db'
import { createDirectBackend, type MockBackend } from '../src/mock/backend'
import { createMockFetch } from '../src/mock/server'
import { HttpError, request, setTransport } from '../src/api/http'
import { usersApi } from '../src/api/users'

function setup(latency: [number, number] = [0, 0]) {
  const db = new UserDb(2000)
  const backend = createDirectBackend(db)
  const spy = vi.spyOn(backend, 'call')
  const onAbort = vi.fn()
  const mockFetch = createMockFetch(backend, { latency, onAbort })
  setTransport(mockFetch)
  return { db, spy, onAbort, mockFetch }
}

describe('mock fetch + API 層', () => {
  it('GET /api/users：查詢參數會正確傳到 mock 後端', async () => {
    const { spy } = setup()
    const res = await usersApi.list({
      q: 'chen',
      sortBy: 'age',
      order: 'desc',
      cursor: '30.12',
      limit: 500,
    })
    expect(spy).toHaveBeenCalledWith({
      method: 'list',
      args: [
        {
          q: 'chen',
          sortBy: 'age',
          order: 'desc',
          cursor: '30.12',
          limit: 500,
        },
      ],
    })
    expect(res.data.length).toBeLessThanOrEqual(500)
    expect(res.data.every((r, i, a) => i === 0 || a[i - 1].age >= r.age)).toBe(
      true,
    )
  })

  it('回傳的是真正的 Response：狀態碼、JSON、201、204', async () => {
    const { mockFetch } = setup()
    const ok = await mockFetch('/api/users?limit=3')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toBe('application/json')
    expect((await ok.json()).data).toHaveLength(3)
    const created = await mockFetch('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        userName: 'New One',
        position: 'QA',
        location: 'Taipei',
        age: 30,
        dateStart: '2026-01-02',
      }),
    })
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ id: 2001, version: 1 })
    expect((await mockFetch('/api/users/2001')).status).toBe(200)
    const del = await mockFetch('/api/users/5', { method: 'DELETE' })
    expect(del.status).toBe(204)
    expect((await mockFetch('/api/nope')).status).toBe(404)
  })

  it('限流：超過次數回 429 並帶 Retry-After，HttpError 會讀出秒數', async () => {
    setTransport(
      createMockFetch(createDirectBackend(new UserDb(100)), {
        rateLimit: { limit: 2, windowMs: 3000 },
      }),
    )
    await usersApi.list({})
    await usersApi.list({})
    await expect(usersApi.list({})).rejects.toMatchObject({
      status: 429,
      retryAfter: 3,
    })
    // 只限制查詢，修改不受影響
    await expect(usersApi.get(1)).resolves.toMatchObject({ id: 1 })
  })

  it('錯誤轉成 HttpError：422 帶欄位錯誤、404、409 帶目前資料', async () => {
    setup()
    const input = {
      userName: 'A',
      position: 'B',
      location: 'C',
      age: 30,
      dateStart: '2020-01-01',
    }
    await expect(
      usersApi.update(1, { ...input, userName: '', age: 1.5 }, 1),
    ).rejects.toMatchObject({
      status: 422,
      details: { userName: '必填', age: '請輸入整數' },
    })
    await expect(usersApi.remove(999999)).rejects.toBeInstanceOf(HttpError)
    await usersApi.update(1, input, 1)
    await expect(usersApi.update(1, input, 1)).rejects.toMatchObject({
      status: 409,
      details: { current: { id: 1, version: 2 } },
    })
  })

  it('網路延遲中取消：請求不會送到後端', async () => {
    const { spy, onAbort } = setup([50, 50])
    const controller = new AbortController()
    const p = usersApi.list({}, controller.signal)
    controller.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 80))
    expect(spy).not.toHaveBeenCalled()
    expect(onAbort).toHaveBeenCalledOnce()
  })

  it('後端處理中取消：前端立刻收到 AbortError，不等結果', async () => {
    const slow: MockBackend = {
      call: () => new Promise((r) => setTimeout(() => r({ data: [] }), 200)),
    }
    setTransport(createMockFetch(slow))
    const controller = new AbortController()
    const started = performance.now()
    const p = request('GET', '/api/users', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(performance.now() - started).toBeLessThan(150)
  })

  it('已經取消的 signal：直接失敗', async () => {
    const { spy } = setup()
    await expect(usersApi.list({}, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(spy).not.toHaveBeenCalled()
  })
})
