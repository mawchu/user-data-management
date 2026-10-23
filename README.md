# Q1

### Vue 3 優點（Pros）

1. Proxy 響應式：改善 Vue 2 新增、刪除物件屬性無法自動追蹤的限制。
2. Composition API：相關狀態與邏輯可以集中管理，方便抽成 Composable（類似 React Hooks）。
3. TypeScript 支援：更容易定義元件 Props、Emits 與 Composable 的型別契約。
4. 效能優化：透過編譯器優化，減少不必要的 DOM 更新。

### Vue 3 缺點（Cons）

1. 響應式學習成本：`ref`、`reactive` 使用方式不同，解構可能造成響應式失效。
2. 狀態變更難追蹤：多個 Composable 共用可變狀態時，容易不清楚誰修改了資料。
3. Watcher 副作用：`watch`、`watchEffect` 若管理不當，容易產生重複請求、非同步競態問題。
4. 遷移成本：Vue 2 升級 Vue 3，需要處理舊套件相容性與既有業務邏輯。

# Q2. 使用者資料管理系統

線上 Demo：<https://mawchu.github.io/user-data-management/>（加上 `?size=5000` 可以比較快開啟）。

開發過程中的一些取捨另外記錄在 [docs/adr/](https://github.com/mawchu/user-data-management/blob/main/docs/adr/README.md)。

### a. 實作

這題我用 Vue 3 + TypeScript 完成 CRUD、搜尋、排序、釘選和無限捲動。因為沒有實際 API，所以另外用 Web Worker 模擬一個能處理一千萬筆資料的後端。

面對大量資料，我主要處理幾個問題：

- 請求管理：搜尋加上 300ms 防抖、取消過期請求，以及首批資料 30 秒快取，減少連續操作產生的不必要請求。
- 大量資料：每次載入 500 筆，在 mock 後端實作 Keyset Cursor，前端帶著 `nextCursor` 查詢下一頁，降低資料增刪造成分頁漏筆的問題。畫面則用虛擬捲動和 DOM 回收，避免一次渲染太多元素。
- 資料一致性：釘選只調整前端顯示順序，不修改原始資料。多人修改同一筆資料時，則透過 Version 檢查，遇到 409 衝突再讓使用者選擇怎麼處理。

### b. 搜尋請求從每分鐘 5 次增加到 500 次

我會先確認請求增加的原因，不一定是異常流量，也可能是使用者變多。

這次實作已經加入搜尋防抖、取消舊請求和快取。另外，測試時也發現 API 失敗會讓無限捲動反覆觸發請求，反而自己製造流量，所以改成失敗後暫停自動載入，等使用者手動重試。

如果確認是正常使用量成長，就需要再跟後端一起檢查查詢效能和快取策略。

### c. RAM 使用量過高

我先從畫面渲染下手，用虛擬捲動和 DOM 回收減少實際存在的元素，再搭配 `shallowRef` 降低響應式處理的成本。

不過這只能解決一部分問題。已經載入的 JS 資料還是會一直累積。下一步考慮只保留最近約 5,000 筆，往回捲時再重新取得資料，但這部分還沒有實作。

# Q3. Blog Admin 後台設計

### 1. Dashboard

![Dashboard](images/01-dashboard.png)

可以選擇特定時間區間，比較本期與上期的使用者、文章及收藏變化，同時參考累計總數，快速了解網站的整體情況。

### 2. User Management

![User management](images/02-user-management.png)

可以搜尋使用者、查看身分與權限。點擊列表後，詳細資訊會顯示在右側，不需要離開列表，就能查看文章數量或調整權限。

### 3. Favorites Management

![Favorites management](images/03-favorites.png)

依照「使用者 → 資料夾 → 收藏文章」的方式呈現，沿用大家熟悉的資料夾操作習慣，方便逐層查看內容，也能快速了解哪些文章最受歡迎。
