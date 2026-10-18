# API 契約

前端只依賴這份文件描述的行為。目前由 `src/mock/` 實作，接真後端時對方要遵守同一份契約。

## 資料格式

```ts
User = { id, userName, position, location, age, dateStart, version }
```

- `age` 是整數，`dateStart` 是 `YYYY-MM-DD`。
- `version` 每次更新加 1，前端更新時要帶上（見 PATCH）。

## GET /api/users

查詢參數：`q`、`sortBy`、`order`、`cursor`、`limit`（最多 500）

回應：`{ data: User[], nextCursor: string | null, hasMore: boolean, total: number }`

- **搜尋與排序由後端對全部資料處理**，前端拿到的每一批，都是全域結果中接續的 500 筆。
- `q`：任一欄位包含關鍵字就符合，不分大小寫（規則在 `src/utils/match.ts`，前後端共用）。
- 排序：同值時依 id 由小到大，所以結果的順序是固定的。
- `cursor`：前端不解析，原樣帶回。
  - 內容是上一批最後一筆的「排序值 + id」（keyset）。下一批從排在它後面的第一筆開始。
  - **保證**：捲動途中有人新增或刪除資料，下一批也不會漏掉或重複。
  - 捲動途中新增、且排在已載入範圍內的資料，要重新查詢才會出現。
- `total`：符合條件的總筆數，是第一批查詢當下的數字，之後刪除時會跟著減少。
- **429**：查詢太頻繁時回傳，`Retry-After` 標頭是建議等待的秒數。

## GET /api/users/:id

取得單筆資料，用來在開啟頁面時取回釘選列的最新內容。不存在時回 404。

## POST /api/users

body：5 個欄位。成功回 201 和新增的 `User`（`version` 為 1）。

## PATCH /api/users/:id

body：5 個欄位 + `version`（前端讀到的版本）

| 狀態碼 | 意義 | 前端怎麼處理 |
|---|---|---|
| 200 | 成功，回傳新的 `User`（version + 1） | 原地換掉那一列 |
| 404 | 資料已被刪除 | 從列表移除，提示使用者 |
| 409 | 版本不一致，表示有人先改過。`details.current` 是目前的資料 | 列表先換成最新內容，再列出差異讓使用者選擇：放棄、重新編輯，或用自己的版本覆蓋（帶 `current.version` 再送一次） |
| 422 | 欄位驗證失敗，`details` 是各欄位的錯誤訊息 | 回到表單並標出錯誤欄位 |

## DELETE /api/users/:id

成功回 204。不存在時回 404，前端一樣從列表移除，並提示「已被其他人刪除」。

## 不在後端的功能

**釘選**是每個使用者自己的顯示設定，存在瀏覽器的 localStorage，由前端合併到列表裡，所以後端沒有釘選相關的 API（見 ADR 0015）。
