# 設計決策如何落實在程式碼（細讀版）

> 目標：看懂「抽象的設計決策」怎麼變成具體的幾行程式碼。概念本身不再重講，請搭配 [code-map.md](code-map.md) 和 ADR。
> 速讀版：[design-walkthrough-quick.md](design-walkthrough-quick.md)。
> 標記：**事實**＝程式碼或測試看得到；**推測**＝由原理推論、沒有實測；**建議**＝我的看法。

依重要程度排序：

| # | 區塊 | 檔案 | 一句話 |
|---|---|---|---|
| 1 | DOM 回收的格子分配 | `src/components/UserTable.vue:48-73, 192-205` | 用取餘數把「第幾列」固定對應到「第幾格」 |
| 2 | 回收的副作用：焦點與狀態 | `src/components/UserTable.vue:46, 75-90, 196-204` | 狀態跟著資料 id 走，不跟著 DOM 走 |
| 3 | 載入的所有權：cursor + AbortController | `src/composables/useUserList.ts:23-62` | 誰發的請求，誰才有資格收尾 |
| 4 | 換新陣列 + 刪除後 cursor 修正 | `src/composables/useUserList.ts:73-101` | 每個修改都產生新陣列，並讓前後端的位置保持一致 |
| 5 | 確認視窗的單一狀態 | `src/App.vue:48-70, 91-122` | 用一個型別描述「現在開著哪個視窗」 |

---

## 1. DOM 回收的格子分配

### 設計決策
- **問題**：v1 用 `row.id` 當 key，每捲一列，Vue 就刪掉一個 DOM、新建一個 DOM。列裡有元件時，快速拖曳每步要 1.8–3.2ms（事實，`npm run bench:scroll`）。
- **共識**：固定一組格子，捲出去的格子搬到另一頭換資料（ADR 0012）。

### 核心程式碼
`src/components/UserTable.vue:48-73`
```ts
const start = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN),
)
const end = computed(() =>
  Math.min(
    props.rows.length,
    Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN,
  ),
)
// DOM 回收：格子數量固定（視窗放得下的列數 + 上下緩衝），第 rowIndex 列固定交給
// 第 rowIndex % poolSize 格。……
const poolSize = computed(
  () => Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2 + 1,
)
const slots = computed(() => {
  const size = poolSize.value
  const result: { slot: number; rowIndex: number; row: UserRow }[] = []
  for (let slot = 0; slot < size; slot++) {
    const rowIndex =
      start.value + ((((slot - start.value) % size) + size) % size)
    const row = props.rows[rowIndex]
    if (row) result.push({ slot, rowIndex, row })
  }
  return result
})
```
`src/components/UserTable.vue:192-202`
```html
<div
  v-for="{ slot, rowIndex, row } in slots"
  :key="slot"
  ...
  :style="{ transform: `translateY(${rowIndex * ROW_HEIGHT}px)` }"
  role="row"
  :aria-rowindex="rowIndex + 1"
```

### 實作原理：哪幾行真正落實了設計
| 行 | 落實了什麼 |
|---|---|
| 60-62 `poolSize` | 「格子數固定」：只跟視窗高度有關，跟已載入幾筆無關 |
| 67-68 `rowIndex = start + ((slot - start) % size + size) % size` | 「第幾列放第幾格」：這行等於反過來算 `rowIndex % size === slot`。外層 `+ size) % size` 是因為 JS 的 `%` 遇到負數會得到負數（`-3 % 34 = -3`），要轉回 0～33 |
| 194 `:key="slot"` | 「沿用 DOM」：key 是格子編號，Vue 看到同一個 key 就 patch（只改有變的屬性），不會卸載重建 |
| 200 `translateY(rowIndex * ROW_HEIGHT)` | 「格子搬家」：格子在 DOM 的順序固定，位置改由每列自己的 transform 決定 |
| 202 `aria-rowindex` | 補上「DOM 順序 ≠ 畫面順序」造成的無障礙缺口 |

**資料流（往下捲一列）**：
1. `onScroll`（92-98）在下一個 animation frame 更新 `scrollTop`。
2. `start` 從 100 變 101 → `slots` 重新計算。
3. 34 格裡只有第 32 格的 `rowIndex` 從 100 變成 134（`134 % 34 = 32`），其他 33 格的 `{ rowIndex, row }` 都沒變。
4. Vue 用 key 比對：33 格的 props 相同 → 幾乎不動；第 32 格 → 更新文字和 transform。

### 設計取捨
| 做法 | 為什麼沒選 |
|---|---|
| v1：`:key="row.id"` | 每捲一列就卸載一個、建立一個；列裡元件越多越貴 |
| 簡單版：`:key="index - start"` | 也會沿用 DOM，但往下捲一列時**每一格**的資料都往上挪一格，34 格全部 patch。bench 裡它在「一般列，慢慢捲」和 v1 差不多（0.11–0.16ms 對 0.10–0.14ms），列裡有元件時更是 v1 的 2–3 倍 |
| vue-virtual-scroller | 原理相同（view 池），但沒有焦點處理，而且無限捲動、釘選要配合它的 API（`docs/virtual-scroll-options.md`） |

**解決的耦合**：v1 裡「DOM 的生命週期」和「資料的身分」綁在一起（key = id）。v2 把兩者拆開：DOM 只代表「一個位置」，資料只透過 props 流進來。

### 理解驗證
| 需求變動 | 要改哪裡 | 你應該想到的連鎖影響 |
|---|---|---|
| 列高從 44 改成 52 | 只改 `ROW_HEIGHT`（37 行） | `poolSize`、`start`、translateY、body 高度都從它算，會一起變 |
| 快速捲動時下方會閃白 | 加大 `OVERSCAN` | 格子數變多 = 每格平均閒置時間變長，但 DOM 也變多 |
| 列高不再固定（內容自動換行） | **整個區塊都要重寫** | 取餘數分配和 `start = scrollTop / 44` 都依賴固定列高；這時改用量測高度的方案（如 DynamicScroller）比較合理 |

**偏離共識？** 沒有偏離，但有一個文件沒寫的行為（推測，由程式推論）：視窗高度改變時 `poolSize` 會變，`rowIndex % size` 的對應整個重排，那一次所有格子都會換資料。只在縮放視窗時發生一次，影響很小。

---

## 2. 回收的副作用：焦點與狀態

### 設計決策
- **問題**：格子會換資料，但留在格子上的東西（焦點、元件內部狀態）不會自動換。用 Tab 停在 #120 的「刪除」上再捲動，同一顆按鈕可能變成 #154 的。
- **共識**：狀態跟著資料 id 走；焦點在格子換人時移開（ADR 0012 的代價一節）。

### 核心程式碼
`src/components/UserTable.vue:75-90`
```ts
// 回收的副作用：格子換成別筆資料時，焦點可能還留在原本那顆按鈕上，
// 這時按 Enter 會操作到另一個人。所以記住焦點所在的列，列換人就把焦點移開。
let focusedRowId: number | null = null
function onFocusIn(event: FocusEvent) {
  const row = (event.target as HTMLElement).closest<HTMLElement>('.row')
  focusedRowId = row ? Number(row.dataset.id) : null
}
watch(
  slots,
  () => {
    const active = document.activeElement as HTMLElement | null
    const row = active?.closest<HTMLElement>('.body .row')
    if (row && Number(row.dataset.id) !== focusedRowId) active!.blur()
  },
  { flush: 'post' },
)
```
`src/components/UserTable.vue:46` 和 `196-204`
```ts
const selectedId = ref<number | null>(null)
```
```html
:class="{ pinned: row.pinnedAt !== null, selected: selectedId === row.id }"
:data-id="row.id"
@click="selectedId = row.id"
```

### 實作原理
| 行 | 落實了什麼 |
|---|---|
| 79-80 `onFocusIn` | 焦點進入時，記下「使用者想操作的是哪個 id」。掛在外層 `.body`（190 行），靠事件冒泡，不用每列各掛一個 |
| 203 `:data-id="row.id"` | 讓 DOM 隨時能回答「我現在顯示的是誰」 |
| 82-90 `watch(slots, …, { flush: 'post' })` | `flush: 'post'` = 等 Vue 把 DOM 更新完才執行，這時讀到的 `data-id` 已經是新的 |
| 87 比對兩個 id | 一樣 → 格子沒換人，保留焦點；不一樣 → `blur()` |
| 46、198、204 `selectedId` | 「選取」存成 id，不存成「第幾格」。格子換人後，新資料的 id 不等於 `selectedId`，高亮自然消失 |

**控制流程**：捲動 → `slots` 改變 → Vue patch DOM → post watcher 執行 → 比對 `data-id` 和 `focusedRowId` → 必要時 blur。

### 設計取捨
- **為什麼不在格子換人時把焦點「跟著搬」到新位置？** 原本那列已經捲出畫面，焦點搬過去會讓瀏覽器把畫面捲回去，打斷使用者的捲動。移開焦點最不意外。
- **為什麼不用 `:key="row.id"` 就好？** 那就回到 v1，等於放棄回收。這裡的代價是多 15 行，換來 key 可以用 slot。
- **解決的耦合**：「元件狀態放在哪」從「放在 DOM 上（隱性）」變成「放在以 id 為 key 的資料上（顯性）」，這也是回收能成立的前提。

### 理解驗證
| 需求變動 | 要改哪裡 |
|---|---|
| 支援多選（勾選框） | 新增 `const checkedIds = ref(new Set<number>())`，模板用 `checkedIds.has(row.id)`。**不能**用 `<input type="checkbox">` 自己的勾選狀態，否則勾選會傳染給換進來的下一筆 |
| 列裡加「展開詳細資料」 | 同上，存 `expandedIds`。而且展開會改變列高，碰到第 1 節的限制 |
| 列裡放一個有內部 `ref` 的子元件（例如編輯中的輸入框） | 子元件要能在 `row.id` 改變時重設，例如 `watch(() => props.row.id, reset)`，或只在那個子元件上加 `:key="row.id"` |

**偏離共識？** 沒有。`focusedRowId` 只在 `focusin` 更新；如果焦點被程式移到列外（例如開啟對話框），它會殘留舊值，但 87 行先檢查 `row` 存在，所以不會誤判（事實，由程式推論）。

---

## 3. 載入的所有權：cursor + AbortController

### 設計決策
- **問題**：每次 500 筆、用 cursor 往下接（ADR 0003）；換搜尋字或排序時，舊請求晚回來不能蓋掉新結果（ADR 0010）。
- **共識**：同時只有一個「有效」的查詢；新的查詢開始時取消舊的。

### 核心程式碼
`src/composables/useUserList.ts:23-62`
```ts
let cursor: string | null = null
let controller: AbortController | null = null

async function loadMore() {
  if (loading.value || !hasMore.value) return
  const current = (controller = new AbortController())
  loading.value = true
  error.value = null
  try {
    const response = await usersApi.list(
      { ...query, cursor, limit: BATCH },
      current.signal,
    )
    rows.value = rows.value.concat(response.data)
    total.value = response.total
    cursor = response.nextCursor
    hasMore.value = response.hasMore
  } catch (requestError) {
    if (!isAbortError(requestError))
      error.value = (requestError as Error).message
  } finally {
    if (controller === current) {
      loading.value = false
      controller = null
    }
  }
}

function reload() {
  controller?.abort()
  controller = null
  rows.value = []
  cursor = null
  hasMore.value = true
  loading.value = false
  resetKey.value++
  return loadMore()
}
```

### 實作原理
| 行 | 落實了什麼 |
|---|---|
| 23 `let cursor`（不是 `ref`） | cursor 只給下一次請求用，畫面不需要它，所以不做成響應式 |
| 28 `if (loading \|\| !hasMore) return` | 「同時只有一個載入」：捲動很快時，預取的 watchEffect 可能連續觸發，這行擋掉重複請求 |
| 29 `const current = (controller = …)` | **關鍵**：每個請求把自己的 controller 存成區域變數 `current`，之後用它判斷「我還是不是最新的那個」 |
| 35 `current.signal` | 取消的開關一路傳到 fetch（`api/users.ts` → `api/http.ts`） |
| 43 `isAbortError` | 被取消不是錯誤，不顯示紅字 |
| 46 `controller === current` | 「誰發的請求，誰收尾」：舊請求被取消後還是會跑到 finally，但這時 `controller` 已經是新請求的，舊的就不能把 `loading` 關掉 |
| 54 `controller?.abort()` | reload 的第一件事：作廢舊查詢 |
| 59 `loading.value = false` | 讓 28 行的守門放行新的 `loadMore()` |
| 60 `resetKey++` | 通知表格捲回頂端（`UserTable.vue:118-124` 的 watch） |

**時間軸（快速點兩次表頭）**：
1. 第一次 reload → 請求 A，`controller = A`。
2. 第二次 reload → `A.abort()`，請求 B，`controller = B`。
3. A 丟出 AbortError → catch 忽略 → finally：`controller(B) !== A`，什麼都不做。
4. B 回來 → 寫入資料 → finally：`controller === B`，關掉 loading。

### 設計取捨
| 常見做法 | 問題 |
|---|---|
| 用一個遞增的 `requestId`，回來時比對再丟掉 | 也能防止舊結果蓋掉新結果，但舊請求仍佔著網路和後端資源；AbortController 會真的中斷 |
| 不取消，只靠 `loading` 擋 | 換排序時要等舊請求回來才能發新的，使用者會覺得慢 |
| 用 axios 的 CancelToken | 已被 axios 標為棄用，官方也改建議 AbortController |

**解決的耦合**：表格（UserTable）只會 `emit('loadMore')`，完全不知道 cursor、取消或批次大小。換成真 API、改 BATCH 或改 cursor 格式，都只動這個 composable。

### 理解驗證
| 需求變動 | 要改哪裡 |
|---|---|
| 每批改成 1,000 筆 | `BATCH`（6 行）；預取門檻 `PREFETCH_ROWS`（`UserTable.vue:41`）最好一起調大 |
| 網路錯誤後要能「重試」 | 28 行之後不必改；在 catch 裡保留 `cursor` 不動（目前就沒動），UI 加一個按鈕呼叫 `loadMore()` 即可，因為 cursor 只在成功時才前進（40 行） |
| 後端改成 keyset cursor | 這裡不用改；要改的是第 4 節的 cursor 修正 |
| 新增「篩選地區」 | `query` 加欄位（17-21 行），改變時呼叫 `reload()`；取消、清空、捲回頂端都自動得到 |

**偏離共識？** 沒有。補充一個界線（事實，ADR 0010 有寫）：取消只對「還在路上」的請求有效，修改類請求刻意不取消。

---

## 4. 換新陣列 + 刪除後 cursor 修正

### 設計決策
- **問題**：`shallowRef` 只追蹤 `.value` 被換掉（ADR 0009）；刪除後後端少了一筆，cursor 是「位置」，不修正就會漏一筆（ADR 0003）。
- **共識**：所有修改都回傳新陣列；刪除後 cursor - 1；釘選後整個重查。

### 核心程式碼
`src/composables/useUserList.ts:73-101`
```ts
async function removeRow(id: number) {
  await usersApi.remove(id)
  const rowIndex = rows.value.findIndex((row) => row.id === id)
  if (rowIndex >= 0) {
    rows.value = rows.value.toSpliced(rowIndex, 1)
    // 後端快照也少了這一列，游標往前一格，下一批才不會漏掉資料
    if (cursor) cursor = String(Number(cursor) - 1)
  }
  total.value--
}

async function updateRow(id: number, input: UserInput) {
  const updated = await usersApi.update(id, input)
  const rowIndex = rows.value.findIndex((row) => row.id === id)
  if (rowIndex >= 0) {
    rows.value = rows.value.with(rowIndex, updated)
  }
  return updated
}

async function pinRow(id: number, position: number) {
  await usersApi.pin(id, position)
  await reload()
}
```

### 實作原理
| 行 | 落實了什麼 |
|---|---|
| 74、85、94 先 `await` API | 「後端成功才改畫面」（悲觀更新）。失敗會丟錯，下面的程式不會執行，畫面不會先變 |
| 75、86 用 id 找位置 | 不相信呼叫端給的 index：請求在路上時，列表可能已經變了 |
| 77 `toSpliced`、88 `with` | 回傳新陣列 → `shallowRef` 偵測到 → 表格的 `props.rows` 換新 → `slots` 重算 |
| 79 `cursor - 1` | 只在「刪的是已載入的列」時修正（76 行的 if），因為未載入的列本來就在 cursor 之後 |
| 95 `reload()` | 釘選會改變很多列的位置，局部修補容易出錯，所以直接重查 |

### 設計取捨
- **為什麼更新後不重查？** 更新不會讓列消失或移動（共識：「改過的列先留在原位，下次重新查詢時才依新值排序」，ADR 0009）。如果新值不符合目前的搜尋或排序，它暫時還在原位，這是刻意的，避免使用者剛按完「確定」那列就跳走。
- **為什麼刪除不重查？** 重查會清空已載入的資料並捲回頂端，使用者會失去位置。用 `toSpliced` + cursor 修正可以原地刪除。
- **為什麼釘選要重查？** 釘選位置的合併規則在後端，前端如果自己算，前後端就會有兩份規則（耦合）。

### 理解驗證
| 需求變動 | 要改哪裡 |
|---|---|
| 改成「先改畫面、失敗再還原」（樂觀更新） | 74-80 行改成先 `toSpliced`，把舊陣列和舊 cursor 存起來，`catch` 時還原兩者 |
| 後端改成 keyset cursor（最後一筆的排序值 + id） | 刪掉 79 行，因為書籤不再是位置 |
| 支援批次刪除 | 用 `filter` 一次產生新陣列，cursor 減去「已載入中被刪的筆數」 |
| 新增一筆資料 | 要決定插在哪裡；最簡單、也和釘選一致的做法是 `reload()` |

**偏離共識？** 一個要知道的依賴（事實，code-map 第 1 節有寫）：79 行假設 cursor 是 mock 後端的「快照中的位置」。接真 API 前要先確認後端 cursor 的格式，這行可能要刪。

---

## 5. 確認視窗的單一狀態

### 設計決策
- **問題**：刪除、更新、釘選、取消釘選都要確認視窗；更新還要「表單 → 確認 → 422 回表單」。
- **共識**：用一個 discriminated union（可辨識聯合型別：用 `type` 欄位區分的幾種物件形狀）描述目前的視窗。

### 核心程式碼
`src/App.vue:48-70`
```ts
type Dialog =
  | { type: 'edit'; row: UserRow; draft?: UserInput; serverErrors?: FieldErrors }
  | { type: 'confirmUpdate'; row: UserRow; input: UserInput }
  | { type: 'confirmDelete'; row: UserRow }
  | { type: 'pin'; row: UserRow; index: number }
  | { type: 'confirmUnpin'; row: UserRow }

const dialog = shallowRef<Dialog | null>(null)

function open(next: Dialog) {
  dialogError.value = null
  dialog.value = next
}
```
`src/App.vue:91-122`
```ts
async function run(action: () => Promise<unknown>, done: string) {
  busy.value = true
  dialogError.value = null
  try {
    await action()
    close()
    notify(done)
  } catch (actionError) {
    dialogError.value = (actionError as Error).message
    return actionError
  } finally {
    busy.value = false
  }
}

async function confirmUpdate(pending: Extract<Dialog, { type: 'confirmUpdate' }>) {
  const updateError = await run(
    () => list.updateRow(pending.row.id, pending.input),
    `已更新 #${pending.row.id}`,
  )
  if (updateError instanceof HttpError && updateError.status === 422) {
    open({ type: 'edit', row: pending.row, draft: pending.input,
           serverErrors: updateError.details as FieldErrors })
  }
}
```
（上面兩段為了閱讀把幾行合併，實際排版以檔案為準。）

### 實作原理
| 行 | 落實了什麼 |
|---|---|
| 48-58 `type Dialog` | 「同時只有一個視窗」由型別保證；每種視窗需要的資料跟著它走（例如 `confirmUpdate` 一定有 `input`） |
| 60 `shallowRef` | 每次 `open` 都換一個新物件，不需要深層追蹤 |
| 95-97 成功 → `close()`、`notify()` | 所有確認動作共用同一套「處理中／成功／失敗」流程 |
| 98-100 失敗 → 保留視窗、顯示錯誤、**回傳錯誤** | 回傳讓呼叫端決定下一步（例如 422），而 `run` 本身不必知道 422 是什麼 |
| 114-121 `422 → open({ type: 'edit', draft, serverErrors })` | 「回到表單」= 換成另一種視窗狀態，並把草稿和錯誤帶回去 |

**狀態轉換**：`null → edit → confirmUpdate → (成功) null`、`confirmUpdate → (422) edit（帶草稿）`、`confirmUpdate → (其他錯誤) confirmUpdate（顯示紅字）`。

### 設計取捨
| 常見做法 | 問題 |
|---|---|
| 5 個 `showXxxDialog` 布林值 + 5 個 `selectedRow` | 可能同時有兩個是 true；關窗時要記得清掉對的那個 |
| 每個視窗自己打 API | 處理中、錯誤、提示訊息的邏輯重複 5 次 |
| 用 Pinia 或狀態機套件（XState） | 這個規模用一個型別就夠，多一個依賴不划算（建議） |

**解決的耦合**：視窗元件（`ConfirmDialog`、`EditUserDialog`、`PinDialog`）只負責顯示和 emit，不知道 API；API 錯誤怎麼處理集中在 App.vue。

### 理解驗證
| 需求變動 | 要改哪裡 |
|---|---|
| 新增「封存」動作 + 確認視窗 | `Dialog` 加 `{ type: 'confirmArchive'; row: UserRow }`；模板加一個 `v-if="dialog?.type === 'confirmArchive'"`；確定時呼叫 `run(() => list.archiveRow(id), '已封存')`。TypeScript 會在你漏寫欄位時報錯 |
| 釘選位置衝突（409）要回到輸入框並標紅 | 參考 114-121 行，在釘選的確認函式裡判斷 `status === 409`，`open({ type: 'pin', … })` 帶回錯誤 |
| 刪除前要輸入「DELETE」才能確定 | 只改 `confirmDelete` 對應的視窗元件，`run` 和型別不用動 |

**偏離共識？** 沒有偏離，但目前 409 是直接顯示在原視窗（`dialogError`），沒有像 422 那樣標出欄位（事實）。這符合 ADR 的描述，只是兩種錯誤的呈現方式不一致，面試被問到可以說明原因：409 只有一個欄位，紅字已足夠。

---

## 共通的轉化方法（把架構思維變成程式碼）

從上面 5 個區塊可以歸納出 3 個可重複使用的步驟：

1. **先找出「身分」**：資料的身分是 `id`，DOM 的身分是 `slot`，請求的身分是 `current` controller，視窗的身分是 `type`。決定好身分，key、比對、收尾的程式碼就自然出現。
2. **再決定「誰擁有狀態」**：cursor 屬於 composable、選取屬於 `selectedId`、處理中屬於 `run()`。擁有者以外的地方只讀不寫。
3. **最後處理「副作用的邊界」**：焦點（第 2 節）、被取消的請求（第 3 節）、cursor 修正（第 4 節），都是「主要設計成立後，留下來的那一點不一致」。把它們寫成獨立、有註解的小區塊，面試時就能清楚說出代價。

**練習建議**：挑「理解驗證」表格中的一列（推薦第 2 節的「支援多選」），不看答案自己實作，然後跑 `node e2e/run.mjs` 確認捲動後勾選不會傳染給別人。做得出來，就代表你真的掌握了 DOM 回收的核心限制。
