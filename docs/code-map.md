# 核心程式碼地圖與解題思路

> 用途：面試前複習。每個檔案回答三件事：**它解決題目哪個要求、關鍵做法、面試官可能追問什麼**。
> 行號以目前 main 分支為準（`src/mock/db.ts` 共 327 行）。

## 一張圖看資料流

```
使用者捲動 / 輸入搜尋 / 點表頭
        │
UserTable.vue（虛擬捲動，只畫看得到的約 30 列）
        │ emit('loadMore')
App.vue（對話框狀態機：編輯 → 確認更新、確認刪除、釘選）
        │
useUserList.ts（列表狀態 + AbortController）
        │ usersApi.list(query, signal)
api/users.ts → api/http.ts（fetch 介面，真後端時只換 transport）
        │
mock/server.ts（假的 fetch：路由、延遲、可取消、回傳真的 Response）
        │ postMessage
mock/worker.ts（Web Worker：背景執行緒，主畫面不會卡）
        │
mock/db.ts（1,000 萬筆：欄式 TypedArray + 字典編碼 + 計數排序）
```

**一句話版本**：重活（排序、搜尋 1,000 萬筆）丟到背景執行緒；畫面只拿 500 筆一批、只畫看得到的列；請求可以取消。

---

## 優先順序：先讀懂這 4 個檔案

| 順序 | 檔案 | 行數 | 對應題目要求 |
|---|---|---|---|
| 1 | `src/mock/db.ts` | 327 | 1,000 萬筆、搜尋、排序、刪除、釘選 |
| 2 | `src/composables/useUserList.ts` | 98 | 無限捲動 500 筆、取消請求、刪除後游標修正 |
| 3 | `src/components/UserTable.vue` | 213 | 不佔記憶體的畫面渲染（虛擬捲動） |
| 4 | `src/mock/server.ts` + `src/api/http.ts` | 104 + 34 | 模擬打 API、AbortController |

其餘（`App.vue`、各 Dialog、`validate.ts`）是 UI 與表單，邏輯簡單，掃過即可。

---

## 1. `src/mock/db.ts`：資料怎麼存、怎麼查

### 1-1 欄式儲存（columnar storage）＋字典編碼（dictionary encoding）
- **問題**：1,000 萬個 `{ userName, position, ... }` 物件，每個物件在 JS 引擎裡約 100 多 bytes，加起來超過 1GB（ADR 0004 實測 Map 版本 1,190MB）。
- **做法**：不存物件，改成「每一欄一條 TypedArray（固定型別的數字陣列）」。字串欄先查字典換成小整數：
  - `nameIds: Uint16Array`（每筆 2 bytes，存「名字字典的編號」）
  - `positionIds / locationIds / ages: Uint8Array`（每筆 1 byte）
  - `startDays: Uint16Array`（距 1950-01-01 的天數）
  - 共約 70MB（ADR 0004）。
- **程式位置**：`class Dict`（約 36–61 行）、`UserDb` 欄位宣告與建構子（81–128 行）。
- **多品牌類比**：訂單表的「品牌」欄不存 `"Nike"` 字串 1,000 萬次，而是存 `0`，另有一張 `brands = ["Nike", "Adidas", ...]` 對照表。

### 1-2 搜尋：先查字典，再掃列（`build()`，約 258–283 行）
- **問題**：對 1,000 萬列逐筆做 5 次 `toLowerCase().includes()` 太慢。
- **做法**：
  1. 先在字典上比對關鍵字。名字只有幾千種、職位只有幾十種，所以只要比對幾千次，得到 `nameHit[編號] = 1 / 0` 這種查表陣列。
  2. 再掃 1,000 萬列，每列只做 5 次陣列查表（`nameHit[nameIds[rowIndex]] || positionHit[positionIds[rowIndex]] ...`），沒有任何字串運算。
- **實測**：搜尋約 85–173ms（10M 筆）。

### 1-3 排序：計數排序（counting sort，`countingSort()`，約 300–325 行）
- **為什麼是 O(n)**：不做兩兩比較。值域小（age 256 種、名字 ≤ 65,536 種），所以：
  1. 數每個值出現幾次（n 步）
  2. 累加，得到每個值的起始位置（k 步）
  3. 每筆直接放到位置上（n 步）
  → O(n + k)，k 遠小於 n，所以等於 O(n)。比較排序的下限是 O(n log n)，10M 筆約多 23 倍。
- **穩定性（stable）**：同值的資料保持原本順序（id 由小到大）。這讓「同年齡時順序固定」，捲動到下一批不會跳動。
- **字串怎麼排**：`Dict.rank()` 把編號換成「字母順序名次」，只對字典（幾千筆）做一次真正的字串排序，再拿名次去計數排序。
- **省記憶體技巧**：`bufferA / bufferB` 兩個 40MB 緩衝區輪流使用，不用每次排序都配置新陣列。
- **實測**：排序 189–450ms。

### 1-4 查詢快照（snapshot）＋ cursor（`list()`，約 130–164 行）
- **問題**：如果每批都重新查詢，使用者捲到第 3 批時資料被別人改了，順序就會跳動或漏資料。
- **做法**：第一批（cursor = 0）算出完整排序結果存成快照，後續批次的 cursor 就是「快照裡的位置」。
- **為什麼不用頁碼**：ADR 0002（被取代）→ ADR 0003。

### 1-5 釘選合併（`effectivePinPositions()`，約 254–256 行）
- 釘選的列不參與排序，在 `list()` 回傳時才按位置插入。
- `Math.min(p.position - 1, snap.length + i)`：釘在第 100 列但只剩 3 筆資料時，就排到最後面，不留空洞。
- 搜尋時，不符合關鍵字的釘選列會隱藏；同一個位置只能釘一筆（衝突回 409）。規則見 ADR 0008。

### 1-6 刪除（`remove()`，約 190–206 行）
- 標記 `deleted[i] = 1`（軟刪除，不搬動 1,000 萬筆）。
- 同時從快照中移除那一列（`copyWithin` 往前搬），所以前端的 cursor 要減 1（見下一節）。

---

## 2. `src/composables/useUserList.ts`：前端列表狀態

| 機制 | 程式 | 為什麼 |
|---|---|---|
| `shallowRef` | `const rows = shallowRef<UserRow[]>([])` | 數萬筆資料不需要深層響應式（Vue 不必替每個物件建 Proxy），省記憶體 |
| 換新陣列而不是 push | `rows.value = rows.value.concat(res.data)` | shallowRef 只偵測「整個換掉」，push 不會觸發子元件更新（這個 bug 當初真的踩過） |
| AbortController | `controller?.abort()` in `reload()` | 換搜尋字時取消舊請求，避免慢的舊結果晚回來蓋掉新結果（race condition：競態） |
| `controller === current` 判斷 | `finally` 區塊 | 被取消的舊請求不能把新請求的 loading 狀態關掉 |
| 刪除後 cursor - 1 | `removeRow()` | 後端快照少了一列，不往前退就會漏掉一筆 |
| `toSpliced` / `with` | 刪除、更新 | 不改原陣列、回傳新陣列，同樣是為了觸發 shallowRef |
| `onScopeDispose` | 最後一行 | 元件卸載時取消還在路上的請求 |

**支付流程類比**：使用者連按兩次「查詢訂單狀態」，第一次請求很慢。沒有 abort 的話，第一次的「待付款」可能比第二次的「已付款」晚回來，畫面就顯示錯誤狀態。

**刻意不取消的東西**：更新、刪除這類修改請求（mutation）。一旦送出，伺服器可能已經改了，前端取消只會讓畫面和實際資料不一致（ADR 0010）。

---

## 3. `src/components/UserTable.vue`：虛擬捲動

- **問題**：捲到 5,000 筆就有 5,000 × 6 個 DOM 節點，捲動會卡、記憶體會漲。
- **做法**（約 30–60 行）：
  - 固定列高 `ROW_HEIGHT = 44`，所以「第幾列在哪裡」可以直接算出來，不必量測。
  - `start = floor(scrollTop / 44) - OVERSCAN`，`end = ceil((scrollTop + 視窗高) / 44) + OVERSCAN`。
  - 只渲染 `rows.slice(start, end)`，大約 30 列，用 `translateY` 位移到正確位置。
  - `requestAnimationFrame` 節流捲動事件；`ResizeObserver` 追蹤視窗高度。
  - 離底部剩不到 `PREFETCH_ROWS = 150` 列時先載入下一批，使用者感覺不到等待。
- **為什麼不用 Vuetify**：職缺沒要求、手寫能說明原理、少一個大依賴（ADR 0007）。

---

## 4. `src/mock/server.ts` + `src/api/http.ts`：模擬打 API

- `createMockFetch()` 的函式簽名和 `fetch` 一樣，回傳真的 `Response` 物件，有 200 / 204 / 404 / 409 / 422 狀態碼。
- 模擬 150–400ms 的網路延遲（`sleep`），延遲期間可以被 `signal` 取消（`raceAbort`）。
- `http.ts` 的 `setTransport()`：換成真後端時改一行就好，元件和 composable 完全不用動。

---

## 面試自我檢查（每題要能不看稿講 1 分鐘）

1. 為什麼不用物件陣列或 Map 存 1,000 萬筆？（1-1）
2. 計數排序為什麼是 O(n)？穩定性在這裡有什麼用？（1-3）
3. 搜尋為什麼不用逐筆做 `includes`？（1-2）
4. cursor 跟頁碼差在哪？刪除後為什麼 cursor 要減 1？（1-4、1-6、2）
5. 為什麼用 `shallowRef`？為什麼不能直接 push？（2）
6. AbortController 解決什麼問題？為什麼修改請求不取消？（2）
7. 虛擬捲動怎麼算出要畫哪幾列？為什麼列高要固定？（3）
8. 50 人同時用，前端能做什麼？（ADR 0011：限制已載入列數、相同查詢快取、debounce、409 版本衝突）

---

# 深入：六個實作主題

> 每個主題照同一個順序：**問題 → 做法（附程式碼與位置）→ 代價 → 怎麼驗證**。
> 標「事實」的是程式碼或實測結果；標「推測」的是原理推論，沒有在這個專案實測。
> 行號以 `refactor: 縮寫變數改成完整名稱` 這個 commit 為準。

## A. TypedArray 的實作概念（ADR 0004）

### 問題
一般寫法是 `users: User[]`，每筆一個物件。JS 引擎替每個物件額外存「隱藏類別指標、屬性表」等資訊，字串也各自佔空間。ADR 0004 實測，1,000 萬筆用 Map 存要 **1,190MB**（平均每筆約 119 bytes），瀏覽器分頁很可能直接崩潰。

### TypedArray 是什麼
- 一塊**連續、固定型別**的記憶體（底層是 `ArrayBuffer`）。`Uint8Array` 的每格固定 1 byte，只能放 0–255；`Uint16Array` 每格 2 bytes，可放 0–65,535。
- 和一般陣列的差別：一般陣列每格可以放任何東西（物件、字串、數字），所以每格其實存的是「指標」，指向散落在記憶體各處的值。TypedArray 每格直接就是數字本身，**沒有物件、沒有指標**。

```
一般物件陣列（每筆一個物件，散落各處）
users[0] ──► { userName: "Amy Chen", position: "QA Engineer", age: 30, ... }
users[1] ──► { userName: "Ben Lin",  position: "UI Designer", age: 41, ... }

欄式 TypedArray（每個欄位一條連續陣列，第 rowIndex 格 = 第 rowIndex 列）
nameIds     : [ 1203 | 87  | ... ]   Uint16，每格 2 bytes
positionIds : [ 6    | 4   | ... ]   Uint8，每格 1 byte
ages        : [ 30   | 41  | ... ]   Uint8
startDays   : [ 23810| 24001| ... ]  Uint16，1950-01-01 起算的天數
```

### 字串怎麼放進數字陣列：字典編碼（dictionary encoding）
字串欄位只存「字典編號」，真正的字串只存一次。

`src/mock/db.ts:36-61`
```ts
class Dict {
  readonly values: string[] = []                 // 編號 → 字串，例如 values[6] = 'QA Engineer'
  private index = new Map<string, number>()      // 字串 → 編號，新增時查重複
  add(value: string): number {
    let id = this.index.get(value)
    if (id !== undefined) return id               // 已經有了，直接回傳編號
    if (this.values.length >= this.cap) throw new ApiError(507, '此欄位的不同值已達 mock 上限')
    id = this.values.length
    this.values.push(value)
    this.index.set(value, id)
    ...
```

**多品牌類比**：訂單表的品牌欄不存 1,000 萬次 `"Nike"`，而是存 `0`，另外有一張 `brands = ["Nike", "Adidas", ...]`。

### 欄位宣告與型別選擇
`src/mock/db.ts:86-110`
```ts
private nameIds: Uint16Array      // 名字最多 65,536 種（Dict 上限 0xffff）
private positionIds: Uint8Array   // 職位最多 256 種
private locationIds: Uint8Array
private ages: Uint8Array          // 年齡 0–255 綽綽有餘
private startDays: Uint16Array    // 1950-01-01 起算天數，可表示到 2129 年
private deleted: Uint8Array       // 軟刪除旗標
private pinnedFlag: Uint8Array    // 是否被釘選
...
this.nameIds = new Uint16Array(size)   // 建立時就一次配置好 1,000 萬格
```

**型別怎麼選**：看「這一欄最多有幾種值」。日期不存字串 `"2015-03-01"`（10 個字元），而是存「距離 1950-01-01 幾天」，2 bytes 就夠。轉回字串在 `db.ts:24-31`（`dayToDateString`，有快取，同一天只格式化一次）。

### 讀一筆資料時再組回物件
`src/mock/db.ts`，`toUser()`（約 241-250 行）
```ts
private toUser(rowIndex: number): User {
  return {
    id: rowIndex + 1,
    userName: this.names.values[this.nameIds[rowIndex]],   // 編號 → 查字典 → 字串
    position: this.positions.values[this.positionIds[rowIndex]],
    ...
```
**只有要回傳給前端的那 500 筆才組成物件**，其餘 999 萬多筆永遠是數字。

### 記憶體算術（事實）
| 項目 | 每列 | 1,000 萬列 |
|---|---|---|
| 5 個資料欄位（2+1+1+1+2） | 7 bytes | 70MB |
| deleted + pinnedFlag | 2 bytes | 20MB |
| 排序緩衝區 bufferA + bufferB（Uint32） | 8 bytes | 80MB |
| 合計 | | 約 170MB（實測整個分頁約 183MB） |

### 代價
- 欄位的值種類有上限（例如職位超過 256 種就要改成 Uint16）。`Dict.add` 爆上限會回 507。
- 程式比 `users[i].age` 難讀，所以把它封裝在 `UserDb` 裡面，外部只看到 `User` 物件。

### 怎麼驗證
- `tests/db.test.ts`：26 個測試，拿同一份資料用「最直白的物件陣列寫法」算一次當標準答案，比對排序、搜尋、刪除、釘選的結果完全一致。
- `PERF=1 npx vitest run tests/perf.test.ts`：印出產生、排序、搜尋的耗時。

---

## B. shallowRef 減少響應式造成的效能負擔（ADR 0009）

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
| 載入下一批 | `useUserList.ts:31` | `rows.value = rows.value.concat(response.data)` |
| 刪除一列 | `useUserList.ts:68` | `rows.value = rows.value.toSpliced(rowIndex, 1)` |
| 更新一列 | `useUserList.ts:79` | `rows.value = rows.value.with(rowIndex, updated)` |
| 重新查詢 | `useUserList.ts:48` | `rows.value = []` |

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
- 新進同事容易踩到，所以在 `useUserList.ts:30` 留了註解。

**Vue 2 對照（面試加分）**：Vue 2 用 `Object.defineProperty` 在初始化時就遞迴把每個屬性轉成 getter/setter，1 萬筆就要立刻轉 7 萬個屬性。Vue 2 常見的解法是 `Object.freeze(list)`，讓 Vue 跳過轉換，概念和 `shallowRef` 相同。

---

## C. 釘選（pin）怎麼實作（ADR 0008）

### 規則
1. 釘在第 N 列，不論怎麼排序都顯示在第 N 列。
2. 搜尋時，不符合關鍵字的釘選列會隱藏。
3. 目標位置超過資料量時，排到最後面（不留空洞）。
4. 同一個位置只能釘一筆，衝突回 409。

### 資料結構
`src/mock/db.ts:93-94`
```ts
private pinnedFlag: Uint8Array                  // pinnedFlag[rowIndex] = 1 表示被釘選
private pins = new Map<number, number>()        // id → 目標位置（1 起算）
```
兩份資料各有用途：`Map` 讓「列出所有釘選」很快，`pinnedFlag` 讓「掃 1,000 萬列時跳過釘選列」只要查一格陣列。

### 核心想法：釘選列不參與排序，最後再插回去
**步驟 1：建快照時排除釘選列**，`db.ts:266`、`db.ts:277`
```ts
if (!deleted[rowIndex] && !pinnedFlag[rowIndex]) view[length++] = rowIndex
```

**步驟 2：其餘的列照常排序**，`db.ts:289`

**步驟 3：決定每個釘選列實際的位置**，`db.ts:252-258`
```ts
// 例：只剩 3 筆一般資料，釘在第 100 列的資料會出現在第 4 列
private effectivePinPositions(snapshot: Snapshot): number[] {
  return snapshot.pins.map((pin, pinOrder) => Math.min(pin.position - 1, snapshot.length + pinOrder))
}
```

**步驟 4：分頁時合併**，`db.ts:150-162`
```ts
const pinSlots = this.effectivePinPositions(snapshot)
let pinIndex = 0
while (pinIndex < pinSlots.length && pinSlots[pinIndex] < offset) pinIndex++   // 跳過這批之前的釘選列
let viewIndex = offset - pinIndex                                             // 一般列要從快照的哪裡開始拿
for (let position = offset; position < end; position++) {
  if (pinIndex < pinSlots.length && pinSlots[pinIndex] === position) {
    const pin = snapshot.pins[pinIndex++]                                    // 這個位置是釘選列
    data.push({ ...this.toUser(pin.id - 1), pinnedAt: pin.position })
  } else {
    data.push({ ...this.toUser(snapshot.view[viewIndex++]), pinnedAt: null }) // 否則依序填一般列
  }
}
```

### 用例子走一次
#13 釘在第 3 列（位置 index 2），依 Age 排序後一般列是 `[a, b, c, d, …]`：

| 位置 | 0 | 1 | 2 | 3 | 4 |
|---|---|---|---|---|---|
| 結果 | a | b | **#13** | c | d |

改成依 Date Start 排序，一般列變成 `[x, y, z, …]`，結果是 `x, y, #13, z…`。#13 永遠在位置 2。

**為什麼 `viewIndex = offset - pinIndex`**：假設要拿第 2 批（offset = 500），而前面有 1 個釘選列佔掉一格，那一般列只用掉 499 筆，所以要從快照的第 499 筆開始拿。

### 其他配套
- 衝突檢查：`db.ts:213-215`，同位置已被別人釘選就丟 409。
- 釘選或取消後清掉快照：`db.ts:218`、`db.ts:227`（`this.snapshot = null`）。前端會從頭重查：`useUserList.ts:84-92`。
- 搜尋時隱藏不符合的釘選列：`db.ts:291`。
- 刪除釘選列：`db.ts:197-199`，從快照的 pins 拿掉即可，不用動排序結果。
- 畫面上的 📌：`UserTable.vue:106`；釘選和取消按鈕：`UserTable.vue:116-117`。

### 代價
- 釘選後要從頭重新查詢一次（約幾百毫秒），使用者會回到列表頂端。
- 要換位置得先取消再釘。

### 怎麼驗證
- `tests/db.test.ts`：每一種排序都檢查釘選列在指定位置，而且其餘列仍然照排序規則。
- e2e：#13 釘在第 3 列後，切換 Age、User name、Date Start 的升降冪，都還在第 3 列；同一位置重複釘選會顯示錯誤。

---

## D. 用高度計算可視範圍（虛擬捲動，ADR 0007）

### 問題
捲到 5,000 筆，就有 5,000 列 × 8 格 = 4 萬個 DOM 節點。每個節點都佔記憶體，而且瀏覽器每次排版都要處理它們，捲動會卡。

### 做法：固定列高 → 用數學算出該畫哪幾列
`src/components/UserTable.vue:30-45`
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
`UserTable.vue:92-93`
```html
<div class="body" :style="{ height: `${rows.length * ROW_HEIGHT}px` }">          <!-- 撐出完整高度，捲軸長度才正確 -->
  <div class="window" :style="{ transform: `translateY(${start * ROW_HEIGHT}px)` }"> <!-- 把那 30 列移到正確位置 -->
```
用 `transform` 而不是 `top`：transform 不會觸發重新排版（reflow），只需要重新合成畫面，比較順。

### 你說的 observer：這裡用的是 ResizeObserver，不是 IntersectionObserver
`UserTable.vue:47-58`
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
`UserTable.vue:60-62`
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

## E. 如何減少 RAM？是否使用虛擬 DOM？

### 先釐清兩個名詞
- **虛擬 DOM（virtual DOM）**：Vue 本身的機制。Vue 先在 JS 裡建一棵「描述畫面的物件樹」（vnode），和上一次比對差異，只把有變的部分寫進真正的 DOM。**這個專案有用，因為 Vue 就是這樣運作的**，不是我們額外加的。
- **虛擬捲動（virtual scroll）**：我們自己做的，決定「哪些列要交給 Vue 渲染」。

兩者是互補的：虛擬 DOM 只負責「比對要畫的東西」，沒有幫你減少要畫的數量。5,000 列交給 Vue，就會有 5,000 列的 vnode 和真實 DOM。虛擬捲動先把數量砍到約 30 列，Vue 的比對成本和 DOM 數量才會跟著變小。

**面試回答模板**：「Vue 有虛擬 DOM，但它解決的是『更新時改最少的 DOM』，不是『DOM 太多』。DOM 太多要靠虛擬捲動，只渲染可視範圍。」

### 本專案三層省記憶體
| 層 | 做法 | 位置 | 效果 |
|---|---|---|---|
| 資料層（Web Worker） | 欄式 TypedArray + 字典編碼 | `db.ts:86-110` | 1,190MB → 約 70MB（ADR 0004） |
| 資料層 | 排序緩衝區重複使用 | `db.ts:329-333` | 每次排序不再配置新的 40MB |
| 傳輸層 | 一次只回傳 500 筆物件 | `db.ts:131-165`、`useUserList.ts:6` | 主執行緒只持有已載入的列 |
| 狀態層 | `shallowRef`，不建 Proxy | `useUserList.ts:11` | 見主題 B |
| 畫面層 | 虛擬捲動 | `UserTable.vue:30-45` | DOM 固定約 25–30 列 |

**為什麼放在 Web Worker（ADR 0006）**：Worker 是另一條執行緒，有自己的記憶體空間。排序 1,000 萬筆的 0.2–0.45 秒在背景跑，主畫面不會卡。資料也不在主執行緒，所以 Vue 完全不知道這 1,000 萬筆的存在。

**誠實的提醒**：mock 資料庫本身約 180MB，是「假裝自己是後端」的成本。接上真 API 後，前端只需要幾 MB（ADR 0011）。面試時要主動講清楚：前端真正的省記憶體是傳輸層以下那幾列。

---

## F. 如何觸發回收機制（垃圾回收，garbage collection）

### 先講原理（事實）
JS **沒有**「手動釋放記憶體」的 API。引擎會定期找出「再也沒有人引用的物件」並回收。所以前端能做的是**讓不要的東西變成沒人引用**，以及**少製造垃圾**。

### 本專案已經做的
| 做法 | 位置 | 回收了什麼 |
|---|---|---|
| 重新查詢時清空列表 | `useUserList.ts:48` `rows.value = []` | 舊的幾百到幾萬個列物件失去引用，下次 GC 會回收 |
| 換新陣列而不是修改 | `useUserList.ts:31,68,79` | 舊陣列失去引用（列物件本身沿用，不會重複佔用） |
| 虛擬捲動 | `UserTable.vue:45`、`v-for :key="row.id"`（95-96） | 捲出畫面的列，Vue 會卸載它的 DOM 和 vnode |
| 取消過期請求 | `useUserList.ts:46`、`server.ts:63-69` | 舊請求的結果直接丟掉，事件監聽也移除，不會殘留 |
| 元件卸載時清理 | `useUserList.ts:95`、`UserTable.vue:58` | 取消請求、`observer.disconnect()`，避免記憶體洩漏（leak：該回收卻一直被引用） |
| 緩衝區重複使用 | `db.ts:329-333` | 不製造垃圾：每次排序都 `new Uint32Array(1000 萬)` 的話，會不斷產生 40MB 的垃圾等 GC 處理 |

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
