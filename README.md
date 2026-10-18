# 使用者資料管理後臺（Vue 3 + 千萬筆 Mock API）

## 執行
```bash
npm install
npm run dev          # 開發模式，打開 http://localhost:5173
npm test             # 單元測試（33 項）
npm run perf         # 10,000,000 筆效能量測
npm run build && npm run preview   # 正式建置後預覽（http://localhost:4173）
node e2e/run.mjs     # 瀏覽器端對端測試（需先啟動 preview；Chromium 路徑用 CHROMIUM 環境變數指定）
```
網址加 `?size=5000` 可以用較少的資料除錯。

設計決策與討論過程依階段記錄在 [docs/adr/](docs/adr/README.md)。

## 功能對照
| 需求 | 做法 |
|---|---|
| 千萬筆資料、每次 500 筆、無限捲動 | 捲到離底部 150 列內就載入下一批；列表用虛擬捲動（只渲染畫面看得到的約 25 列） |
| 刪除＋確認視窗 | 確認視窗顯示要刪的人，按「確定刪除」才呼叫 API |
| 更新＋確認視窗 | 表單 →「下一步」→ 確認視窗列出「原本 / 改為」→「確定更新」；前後端共用驗證規則 |
| 搜尋所有欄位 | 一個搜尋框，不分大小寫、部分符合任一欄位；停止輸入 300ms 才查詢 |
| 所有欄位排序 | 點表頭：升冪 → 降冪 → 取消 |
| 手動釘選 | 列上按「釘選」輸入第幾列；之後不論怎麼排序都顯示在那一列（📌 標示） |

## 架構
```
src/
  types/user.ts            資料與 API 型別
  utils/validate.ts        前後端共用的欄位驗證
  mock/db.ts               mock 後端：千萬筆記憶體資料庫（排序、搜尋、釘選、增刪改）
  mock/worker.ts           把 db 放進 Web Worker（背景執行緒），畫面不會卡
  mock/server.ts           假的 fetch：依「方法 + 網址」分派、模擬 150–400ms 網路延遲、支援 AbortSignal，回傳真正的 Response
  mock/setup.ts            把 API 層的 fetch 換成 mock（main.ts 呼叫）
  api/http.ts              共用 request()：fetch + signal + 依狀態碼丟 HttpError
  api/users.ts             各支 API 的網址與參數
  composables/useUserList.ts  列表狀態：分批載入、排序、搜尋、刪改後同步
  components/              UserTable（虛擬捲動表格）、各種對話框
tests/db.test.ts           與「最直白的參考實作」逐筆對照
e2e/run.mjs                Playwright 實際操作瀏覽器
```

### 打 API 的方式
元件和 composable 只呼叫 `usersApi.list(query, signal)` 這類函式，底層是標準的 `fetch(url, { method, body, signal })`。
目前 `main.ts` 用 `setupMock()` 把 fetch 換成 mock；**接真後端時刪掉那一行**，就會改用瀏覽器原生 fetch 打 `/api/users`。

### 取消過期請求（AbortController）
- 換搜尋字、點表頭排序、元件卸載時，會呼叫 `controller.abort()` 取消還沒回來的查詢
- 在模擬網路延遲期間取消：請求不會送到後端；後端處理中取消：前端立刻收到 `AbortError`，結果直接丟掉
- 修改類請求（更新、刪除、釘選）**刻意不能取消**：請求一旦送出，後端可能已經改好，前端取消只會讓畫面和資料不一致
- 畫面上方顯示「已取消 N 個過期請求」，方便 demo

### API 介面（mock 依照這個形狀實作）
```
GET    /api/users?q=&sortBy=&order=asc|desc&cursor=&limit=500
       → { data: UserRow[], nextCursor: string|null, hasMore: boolean, total: number }
PATCH  /api/users/:id          body: { userName, position, location, age, dateStart }
DELETE /api/users/:id
PUT    /api/users/:id/pin      body: { position }    // 位置 1 起算
DELETE /api/users/:id/pin
```

## 設計決定
| 決定 | 理由 | 代價 |
|---|---|---|
| 每欄存成 TypedArray，字串只存字典編號 | 1,000 萬列約 70MB；字串物件要好幾 GB | 字串欄位的不同值有上限（姓名 65,535 種、職位/地點各 255 種），超過回 507 |
| 排序用 counting sort（計數排序） | 每欄不同值很少，O(n) 一次掃完，約 0.2–0.5 秒 | 只適用值域小的欄位；真實資料要靠資料庫索引 |
| 搜尋先比對「字典」再查表掃描 | 每種字串只比對一次，掃 1,000 萬列約 0.1–0.2 秒 | 只支援「包含」比對 |
| cursor = 查詢結果快照中的位置 | 捲動途中資料不會跳動；刪除時前端與 mock 同步調整位置 | 真實後端應改用 keyset（排序值 + id）游標 |
| 釘選位置超過資料量時排在最後 | 例如搜尋後只剩 3 筆，釘在第 100 列的會排第 4 | — |
| 搜尋不符合的釘選列不顯示 | 搜尋是「篩選」，顯示不相符的列會令人困惑 | 若需求是「釘選列永遠顯示」需改一行 |
| 同一位置只能釘一筆 | 避免兩筆搶同一列時順序不明 | 要換位置需先取消原本的 |
| 編輯後的列先留在原位，重新查詢才依新值排序 | 改完資料列突然跳走，使用者會找不到 | 畫面短暫不完全符合排序 |
| mock 放 Web Worker，前面包一層假 fetch | 千萬筆運算不卡畫面；呼叫端仍是標準 fetch 寫法，換真後端只刪一行 | 瀏覽器 Network 面板看不到請求 |

## 已驗證
- `npm test`：33 項通過（資料層 26 項、mock fetch 與取消 6 項、列表取消 1 項）。資料層測五個欄位升/降冪、7 組搜尋字、釘選、刪除、更新、錯誤處理，都和參考實作逐筆比對。
- `npm run perf`（Node 22，10,000,000 筆）：產生 348ms；排序 189–450ms；搜尋 85–173ms；刪除 22ms；記憶體約 183MB。
- `node e2e/run.mjs`（Chromium，10,000,000 筆）：15 項（含快速連點表頭取消 2 個過期請求）實際操作全部通過，截圖在 `e2e/screenshots/`。

## 尚未處理
- 一個人一直往下捲，已載入的列會一直累積（每 1 萬列約幾 MB）。可改成只保留最近幾批。
- 瀏覽器捲動高度上限約 3,300 萬 px，約等於 75 萬列。實際上要捲非常久才會碰到。
- 新增資料（題目沒有要求）。
