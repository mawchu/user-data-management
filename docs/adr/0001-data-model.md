# 0001 資料模型：5 個欄位加上 id

- 狀態：採用
- 階段：1 資料結構

## 背景
題目給了 5 個欄位：User name (String)、Position (String)、Location (String)、Age (Integer)、Date Start (YYYY-mm-dd)，總量超過一千萬筆。之後還要支援刪除、更新、釘選。

## 決策
- 欄位命名用 camelCase：`userName`、`position`、`location`、`age`、`dateStart`，符合 JS 與 Vue 的慣例。
- **多加一個 `id`（題目沒有）**。`v-for` 的 `:key`、刪除、更新、釘選、分頁游標，都需要一個穩定的識別碼。
- `dateStart` 維持 `YYYY-MM-DD` 字串，不轉成 Date 物件：傳輸和顯示都直接用，也不會有時區偏移。
- 驗證規則寫在 `src/utils/validate.ts`，前端表單和 mock 後端共用，不會有兩套標準。

## 代價
- 和題目的 5 欄不完全一樣，需要另外說明理由。
- 如果後端用 snake_case，API 層需要轉換。

## 相關檔案
`src/types/user.ts`、`src/utils/validate.ts`
