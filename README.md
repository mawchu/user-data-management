# 使用者資料管理後臺（Vue 3）

重點是前端：拿到 API 回傳的資料後，每次 500 筆無限捲動、虛擬捲動、取消過期請求，以及刪除、更新、釘選的確認流程。沒有真 API，所以附了一個能撐千萬筆的 mock 後端，用真實規模來驗證這些前端行為。

前端實作的解題思路與程式碼位置見 [docs/code-map.md](docs/code-map.md)。

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
  # 前端
  components/UserTable.vue    虛擬捲動表格：只渲染看得到的列，快到底時提早載入下一批
  components/*Dialog.vue      編輯、確認、釘選對話框（原生 <dialog>）
  App.vue                     對話框流程、搜尋防抖
  composables/useUserList.ts  列表狀態：每次 500 筆、shallowRef、AbortController、刪改後同步
  api/http.ts                 共用 request()：fetch + signal + 依狀態碼丟 HttpError
  api/users.ts                各支 API 的網址與參數
  types/user.ts               資料與 API 型別
  utils/validate.ts           前後端共用的欄位驗證

  # 測試用 mock 後端（接真 API 時不需要）
  mock/setup.ts               把 API 層的 fetch 換成 mock（main.ts 呼叫）
  mock/server.ts              假的 fetch：依「方法 + 網址」分派、模擬 150–400ms 網路延遲、支援 AbortSignal
  mock/worker.ts, backend.ts  把 db 放進 Web Worker
  mock/db.ts                  千萬筆記憶體資料庫

tests/                        單元測試
e2e/run.mjs                   Playwright 實際操作瀏覽器
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

### 前端
| 決定 | 理由 | 代價 |
|---|---|---|
| 自己寫虛擬捲動，不引入 UI 套件 | 不論載入幾筆，DOM 固定約 25–30 列；能說明原理、少一個大型依賴 | 列高必須固定 |
| 列表用 `shallowRef`，修改時換新陣列 | 上萬筆資料不需要深層響應式；實測 concat、findIndex 快 5–20 倍 | 不能直接改 `rows[i].x`，要用 concat / toSpliced / with |
| 換搜尋或排序時用 AbortController 取消舊查詢 | 避免慢的舊結果晚回來蓋掉新結果 | — |
| 修改類請求不取消 | 送出後後端可能已經改好，取消只會讓畫面和資料不一致 | — |
| 刪除後 cursor 往前一格 | 後端結果少一筆，不修正就會漏掉一筆 | 依賴「cursor 是位置」；改用 keyset cursor 就不需要 |
| 釘選位置超過資料量時排在最後 | 例如搜尋後只剩 3 筆，釘在第 100 列的會排第 4 | — |
| 搜尋不符合的釘選列不顯示 | 搜尋是「篩選」，顯示不相符的列會令人困惑 | 若需求是「釘選列永遠顯示」需改一行 |
| 同一位置只能釘一筆 | 避免兩筆搶同一列時順序不明 | 要換位置需先取消原本的 |
| 編輯後的列先留在原位，重新查詢才依新值排序 | 改完資料列突然跳走，使用者會找不到 | 畫面短暫不完全符合排序 |
| 搜尋停止輸入 300ms 才查詢（防抖） | 每打一個字就查一次，會產生大量無用請求 | 查詢慢 300ms 才開始 |

### mock 後端（只為了測試，正式環境由資料庫負責）
| 決定 | 理由 | 代價 |
|---|---|---|
| mock 放 Web Worker，前面包一層假 fetch | 千萬筆運算不卡畫面；呼叫端仍是標準 fetch 寫法，換真後端只刪一行 | 瀏覽器 Network 面板看不到請求 |
| 每欄存成 TypedArray，字串只存字典編號 | 1,000 萬列約 70MB；用物件要 1GB 以上 | 字串欄位的不同值有上限，超過回 507 |
| 排序用計數排序，搜尋先比對字典 | 在瀏覽器裡把排序壓在 0.2–0.5 秒、搜尋壓在 0.1–0.2 秒 | 只適用值域小的欄位 |
| cursor = 查詢結果快照中的位置 | 捲動途中資料不會跳動 | 真實後端應改用 keyset（排序值 + id）游標 |

## 已驗證
- `npm test`：33 項通過（資料層 26 項、mock fetch 與取消 6 項、列表取消 1 項）。資料層測五個欄位升/降冪、7 組搜尋字、釘選、刪除、更新、錯誤處理，都和參考實作逐筆比對。
- `npm run perf`（Node 22，10,000,000 筆）：產生 348ms；排序 189–450ms；搜尋 85–173ms；刪除 22ms；記憶體約 183MB。
- `node e2e/run.mjs`（Chromium，10,000,000 筆）：15 項（含快速連點表頭取消 2 個過期請求）實際操作全部通過，截圖在 `e2e/screenshots/`。

## 尚未處理
- 一個人一直往下捲，已載入的列會一直累積（每 1 萬列約幾 MB）。可改成只保留最近幾批。
- 瀏覽器捲動高度上限約 3,300 萬 px，約等於 75 萬列。實際上要捲非常久才會碰到。
- 新增資料（題目沒有要求）。
