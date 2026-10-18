# 前端實作地圖與解題思路

> 用途：面試前複習。重點是**拿到 API 資料之後，前端做了什麼、為什麼這樣做**。
> 每節照同一個順序：問題 → 做法（程式碼加行號）→ 代價 → 怎麼驗證。標「事實」的是程式碼或實測，標「推測」的是原理推論。
> API 的約定（cursor、409、429 的意義）在 [api.md](api.md)。

## 一張圖看資料流

```
使用者捲動 / 輸入搜尋 / 點表頭 / 按新增、刪除、編輯、釘選
        │
UserTable.vue     虛擬捲動 + DOM 回收：不論載入幾筆，固定約 40 個列元素輪流使用；手機改成卡片
        │ emit('loadMore')
App.vue           確認視窗與衝突視窗、搜尋防抖 300ms
        │
usePinnedRows.ts  釘選（個人設定，localStorage）：把釘選列插進已載入的資料
useUserList.ts    每次 500 筆、shallowRef、AbortController、失敗停止、保留舊資料、快取、429
        │ usersApi.list(query, signal)
api/users.ts → api/http.ts   標準 fetch 寫法
════════════════ 以上是前端；以下正式環境是後端 API ════════════════
mock/*          測試用的假後端（附錄），接真 API 時在 main.ts 刪一行即可
```

前端拿到的是一批 500 筆的 JSON：`{ data, nextCursor, hasMore, total }`。搜尋和排序要對全部資料才正確，所以交給後端；請求的生命週期、畫面狀態的一致性、釘選合併、衝突處理是前端的工作。

## 先讀這 4 個檔案

| 順序 | 檔案 | 解決什麼 |
|---|---|---|
| 1 | `src/composables/useUserList.ts` | 一次載入 500 筆、請求生命週期、新增刪改後同步畫面、409/404 |
| 2 | `src/composables/usePinnedRows.ts`、`src/utils/placePins.ts` | 釘選合併 |
| 3 | `src/components/UserTable.vue` | 虛擬捲動 + DOM 回收、提早載入下一批、手機卡片 |
| 4 | `src/App.vue` | 新增、刪除、更新、釘選的視窗，衝突視窗 |

---

## 1. 每次 500 筆的無限捲動與 cursor（ADR 0003、0013）

### 問題
1,000 萬筆不可能一次拿。用頁碼（page=3）的話，前面有人刪資料，第 3 頁的內容就會整個往前移，造成重複或漏資料（ADR 0002，已被取代）。

### 做法
`src/composables/useUserList.ts:145-175`（`loadMore`）
```ts
if (loading.value || !hasMore.value || error.value || stale.value) return  // 失敗或正在換條件時不送
const current = (controller = new AbortController())
const response = await fetchPage({ ...applied.value, cursor, limit: BATCH }, current.signal)
rows.value = rows.value.concat(data)   // 換成新陣列，shallowRef 才偵測得到
cursor = response.nextCursor           // 後端給的書籤，前端不解析
```
- **cursor** 是「上一批最後一筆的排序值 + id」（keyset）。下一批從排在它後面的第一筆開始，所以中途有人新增或刪除，都不會漏掉或重複。前端不用知道內容，原樣帶回去即可。
- **觸發時機**在 `UserTable.vue:140` 的 `watchEffect`：離已載入的底部剩不到 150 列就先抓下一批。

### 為什麼從「位置」改成 keyset（事實，實測過）
原本 cursor 是位置，刪除後前端要減 1。但如果下一批還在路上，請求回來後會用 `nextCursor` 蓋掉減 1 的修正：1,500 筆刪掉 1 筆，最後只載入 1,498 筆，#501 不見了。改成 keyset 後，前端刪除時完全不用碰 cursor，這個競態就消失了。

### 驗證（事實）
- `tests/use-user-list.test.ts`「載入下一批的途中刪除一筆」：結果剛好 1,499 筆，沒有重複。
- e2e：刪除後繼續捲動，前 999 列的 id 沒有重複，被刪的列也沒有再出現。

---

## 2. shallowRef：減少響應式造成的負擔（ADR 0009）

### 問題
`ref([])` 是**深層響應式**：Vue 會把陣列和裡面每個物件都包成 Proxy（代理物件：讀寫屬性時會先經過 Vue，讓 Vue 記錄「誰用到這個值」）。列表資料有上萬筆時，每次 `concat`、`findIndex` 都要穿過 Proxy、逐格記錄依賴。

### 做法
`src/composables/useUserList.ts:38-39`
```ts
// shallowRef：數萬筆資料不需要深層響應式，省記憶體也更快
const rows = shallowRef<User[]>([])
```
`shallowRef` 只追蹤 `.value` 這一層：**整個陣列被換掉**才會觸發更新，陣列裡的物件就是普通 JS 物件。

### 配套：一定要「換新陣列」，不能 push
因為只追蹤 `.value`，`rows.value.push(...)` 不會觸發畫面更新（這個 bug 開發時真的踩過，畫面不出現新資料）。所以所有修改都回傳新陣列：

| 動作 | 位置 | 寫法 |
|---|---|---|
| 載入下一批 | `useUserList.ts:161` | `rows.value = rows.value.concat(data)` |
| 刪除一列 | `useUserList.ts:213` | `rows.value = rows.value.toSpliced(rowIndex, 1)` |
| 更新一列 | `useUserList.ts:205` | `rows.value = rows.value.with(rowIndex, user)` |
| 新的第一批回來 | `useUserList.ts:100` | `rows.value = response.data` |
| 新增一列 | `useUserList.ts:227` | `rows.value = [created, ...rows.value]` |

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
- 新進同事容易踩到，所以在 `useUserList.ts:160` 留了註解。

**Vue 2 對照（面試加分）**：Vue 2 用 `Object.defineProperty` 在初始化時就遞迴把每個屬性轉成 getter/setter，1 萬筆就要立刻轉 7 萬個屬性。Vue 2 常見的解法是 `Object.freeze(list)`，讓 Vue 跳過轉換，概念和 `shallowRef` 相同。

---

## 3. 虛擬捲動 v1：用高度算出可視範圍（ADR 0007，已由 3-2 取代，保留原文）

> 這一節是 v1 的原始說明，內容不改，方便對照。v1 的程式碼保留在 `src/components/legacy/UserTableKeyed.vue`（目前沒有被使用），下面的行號都指向那個檔案。v2 改了什麼、為什麼改，見 [3-2](#3-2-虛擬捲動-v2dom-回收adr-0012)。

### 問題
捲到 5,000 筆，就有 5,000 列 × 8 格 = 4 萬個 DOM 節點。每個節點都佔記憶體，而且瀏覽器每次排版都要處理它們，捲動會卡。

### 做法：固定列高 → 用數學算出該畫哪幾列
`src/components/legacy/UserTableKeyed.vue:39-59`
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
`UserTableKeyed.vue:156-163`
```html
<div class="body" :style="{ height: `${rows.length * ROW_HEIGHT}px` }">          <!-- 撐出完整高度，捲軸長度才正確 -->
  <div class="window" :style="{ transform: `translateY(${start * ROW_HEIGHT}px)` }"> <!-- 把那 30 列移到正確位置 -->
```
用 `transform` 而不是 `top`：transform 不會觸發重新排版（reflow），只需要重新合成畫面，比較順。

### 你說的 observer：這裡用的是 ResizeObserver，不是 IntersectionObserver
`UserTableKeyed.vue:61-76`
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
`UserTableKeyed.vue:78-85`
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

## 3-2. 虛擬捲動 v2：DOM 回收（ADR 0012）

> 一句話：v1 是「捲出去的列刪掉、捲進來的列新建」；v2 是「固定一組列元素，捲出去的那一格搬到另一頭、換上新資料」。方案比較見 [virtual-scroll-options.md](virtual-scroll-options.md)。

### 為什麼要改（事實：`npm run bench:scroll` 實測）
這個想法是在讀 v1 的 DOM 時提出的：「既然畫面上一直只有那幾十列，能不能不刪不建，只換資料？」實測結果：

| 每捲一步的平均耗時 | v1（id 當 key） | v2（DOM 回收） |
|---|---|---|
| 一般列，慢慢捲 | 0.10–0.14ms | 0.06ms |
| 一般列，快速拖曳 | 0.24–0.85ms | 0.10–0.17ms |
| 列裡有子元件，慢慢捲 | 0.10ms | 0.04–0.05ms |
| 列裡有子元件，快速拖曳 | 1.8–3.2ms | 0.29–0.39ms |

- 兩者都遠低於一幀 16.7ms，現在的表格用 v1 也不會卡。
- 差距在「快速拖曳」和「列裡有元件」時最大（約 5–10 倍）。之後列裡加上下拉選單、標籤等元件時，v1 每次要卸載、重建元件，v2 只更新 props。
- 所以採用 v2 的理由是：**成本不高（約 40 行），而且把未來加功能的效能風險先處理掉**，不是因為現在卡。

### 沒變的部分
- 算範圍的數學一樣：`UserTable.vue:63-73` 的 `start`、`end`（同 v1 的第 3 節）。
- ResizeObserver 取得視窗高度：`UserTable.vue:116-137`。
- 提早載入下一批：`UserTable.vue:139-149`。

### 新增 1：固定格子數，用取餘數決定「第幾列放哪一格」
`src/components/UserTable.vue:73-89`
```ts
const poolSize = computed(() => Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2 + 1)
const slots = computed(() => {
  for (let slot = 0; slot < size; slot++) {
    const rowIndex = start.value + ((((slot - start.value) % size) + size) % size)
    ...
  }
})
```
**代入數字**：視窗高 600px → `poolSize = ceil(600/44) + 8×2 + 1 = 14 + 17 = 34` 格。
- 第 rowIndex 列固定放在第 `rowIndex % 34` 格。
- 從 `start = 100` 往下捲一列變成 `start = 101`：第 100 列捲出去，它在第 `100 % 34 = 32` 格；新進來的第 134 列，`134 % 34 = 32`，也是第 32 格。
- 結果：**只有第 32 格換資料、搬到最下面**，其他 33 格的內容和位置都不動。

### 新增 2：每一列自己定位，key 用格子編號
`UserTable.vue:229-245`
```html
<div v-for="{ slot, rowIndex, row } in slots" :key="slot"
     :style="{ transform: `translateY(${rowIndex * ROW_HEIGHT}px)` }"
     :aria-rowindex="rowIndex + 1" :data-id="row.id">
```
- `:key="slot"`：Vue 看到 key 沒變，就沿用同一個 DOM，只更新文字和屬性。v1 用 `row.id`，資料一換 key 就變，Vue 只好刪掉重建。
- 每列各自 `translateY(rowIndex × 44)`，取代 v1 的整塊 `.window` 位移，因為格子在 DOM 裡的順序已經不是畫面順序。
- `aria-rowindex`：告訴螢幕閱讀器「這是第幾列」，補回 DOM 順序和畫面順序不同的問題。

### 新增 3：焦點保護
`UserTable.vue:91-106`
```ts
watch(slots, () => {
  const active = document.activeElement
  const row = active?.closest('.body .row')
  if (row && Number(row.dataset.id) !== focusedRowId) active.blur()   // 格子換人了，就把焦點移開
}, { flush: 'post' })
```
**為什麼一定要做**：使用者用 Tab 把焦點移到 #120 的「刪除」按鈕，接著用滾輪往下捲。v2 會把同一顆按鈕拿去顯示 #154。如果焦點還留在上面，按 Enter 刪掉的就是 #154。
**支付類比**：結帳頁的「確認付款」按鈕被重用到另一筆訂單上，焦點卻沒移開，按 Enter 就付錯單。

### 和 v1 的差異
| | v1（第 3 節） | v2（本節） |
|---|---|---|
| `v-for` 的 key | `row.id` | 格子編號 `slot` |
| 捲動時的 DOM | 捲出去的刪掉、捲進來的新建 | 同一組約 40 個元素（1920×1080）沿用，只換內容 |
| 定位 | 外層 `.window` 整塊 `translateY(start × 44)` | 每列各自 `translateY(rowIndex × 44)` |
| DOM 順序 | 等於畫面順序 | 不等於，用 `aria-rowindex` 標示 |
| 焦點 | 列被刪掉，焦點自然消失 | 要自己處理，不然會操作到別人 |
| 列裡的暫存狀態 | 跟著列一起刪掉，不會殘留 | 會留在格子上，所以狀態一律用 `row.id` 存（例如 `selectedId`） |

### 代價
- 狀態不能放在格子（DOM 或子元件）裡，否則會「傳染」給下一筆資料。勾選、展開等狀態要放在 `Set<id>`、`Map<id, ...>`。
- 仍然只支援固定列高。
- 測試要依 `aria-rowindex` 排序後再比對，不能直接看 DOM 順序（`e2e/run.mjs` 的 `rowsData`）。

### 怎麼驗證（事實）
- e2e「DOM 回收」：記下 40 個列元素，捲 40 列後，40 個元素全部是原本那批，只有內容變了。
- e2e「焦點保護」：焦點在第 20 列，捲到第 1 列（第 20 列還看得到）→ 焦點保留；焦點在第 1 列，捲到第 300 列（格子換人）→ 焦點被移開。
- 效能：`npm run bench:scroll`，結果如上表。

---

## 4. 請求生命週期：取消、失敗、等待、快取（ADR 0010、0014）

### 問題 1：競態（race condition）
使用者快速連點表頭三次（升冪 → 降冪 → 取消）。三個請求同時在路上，如果第一個最慢回來，畫面會被舊結果蓋掉。
**支付流程類比**：連按兩次「查詢付款狀態」，慢的那次回傳「待付款」，結果蓋掉了快的那次「已付款」。

`useUserList.ts:111-142`（`reload`）
```ts
controller?.abort()                       // 取消還在路上的舊查詢
const cached = firstPageCache.get(key)    // 30 秒內查過的條件直接用快取
...
stale.value = rows.value.length > 0       // 先保留舊資料（表格變淡），不清空
const response = await fetchPage({ ...listQuery, limit: BATCH }, current.signal)
applyFirstPage(response, listQuery)       // 新的第一批回來才一次換掉
...
finally { if (controller === current) { loading.value = false; controller = null } }
```
- `signal` 一路傳到 fetch：`api/users.ts` 的 `list(query, signal)` → `api/http.ts` 的 `request(..., { signal })`。
- 被取消的請求會丟出 `AbortError`，`isAbortError()`（`http.ts:14`）把它和真正的錯誤分開，不顯示錯誤訊息。
- `controller === current`：被取消的舊請求不能把「新請求的 loading」關掉。
- 元件卸載時也會取消（`useUserList.ts:266`）。

### 問題 2：失敗後一直重送（事實，實測過）
原本 `loadMore` 失敗後 `loading` 變回 false，表格的 `watchEffect` 看到條件成立，馬上又呼叫一次。模擬後端一直回 500 時，1 秒內送出 172 個請求。
**做法**：有 `error` 時 `loadMore` 直接返回，表格的預先載入也不觸發，畫面底部顯示「重試」按鈕（`retry()`，`useUserList.ts:177`）。

### 問題 3：後端限流（429）
`fetchPage`（`useUserList.ts:79-100`）：依 `Retry-After` 等待（最多 10 秒），期間顯示「n 秒後自動重試」，然後只重試一次。等待可以被 signal 取消，換條件時不會繼續等。

### 刻意不取消的：修改類請求
新增、更新、刪除送出後就不取消（`api/users.ts` 這幾支沒有 signal 參數）。請求一旦到了後端，資料可能已經改好；前端這時取消，只會讓畫面和實際資料不一致。

### 驗證（事實）
- `tests/use-user-list.test.ts`：取消過期請求、失敗後只送 1 次、保留舊資料、快取、429。
- e2e：快速連點 Location 三次，取消了 2 個過期請求；換排序時表格先變淡；`?rateLimit=2` 觸發 429 後自動重試成功。

---

## 5. 新增、修改、釘選後的狀態一致性（ADR 0009、0015、0016）

### 用一個狀態描述「現在開著哪個視窗」
`src/App.vue:70-77`
```ts
type Dialog =
  | { type: 'create'; draft?: UserInput; serverErrors?: FieldErrors }
  | { type: 'edit'; row: User; draft?: UserInput; serverErrors?: FieldErrors }
  | { type: 'confirmUpdate'; row: User; input: UserInput }
  | { type: 'conflict'; row: User; input: UserInput; current: User }
  | { type: 'confirmDelete'; row: User }
  | { type: 'pin'; row: User; index: number }
  | { type: 'confirmUnpin'; row: User }
```
同一時間只會有一個視窗，不需要 7 個 `showXxxDialog` 布林值，也不會出現兩個視窗同時開著的錯誤狀態。

### 新增
`useUserList.ts:224`：成功後放在最上面、標示「新增」、捲回頂端。之後的批次如果也有這筆就略過，避免重複。

### 更新
- 流程：編輯表單 →「下一步」→ 確認視窗列出「原本 / 改為」→「確定更新」才打 API，並帶上讀到的 `version`。
- 422：回到編輯表單並標出錯誤欄位。前後端共用同一份驗證規則（`utils/validate.ts`）。
- **409（有人先改過）**：`updateRow`（`useUserList.ts:235`）先把列表換成後端目前的內容，再由 App 開衝突視窗，列出「其他人改成 / 你要改成」，讓使用者選擇放棄、重新編輯或覆蓋。
- **404（已被別人刪除）**：更新或刪除時都從列表移除，`run()`（`App.vue:115`）關窗並提示。

### 釘選
`usePinnedRows.ts` + `utils/placePins.ts`：
- 釘選是個人設定，存在 localStorage。開頁時用 `GET /api/users/:id` 取回最新資料。
- `displayRows = computed(() => placePins(rows, 可見的釘選列, hasMore))`。後端給的是全域排序後的前 N 筆，在這 N 筆裡依位置插入，結果也是全域正確的。
- 釘選、取消釘選只改 `pins`，不重新查詢，捲動位置和已載入的資料都會保留。
- 釘選列被編輯或刪除時，透過 `list.onUpdated`、`list.onRemoved` 同步。

**5 筆資料的例子**（`tests/pinned-rows.test.ts`，把 #4 釘在第 2 列）

| 後端回傳 | 畫面 |
|---|---|
| #1 #2 #3 #4 #5 | #1 **#4** #2 #3 #5 |
| 年齡升冪：#2 #1 #5 #4 #3 | #2 **#4** #1 #5 #3 |
| 年齡降冪：#3 #4 #5 #1 #2 | #3 **#4** #5 #1 #2 |

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
| 傳輸 | 一次只拿 500 筆 | `useUserList.ts:15` | 只持有看過的資料，不是 1,000 萬筆 |
| 狀態 | `shallowRef`，不替每筆資料建 Proxy | `useUserList.ts:39` | 見第 2 節實測 |
| 畫面 | 虛擬捲動 + DOM 回收 | `UserTable.vue:73-89` | DOM 固定約 40 個列元素（1920×1080），輪流使用 |
| 回收 | 清空、取消、卸載時清理 | 見第 7 節 | 不要的東西能被回收 |

---

## 7. 回收機制（垃圾回收，garbage collection）

### 先講原理（事實）
JS **沒有**「手動釋放記憶體」的 API。引擎會定期找出「再也沒有人引用的物件」並回收。所以前端能做的是**讓不要的東西變成沒人引用**，以及**少製造垃圾**。

### 本專案已經做的
| 做法 | 位置 | 回收了什麼 |
|---|---|---|
| 新條件的第一批回來時換掉列表 | `useUserList.ts:100` `rows.value = response.data` | 舊的幾百到幾萬個列物件失去引用，下次 GC 會回收 |
| 換新陣列而不是修改 | `useUserList.ts:161, 205, 213` | 舊陣列失去引用（列物件本身沿用，不會重複佔用） |
| 虛擬捲動 + DOM 回收 | `UserTable.vue:73-89`、`v-for :key="slot"`（230-231） | 捲出畫面的列不卸載，格子直接換成新資料，捲動時幾乎不產生要回收的 DOM（v1 是卸載後等 GC） |
| 取消過期請求 | `useUserList.ts:112`、`server.ts` 的 `raceAbort` | 舊請求的結果直接丟掉，事件監聽也移除，不會殘留 |
| 元件卸載時清理 | `useUserList.ts:266`、`UserTable.vue:135` | 取消請求、`observer.disconnect()`，避免記憶體洩漏（leak：該回收卻一直被引用） |

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
**代價**：往回捲要重新請求；虛擬捲動的高度計算要加上 `droppedBefore * ROW_HEIGHT`；釘選列的合併也要一起調整。cursor 已經是 keyset，重新抓取時位置不會跑掉。這是複雜度換記憶體，所以先列在 ADR 0011，等真的有需求再做。

**為什麼不是把超出範圍的資料設成 null**：設成 null 確實會讓物件被回收，但陣列長度不變、每格仍佔一個指標。上面的構想是直接縮短陣列，並配合 cursor 重新抓取。

### 怎麼驗證回收有沒有發生
Chrome DevTools → Memory 分頁：
1. 載入頁面，拍一張 Heap snapshot。
2. 捲到 5,000 筆，再拍一張。
3. 輸入搜尋字（新的第一批回來後舊列表被換掉），按垃圾桶圖示手動觸發 GC，再拍一張。
4. 比較三張的 `Object` 數量：第 3 張應該接近第 1 張。如果沒有降下來，用 Comparison 檢視找出是誰還在引用。

---

## 面試自我檢查（每題不看稿講 1 分鐘）

1. 為什麼用 cursor 而不是頁碼？為什麼從「位置」改成 keyset？（第 1 節）
2. 為什麼用 `shallowRef`？為什麼不能直接 push？（第 2 節）
3. 虛擬捲動怎麼算出要畫哪幾列？為什麼列高要固定？用的是哪個 Observer？（第 3 節）
4. DOM 回收和 v1 差在哪？為什麼 key 要用格子編號？為什麼一定要處理焦點？（第 3-2 節）
5. AbortController 解決什麼問題？載入失敗為什麼不能自動重送？429 怎麼處理？（第 4 節）
6. 確認視窗的狀態怎麼管理？後端回 422、409、404 時畫面怎麼處理？釘選為什麼可以在前端合併？（第 5 節）
7. Vue 的虛擬 DOM 和虛擬捲動差在哪？（第 6 節）
8. 使用者一路往下捲，記憶體會怎樣？怎麼改善？（第 7 節）
9. 50 人同時使用，前端能做什麼？（搜尋防抖、取消過期請求、第一批快取、失敗不重送、429 等待、409 版本衝突、404 同步移除）

---

## 附錄：mock 假後端（不是面試重點）

`src/mock/` 只是為了在沒有真 API 的情況下，用 1,000 萬筆的真實規模測試上面的前端行為。正式環境刪掉 `main.ts` 的 `setupMock()` 那一行就會改打真的 `/api/users`。

被問到時可以這樣說：「為了讓 mock 在瀏覽器裡撐得住千萬筆，我用欄式 TypedArray 存資料（約 70MB），排序用計數排序，並放在 Web Worker 裡，不讓主畫面卡住。正式環境這些是資料庫和索引的工作。」

| 檔案 | 內容 | ADR |
|---|---|---|
| `mock/db.ts` | 欄式 TypedArray、字典編碼、計數排序、查詢快照、keyset cursor、版本號 | 0004、0005、0013、0016 |
| `mock/worker.ts`、`mock/backend.ts` | 把 db 放進 Web Worker | 0006 |
| `mock/server.ts` | 假的 fetch：路由、150–400ms 延遲、可被 signal 取消、限流回 429，回傳真的 Response | 0010、0014 |
