# 0002 頁碼分頁（page / pageSize）

- 狀態：**被 [0003](0003-cursor-infinite-scroll.md) 取代**
- 階段：1 資料結構

## 背景
第一版草稿只確定了「不能一次把一千萬筆送到瀏覽器」。一千萬筆的 JSON 有好幾 GB，瀏覽器會直接卡死。

## 決策（當時）
`GET /api/users?page=1&pageSize=20`，回傳 `{ data, meta: { page, pageSize, total, totalPages } }`，pageSize 上限 100。

## 為什麼被取代
需求補充了「每次載入 500 筆、用無限捲動」。無限捲動只會往下接，用不到「跳到第 N 頁」。而且頁碼分頁在真實資料庫上用 `OFFSET`，頁數越後面越慢。
