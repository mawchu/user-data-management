# 0010 模擬 fetch，並用 AbortController 取消過期查詢

- 狀態：採用（取代 0006 中「API 層直接呼叫 Worker」的寫法）
- 階段：5 API 層

## 背景
- API 層原本直接用 `postMessage` 呼叫 Worker，寫法和真實專案不一樣。
- 使用者快速切換排序或搜尋時，舊的請求還在跑，既浪費資源，也可能晚回來蓋掉新的結果。

## 決策
- API 層照真實寫法：`fetch('/api/users?...', { method, body, signal })`，再依狀態碼丟出 `HttpError`。
- `src/mock/server.ts` 是一個假的 fetch：依「方法 + 網址」分派給資料庫，模擬 150 到 400ms 的網路延遲，回傳真正的 `Response` 物件。
- `main.ts` 用 `setupMock()` 把 fetch 換成 mock。**接真後端時，只要刪掉這一行**。
- 換搜尋字、點表頭排序、元件卸載時，呼叫 `controller.abort()`：
  - 在網路延遲期間取消：請求根本不會送到後端。
  - 後端處理中取消：前端立刻收到 `AbortError`，結果直接丟掉。
- **修改類請求（更新、刪除、釘選）刻意不能取消**：請求一旦送出，後端可能已經改好了，前端取消只會讓畫面和資料不一致。
- 畫面上方顯示「已取消 N 個過期請求」，方便 demo。

## 驗證
- `tests/mock-fetch.test.ts`：網址參數解析、Response 狀態碼、錯誤轉換，以及兩種時機的取消。
- `tests/use-user-list.test.ts`：快速切換三次搜尋，取消 2 個請求，畫面只留下最後一次的結果。
- e2e：快速連點表頭三次，取消 2 個過期請求。
