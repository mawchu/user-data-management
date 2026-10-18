# 0006 mock 資料庫放在 Web Worker

- 狀態：採用
- 階段：3 千萬筆資料層

## 背景
產生並排序一千萬筆，每次要花 0.2 到 0.5 秒。如果放在主執行緒，這段時間畫面會完全卡住。

## 決策
資料庫跑在 Web Worker（瀏覽器的背景執行緒），主執行緒用 `postMessage` 呼叫它，結果包成 Promise。

## 放棄的選項
- MSW（Mock Service Worker）：它的 handler 實際上在主執行緒執行，重運算一樣會卡住畫面。
- 本機 Node mock server：資料不會佔用瀏覽器記憶體，但沒辦法做成單一靜態網頁來 demo。

## 代價
- 瀏覽器開發者工具的 Network 面板看不到請求。
- 每個分頁各自產生一份資料（約 180MB），而且資料不會在使用者之間共享。這是 mock 本身的成本，接上真 API 之後就沒有這個問題。

## 相關檔案
`src/mock/worker.ts`、`src/mock/backend.ts`
