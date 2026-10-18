# 設計決策如何落實在程式碼（速讀版）

> 5 分鐘版本。每個區塊只講「哪幾行落實了設計」和「需求變了改哪裡」。細節與取捨見 [細讀版](design-walkthrough.md)。

## 一句話總結
**先決定每樣東西的「身分」，key、比對、收尾的程式碼就自然出現。**

| 東西 | 身分 | 程式碼 |
|---|---|---|
| DOM 列 | 格子編號 `slot` | `UserTable.vue:194` `:key="slot"` |
| 資料 | `row.id` | `UserTable.vue:203` `:data-id="row.id"` |
| 請求 | 自己的 controller `current` | `useUserList.ts:29, 46` |
| 視窗 | `dialog.type` | `App.vue:48-58` |

---

## 1. DOM 回收：用取餘數分配格子
`src/components/UserTable.vue:60-73, 194, 200`
```ts
const poolSize = computed(() => Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2 + 1)
const rowIndex = start.value + ((((slot - start.value) % size) + size) % size)  // 等於 rowIndex % size === slot
```
```html
:key="slot"                                              <!-- 沿用 DOM -->
:style="{ transform: `translateY(${rowIndex * ROW_HEIGHT}px)` }"  <!-- 每列自己定位 -->
```
- **落實設計的行**：67-68（第幾列放第幾格）、194（key 是格子不是資料）、200（位置由 transform 決定，不靠 DOM 順序）。
- **往下捲一列**：34 格裡只有 1 格換資料，其他 33 格不動。
- **需求變了**：列高不固定 → 這整段要換方案；只是改高度 → 只改 `ROW_HEIGHT`（37 行）。

## 2. 回收的副作用：狀態跟著 id，不跟著格子
`src/components/UserTable.vue:79-90, 46, 198`
```ts
focusedRowId = row ? Number(row.dataset.id) : null                    // 焦點進來時記住是誰
if (row && Number(row.dataset.id) !== focusedRowId) active!.blur()   // 格子換人就移開焦點
selected: selectedId === row.id                                       // 選取存 id，不存格子
```
- **落實設計的行**：87（比對 id 決定是否 blur）、`flush: 'post'`（89，等 DOM 更新完才比對）、198（選取用 id 判斷）。
- **需求變了**：加多選 → 用 `Set<id>` 存勾選，**不要**用 checkbox 自己的狀態，否則捲動後會傳染給別人。

## 3. 載入：誰發的請求，誰收尾
`src/composables/useUserList.ts:28-29, 46, 54`
```ts
if (loading.value || !hasMore.value) return       // 同時只有一個載入
const current = (controller = new AbortController())
...
if (controller === current) { loading.value = false; controller = null }  // 舊請求不能關掉新請求的 loading
...
controller?.abort()                                // reload 先作廢舊查詢
```
- **落實設計的行**：29（每個請求記住自己）、46（只有最新的才能收尾）、40（cursor 只在成功時前進）。
- **需求變了**：加篩選條件 → `query` 加欄位、改變時呼叫 `reload()`，取消與捲回頂端自動得到。表格只會 `emit('loadMore')`，不用改。

## 4. 修改：換新陣列 + cursor 修正
`src/composables/useUserList.ts:74-79, 88, 95`
```ts
await usersApi.remove(id)                          // 後端成功才改畫面
rows.value = rows.value.toSpliced(rowIndex, 1)     // 新陣列 → shallowRef 才偵測得到
if (cursor) cursor = String(Number(cursor) - 1)    // 後端少一筆，書籤往前一格
rows.value = rows.value.with(rowIndex, updated)    // 更新：原地換，不重查
await reload()                                     // 釘選：規則在後端，直接重查
```
- **需求變了**：後端改 keyset cursor → 刪掉 cursor - 1 那行（79）；改成樂觀更新 → 先改畫面，catch 時還原陣列和 cursor。
- ⚠ **依賴**：79 行假設 cursor 是「位置」。接真 API 前要確認格式。

## 5. 確認視窗：一個型別描述現在開著哪個
`src/App.vue:48-58, 91-104, 114-121`
```ts
type Dialog = { type: 'edit'; … } | { type: 'confirmUpdate'; row; input } | { type: 'confirmDelete'; row } | …
const updateError = await run(() => list.updateRow(…), '已更新')   // run：處理中／成功關窗／失敗回傳錯誤
if (updateError instanceof HttpError && updateError.status === 422) open({ type: 'edit', draft, serverErrors })
```
- **落實設計的行**：48-58（不可能同時開兩個）、100（`run` 回傳錯誤，讓呼叫端決定下一步）、114-121（422 = 換成另一種視窗狀態）。
- **需求變了**：新增「封存」→ `Dialog` 加一種 type、模板加一個 `v-if`、確定時用 `run()`。

---

## 和共識不一致或要留意的地方
| 項目 | 狀態 |
|---|---|
| 視窗縮放時 `poolSize` 改變，所有格子會換一次資料 | 推測（由程式推論），影響小，文件沒寫 |
| 刪除後 cursor - 1 依賴「cursor 是位置」 | 事實，code-map 和 README 有寫 |
| 409 只顯示紅字，不像 422 會標出欄位 | 事實，符合 ADR；面試可說明「409 只有一個欄位」 |

## 自我檢查（答得出來就算懂）
1. 為什麼 `:key="slot"` 可以沿用 DOM，`:key="row.id"` 不行？
2. 第 87 行如果拿掉，使用者會遇到什麼事？
3. `controller === current` 拿掉的話，快速點兩次表頭會發生什麼？
4. 要支援多選，狀態要放在哪裡？為什麼？
