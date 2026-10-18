# 架構決策紀錄（ADR）

ADR（Architecture Decision Record）：每份記錄一個決策的「當時背景、選了什麼、放棄了什麼、代價」。依開發階段排序；被取代的決策保留原文，標註由哪一份取代。

階段 3 是測試用的 mock 後端，正式環境由資料庫負責；前端的決策在階段 2、4、5、6。

| 編號 | 階段 | 決策 | 狀態 |
|---|---|---|---|
| [0001](0001-data-model.md) | 1 資料結構 | 5 個欄位加上 `id`，前後端共用型別與驗證 | 採用 |
| [0002](0002-page-based-pagination.md) | 1 資料結構 | 頁碼分頁 `page/pageSize` | 被 0003 取代 |
| [0003](0003-cursor-infinite-scroll.md) | 2 載入方式 | cursor 分頁，每批 500 筆，無限捲動 | 採用 |
| [0004](0004-columnar-storage.md) | 3 mock 後端（測試用） | 欄式 TypedArray 加字典編碼，不用物件或 Map | 採用 |
| [0005](0005-sort-and-search.md) | 3 mock 後端（測試用） | 計數排序；搜尋先比對字典再查表 | 採用 |
| [0006](0006-mock-in-web-worker.md) | 3 mock 後端（測試用） | mock 資料庫放在 Web Worker | 採用 |
| [0007](0007-virtual-scroll.md) | 4 畫面 | 自己實作虛擬捲動，不引入 UI 套件（v1：id 當 key） | 被 0012 取代 |
| [0008](0008-pinning-rules.md) | 4 畫面 | 釘選列的位置規則 | 採用 |
| [0009](0009-mutation-flow.md) | 4 畫面 | 刪除與更新：確認視窗、原地更新、標記刪除 | 採用 |
| [0010](0010-mock-fetch-abort.md) | 5 API 層 | 模擬 fetch，並用 AbortController 取消過期查詢 | 採用 |
| [0011](0011-concurrent-users-frontend.md) | 6 延伸題 | 50 人同時使用時前端要做的事 | 提議中 |
| [0012](0012-dom-recycling.md) | 4 畫面 | 虛擬捲動改成 DOM 回收（v2：同一組 DOM 輪流使用） | 採用 |
