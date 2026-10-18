# 前端實作地圖與解題思路

> 用途：面試前複習。重點是**拿到 API 資料之後，前端做了什麼、為什麼這樣做**。
> 每節照同一個順序：問題 → 做法（程式碼加行號）→ 代價 → 怎麼驗證。標「事實」的是程式碼或實測，標「推測」的是原理推論。

## 一張圖看資料流

```
使用者捲動 / 輸入搜尋 / 點表頭 / 按刪除、編輯、釘選
        │
UserTable.vue   虛擬捲動：不論載入幾筆，只畫看得到的約 30 列
        │ emit('loadMore')
App.vue         確認視窗流程、搜尋防抖 300ms
        │
useUserList.ts  每次 500 筆、shallowRef、AbortController、刪除後 cursor - 1
        │ usersApi.list(query, signal)
api/users.ts → api/http.ts   標準 fetch 寫法
════════════════ 以上是前端；以下正式環境是後端 API ════════════════
mock/*          測試用的假後端（附錄），接真 API 時在 main.ts 刪一行即可
```

前端拿到的永遠只是一批 500 筆的 JSON：`{ data, nextCursor, hasMore, total }`。搜尋、排序、釘選合併都由後端完成。

## 先讀這 4 個檔案

| 順序 | 檔案 | 解決什麼 |
|---|---|---|
| 1 | `src/composables/useUserList.ts`（98 行） | 一次載入 500 筆、取消過期請求、刪改後同步畫面 |
| 2 | `src/components/UserTable.vue`（213 行） | 虛擬捲動、提早載入下一批 |
| 3 | `src/api/http.ts`、`src/api/users.ts` | 打 API 的方式、AbortSignal |
| 4 | `src/App.vue`（314 行） | 刪除、更新、釘選的確認視窗 |

---

## 1. 每次 500 筆的無限捲動與 cursor（ADR 0003）

### 問題
1,000 萬筆不可能一次拿。用頁碼（page=3）的話，前面有人刪資料，第 3 頁的內容就會整個往前移，造成重複或漏資料（ADR 0002，已被取代）。

### 做法
`src/composables/useUserList.ts:27-51`
```ts
async function loadMore() {
  if (loading.value || !hasMore.value) return                 // 正在載入或已經到底就不重複請求
  const current = (controller = new AbortController())
  loading.value = true
  try {
    const response = await usersApi.list({ ...query, cursor, limit: BATCH }, current.signal)  // BATCH = 500
    rows.value = rows.value.concat(response.data)              // 接在已載入的資料後面
    total.value = response.total
    cursor = response.nextCursor                               // 後端告訴我「下一批從哪裡開始」
    hasMore.value = response.hasMore
  } catch (requestError) {
    if (!isAbortError(requestError)) error.value = (requestError as Error).message  // 被取消不算錯誤
  } finally {
    if (controller === current) { loading.value = false; controller = null }
  }
}
```
- **cursor** 是後端給的「書籤」，前端不必知道它的意義，只要原封不動地傳回去。
- **觸發時機**在 `UserTable.vue:76-83`：離已載入的底部剩不到 150 列就先抓下一批（見第 3 節）。

### 刪除後為什麼 cursor 要減 1
`useUserList.ts:73-82`
```ts
rows.value = rows.value.toSpliced(rowIndex, 1)
if (cursor) cursor = String(Number(cursor) - 1)   // 後端結果少了一筆，書籤往前一格，下一批才不會漏掉一筆
```
**例子**：已載入 500 筆，cursor = 500。刪掉第 10 筆後，原本的第 501 筆變成第 500 筆。如果 cursor 還是 500，下一批會從原本的第 502 筆開始，第 501 筆就被跳過了。
（這個做法依賴「cursor 是位置」。若後端改用 keyset cursor，也就是「最後一筆的排序值 + id」，就不用修正。這點在 README「尚未處理」有寫。）

### 驗證（事實）
e2e：刪除 #7 後繼續捲動，前 1,009 列的 id 沒有重複，被刪的列也沒有再出現。

---

## 2. shallowRef：減少響應式造成的負擔（ADR 0009）

### 問題
`ref([])` 是**深層響應式**：Vue 會把陣列和裡面每個物件都包成 Proxy（代理物件：讀寫屬性時會先經過 Vue，讓 Vue 記錄「誰用到這個值」）。列表資料有上萬筆時，每次 `concat`、`findIndex` 都要穿過 Proxy、逐格記錄依賴。

### 做法
`src/composables/useUserList.ts:10-11`
```ts
// shallowRef：數萬筆資料不需要深層響應式，省記憶體也更快
const rows = shallowRef<UserRow[]>([])
```
`shallowRef` 只追蹤 `.value` 這一層：**整個陣列被換掉**才會觸發更新，陣列裡的物件就是普通 JS 物件。

### 配套：一定要「換新陣列」，不能 push
因為只追蹤 `.value`，`rows.value.push(...)` 不會觸發畫面更新（這個 bug 開發時真的踩過，畫面不出現新資料）。所以所有修改都回傳新陣列：

| 動作 | 位置 | 寫法 |
|---|---|---|
| 載入下一批 | `useUserList.ts:38` | `rows.value = rows.value.concat(response.data)` |
| 刪除一列 | `useUserList.ts:77` | `rows.value = rows.value.toSpliced(rowIndex, 1)` |
| 更新一列 | `useUserList.ts:88` | `rows.value = rows.value.with(rowIndex, updated)` |
| 重新查詢 | `useUserList.ts:56` | `rows.value = []` |

`toSpliced`、`with` 是 ES2023 新增的陣列方法：和 `splice`、`arr[i] = x` 效果一樣，但**不改原陣列、回傳新陣列**。

### 實測（事實，Node 環境的簡化版測試，不是瀏覽器）
2 萬筆資料，分 40 批 concat，再做 200 次 `findIndex`：

| | 40 次 concat | 200 次 findIndex |
|---|---|---|
| `ref` | 167–257ms | 671–781ms（每次約 3.5ms） |
| `shallowRef` | 19–48ms | 29–32ms（每次約 0.15ms） |

約快 5–20 倍。測試腳本是一次性的，沒有放進專案；需要的話可以加到 `tests/perf.test.ts`。

### 代價
- 不能直接改 `rows.value[3].age = 40`，畫面不會更新。整個專案統一用「換新陣列」來規避。
- 新進同事容易踩到，所以在 `useUserList.ts:37` 留了註解。

**Vue 2 對照（面試加分）**：Vue 2 用 `Object.defineProperty` 在初始化時就遞迴把每個屬性轉成 getter/setter，1 萬筆就要立刻轉 7 萬個屬性。Vue 2 常見的解法是 `Object.freeze(list)`，讓 Vue 跳過轉換，概念和 `shallowRef` 相同。

---

## 3. 虛擬捲動：用高度算出可視範圍（ADR 0007）

### 問題
捲到 5,000 筆，就有 5,000 列 × 8 格 = 4 萬個 DOM 節點。每個節點都佔記憶體，而且瀏覽器每次排版都要處理它們，捲動會卡。

### 做法：固定列高 → 用數學算出該畫哪幾列
`src/components/UserTable.vue:37-57`
```ts
const ROW_HEIGHT = 44     // 每列固定 44px
const OVERSCAN = 8        // 上下各多畫 8 列，快速捲動時不會閃白
const start = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN))
const end = computed(() =>
  Math.min(props.rows.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN),
)
const visibleRows = computed(() => props.rows.slice(start.value, end.value))
```

**代入數字**：視窗高 600px，已經捲了 4,400px。
- `start = floor(4400 / 44) - 8 = 100 - 8 = 92`
- `end = ceil((4400 + 600) / 44) + 8 = 114 + 8 = 122`
- 只畫第 92～121 列，共 30 列，不論已經載入 500 筆還是 5 萬筆。

### 讓捲軸看起來是真的
`UserTable.vue:154-161`
```html
<div class="body" :style="{ height: `${rows.length * ROW_HEIGHT}px` }">          <!-- 撐出完整高度，捲軸長度才正確 -->
  <div class="window" :style="{ transform: `translateY(${start * ROW_HEIGHT}px)` }"> <!-- 把那 30 列移到正確位置 -->
```
用 `transform` 而不是 `top`：transform 不會觸發重新排版（reflow），只需要重新合成畫面，比較順。

### 你說的 observer：這裡用的是 ResizeObserver，不是 IntersectionObserver
`UserTable.vue:59-74`
```ts
function onScroll() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => (scrollTop.value = scroller.value?.scrollTop ?? 0))  // 每個畫面幀最多更新一次
}
observer = new ResizeObserver(([entry]) => (viewportHeight.value = entry.contentRect.height))  // 視窗大小改變時更新高度
```
| | ResizeObserver（本專案） | IntersectionObserver |
|---|---|---|
| 用途 | 監聽「元素尺寸改變」 | 監聽「元素是否進入可視範圍」 |
| 在這裡做什麼 | 取得捲動容器的高度（使用者縮放視窗時） | 常用來做「看到最後一列就載入更多」 |
| 為什麼這樣選 | 列高固定，用 scrollTop 算就知道範圍，不必替每一列掛監聽 | 要先把列渲染出來才能觀察，和「不渲染」的目標衝突 |

### 提早載入下一批
`UserTable.vue:76-83`
```ts
watchEffect(() => {
  if (props.hasMore && !props.loading && props.rows.length - end.value < PREFETCH_ROWS) emit('loadMore')
})
```
離已載入的底部剩不到 150 列就先抓下一批，使用者捲到時資料通常已經到了。

### 代價
- 列高必須固定。內容太長只能截斷，不能自動換行撐高。
- 瀏覽器內建的 Ctrl+F 搜不到沒渲染的列，所以專案有自己的搜尋框。

### 怎麼驗證（事實）
e2e 第 2 步：已載入 500 筆，但 DOM 裡只有 25 列（`e2e/run.mjs`）。

---

## 4. AbortController：取消過期的查詢（ADR 0010）

### 問題（競態，race condition）
使用者快速連點表頭三次（升冪 → 降冪 → 取消）。三個請求同時在路上，如果第一個最慢回來，畫面會被舊結果蓋掉。
**支付流程類比**：連按兩次「查詢付款狀態」，慢的那次回傳「待付款」，結果蓋掉了快的那次「已付款」。

### 做法
`useUserList.ts:53-62`
```ts
function reload() {
  controller?.abort()      // 取消還在路上的舊查詢
  controller = null
  rows.value = []
  cursor = null
  ...
  return loadMore()
}
```
- 換搜尋字、點表頭、釘選後都會呼叫 `reload()`。元件卸載時也會取消（`useUserList.ts:104`）。
- `signal` 一路傳到 fetch：`api/users.ts` 的 `list(query, signal)` → `api/http.ts` 的 `request(..., { signal })`。
- 被取消的請求會丟出 `AbortError`，`isAbortError()`（`http.ts:12`）把它和真正的錯誤分開，不顯示錯誤訊息。
- `finally` 裡的 `controller === current`（`useUserList.ts:46`）：被取消的舊請求不能把「新請求的 loading」關掉。

### 刻意不取消的：修改類請求
更新、刪除、釘選送出後就不取消（`api/users.ts` 這幾支沒有 signal 參數）。請求一旦到了後端，資料可能已經改好；前端這時取消，只會讓畫面和實際資料不一致。

### 驗證（事實）
- 單元測試：`tests/mock-fetch.test.ts`（6 項）、`tests/use-user-list.test.ts`（1 項）。
- e2e：快速連點 Location 三次，取消了 2 個過期請求，畫面停在最後一次的結果。畫面上方也會顯示「已取消 N 個過期請求」。

---

## 5. 確認視窗與修改流程（ADR 0009）

### 做法：用一個狀態描述「現在開著哪個視窗」
`src/App.vue:49-58`
```ts
type Dialog =
  | { type: 'edit'; row: UserRow; draft?: UserInput; serverErrors?: FieldErrors }
  | { type: 'confirmUpdate'; row: UserRow; input: UserInput }
  | { type: 'confirmDelete'; row: UserRow }
  | { type: 'pin'; row: UserRow; index: number }
  | { type: 'confirmUnpin'; row: UserRow }
```
同一時間只會有一個視窗，不需要 5 個 `showXxxDialog` 布林值，也不會出現兩個視窗同時開著的錯誤狀態。

**更新的流程**：編輯表單 →「下一步」→ 確認視窗列出「原本 / 改為」（`App.vue:78-89` 的 `changes`）→「確定更新」才打 API。
- 後端驗證失敗（422）時，回到編輯表單並標出錯誤欄位（`App.vue:106-122`）。
- 前後端共用同一份驗證規則（`utils/validate.ts`），前端先擋一次，後端再擋一次。

**共用的執行函式** `App.vue:91-104`：`run()` 統一處理「處理中」狀態、錯誤訊息、成功後關窗並顯示提示。

**原生 `<dialog>`**（`components/BaseDialog.vue`）：`showModal()` 內建焦點鎖定、按 Esc 關閉、背景遮罩，不用自己寫。

### 釘選在前端的部分（ADR 0008）
釘選的位置合併是後端的工作。前端負責的是：
- 讓使用者輸入位置並驗證是 1 以上的整數（`components/PinDialog.vue`）。
- 呼叫 `PUT /api/users/:id/pin`，成功後 `reload()` 從頭查詢（`useUserList.ts:93-101`）。
- 位置已被別人釘選時，後端回 409，視窗直接顯示錯誤訊息，不關窗。
- 依 `pinnedAt` 欄位顯示 📌（`UserTable.vue:180`），並切換「釘選 / 取消釘選」按鈕（233-246 行）。

---

## 6. 如何減少 RAM？有沒有用虛擬 DOM？

### 先釐清兩個名詞
- **虛擬 DOM（virtual DOM）**：Vue 本身的機制。Vue 先在 JS 裡建一棵「描述畫面的物件樹」，和上一次比對差異，只把有變的地方寫進真正的 DOM。這個專案有用到，因為 Vue 就是這樣運作的。
- **虛擬捲動（virtual scroll）**：我們自己寫的，決定「哪些列要交給 Vue 去畫」。

虛擬 DOM 解決的是「更新時改最少的 DOM」，**不會減少要畫的數量**。把 5,000 列交給 Vue，就會有 5,000 列的虛擬節點和真實 DOM。虛擬捲動先把數量降到約 30 列。

**面試回答模板**：「Vue 有虛擬 DOM，但它解決的是更新效率，不是 DOM 太多。DOM 太多要靠虛擬捲動，只渲染可視範圍。」

### 前端三層省記憶體
| 層 | 做法 | 位置 | 效果 |
|---|---|---|---|
| 傳輸 | 一次只拿 500 筆 | `useUserList.ts:6, 33` | 只持有看過的資料，不是 1,000 萬筆 |
| 狀態 | `shallowRef`，不替每筆資料建 Proxy | `useUserList.ts:11` | 見第 2 節實測 |
| 畫面 | 虛擬捲動 | `UserTable.vue:37-57` | DOM 固定約 25–30 列 |
| 回收 | 清空、取消、卸載時清理 | 見第 7 節 | 不要的東西能被回收 |

---

## 7. 回收機制（垃圾回收，garbage collection）

### 先講原理（事實）
JS **沒有**「手動釋放記憶體」的 API。引擎會定期找出「再也沒有人引用的物件」並回收。所以前端能做的是**讓不要的東西變成沒人引用**，以及**少製造垃圾**。

### 本專案已經做的
| 做法 | 位置 | 回收了什麼 |
|---|---|---|
| 重新查詢時清空列表 | `useUserList.ts:56` `rows.value = []` | 舊的幾百到幾萬個列物件失去引用，下次 GC 會回收 |
| 換新陣列而不是修改 | `useUserList.ts:38,77,88` | 舊陣列失去引用（列物件本身沿用，不會重複佔用） |
| 虛擬捲動 | `UserTable.vue:57`、`v-for :key="row.id"`（163-164） | 捲出畫面的列，Vue 會卸載它的 DOM 和 vnode |
| 取消過期請求 | `useUserList.ts:54`、`server.ts:98-109` | 舊請求的結果直接丟掉，事件監聽也移除，不會殘留 |
| 元件卸載時清理 | `useUserList.ts:104`、`UserTable.vue:74` | 取消請求、`observer.disconnect()`，避免記憶體洩漏（leak：該回收卻一直被引用） |

### 還沒做的：已載入資料的「滑動視窗回收」（ADR 0011 列為待做）
**目前的限制（事實）**：使用者一路往下捲，`rows` 會一直變長。捲到 5 萬筆，主執行緒就持有 5 萬個物件（推測約 10MB 上下，沒有實測）。DOM 不會變多，但 JS 物件會。

**做法構想**（尚未實作，可以當面試的延伸回答）：
```ts
const MAX_ROWS = 5_000   // 只保留最近 10 批

// 載入新的一批後，如果超過上限，就丟掉最前面的列，並記住丟了多少
rows.value = rows.value.concat(response.data)
if (rows.value.length > MAX_ROWS) {
  const drop = rows.value.length - MAX_ROWS
  rows.value = rows.value.slice(drop)   // 前面的列失去引用 → 可以被 GC
  droppedBefore += drop                 // 虛擬捲動要把這段高度補回來
}
// 往回捲到 droppedBefore 以內時，用 cursor = 該位置 重新抓那一批
```
**代價**：往回捲要重新請求；虛擬捲動的高度計算要加上 `droppedBefore * ROW_HEIGHT`；刪除時 cursor 的修正也要一起考慮。這是複雜度換記憶體，所以先列在 ADR 0011，等真的有需求再做。

**為什麼不是把超出範圍的資料設成 null**：設成 null 確實會讓物件被回收，但陣列長度不變、每格仍佔一個指標。上面的構想是直接縮短陣列，並配合 cursor 重新抓取。

### 怎麼驗證回收有沒有發生
Chrome DevTools → Memory 分頁：
1. 載入頁面，拍一張 Heap snapshot。
2. 捲到 5,000 筆，再拍一張。
3. 輸入搜尋字（觸發 `reload()` 清空列表），按垃圾桶圖示手動觸發 GC，再拍一張。
4. 比較三張的 `Object` 數量：第 3 張應該接近第 1 張。如果沒有降下來，用 Comparison 檢視找出是誰還在引用。

---

## 面試自我檢查（每題不看稿講 1 分鐘）

1. 為什麼用 cursor 而不是頁碼？刪除後 cursor 為什麼要減 1？（第 1 節）
2. 為什麼用 `shallowRef`？為什麼不能直接 push？（第 2 節）
3. 虛擬捲動怎麼算出要畫哪幾列？為什麼列高要固定？用的是哪個 Observer？（第 3 節）
4. AbortController 解決什麼問題？為什麼修改類請求不取消？（第 4 節）
5. 確認視窗的狀態怎麼管理？後端回 422、409 時畫面怎麼處理？（第 5 節）
6. Vue 的虛擬 DOM 和虛擬捲動差在哪？（第 6 節）
7. 使用者一路往下捲，記憶體會怎樣？怎麼改善？（第 7 節）
8. 50 人同時使用，前端能做什麼？（ADR 0011：搜尋防抖、取消過期請求、相同查詢快取、409 版本衝突提示）

---

## 附錄：mock 假後端（不是面試重點）

`src/mock/` 只是為了在沒有真 API 的情況下，用 1,000 萬筆的真實規模測試上面的前端行為。正式環境刪掉 `main.ts` 的 `setupMock()` 那一行就會改打真的 `/api/users`。

被問到時可以這樣說：「為了讓 mock 在瀏覽器裡撐得住千萬筆，我用欄式 TypedArray 存資料（約 70MB），排序用計數排序，並放在 Web Worker 裡，不讓主畫面卡住。正式環境這些是資料庫和索引的工作。」

| 檔案 | 內容 | ADR |
|---|---|---|
| `mock/db.ts` | 欄式 TypedArray、字典編碼、計數排序、查詢快照、釘選合併 | 0004、0005、0008 |
| `mock/worker.ts`、`mock/backend.ts` | 把 db 放進 Web Worker | 0006 |
| `mock/server.ts` | 假的 fetch：路由、150–400ms 延遲、可被 signal 取消，回傳真的 Response | 0010 |
