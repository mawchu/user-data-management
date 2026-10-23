<script setup lang="ts">
import { computed, inject, onMounted, ref, shallowRef, watch } from 'vue'
import UserTable from './components/UserTable.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import EditUserDialog from './components/EditUserDialog.vue'
import PinDialog from './components/PinDialog.vue'
import { useUserList } from './composables/useUserList'
import { usePinnedRows } from './composables/usePinnedRows'
import { HttpError } from './api/http'
import { abortedRequests } from './mock/setup'
import type {
  ConflictDetails,
  SortKey,
  SortOrder,
  User,
  UserInput,
} from './types/user'
import type { FieldErrors } from './utils/validate'

const list = useUserList()
const { total, loading, hasMore, error, notice, stale, newIds, query } = list
const pinned = usePinnedRows(list)
const rows = pinned.displayRows

const booting = ref(true)
const bootMs = ref(0)
const keyword = ref('')
const toast = ref<string | null>(null)

const apiReady = inject<Promise<unknown>>('apiReady', Promise.resolve())

onMounted(async () => {
  const bootStart = performance.now()
  await apiReady
  bootMs.value = Math.round(performance.now() - bootStart)
  booting.value = false
  await Promise.all([list.reload(), pinned.restore()])
})

// 搜尋防抖（debounce）：停止輸入 300ms 後才查詢，避免每打一個字就送一次請求
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => list.search(value), 300)
})

let toastTimer: ReturnType<typeof setTimeout> | undefined
function notify(message: string) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 3000)
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'userName', label: 'User name' },
  { key: 'position', label: 'Position' },
  { key: 'location', label: 'Location' },
  { key: 'age', label: 'Age' },
  { key: 'dateStart', label: 'Date Start' },
]
// 手機沒有表頭可以點，用選單排序
const sortChoice = computed({
  get: () => (query.sortBy ? `${query.sortBy}:${query.order}` : ''),
  set: (value: string) => {
    const [key, order] = value.split(':') as [SortKey, SortOrder]
    list.setSort(key || null, order)
  },
})

type Dialog =
  | { type: 'create'; draft?: UserInput; serverErrors?: FieldErrors }
  | { type: 'edit'; row: User; draft?: UserInput; serverErrors?: FieldErrors }
  | { type: 'confirmUpdate'; row: User; input: UserInput }
  | { type: 'conflict'; row: User; input: UserInput; current: User }
  | { type: 'confirmDelete'; row: User }
  | { type: 'pin'; row: User; index: number }
  | { type: 'confirmUnpin'; row: User }

const dialog = shallowRef<Dialog | null>(null)
const busy = ref(false)
const dialogError = ref<string | null>(null)

function open(next: Dialog) {
  dialogError.value = null
  dialog.value = next
}
function close() {
  dialog.value = null
}

const FIELD_LABELS: Record<keyof UserInput, string> = {
  userName: 'User name',
  position: 'Position',
  location: 'Location',
  age: 'Age',
  dateStart: 'Date Start',
}
const FIELDS = Object.keys(FIELD_LABELS) as (keyof UserInput)[]
const changes = computed(() => {
  const current = dialog.value
  if (current?.type !== 'confirmUpdate') return []
  return FIELDS.filter(
    (field) => current.row[field] !== current.input[field],
  ).map((field) => ({
    label: FIELD_LABELS[field],
    from: current.row[field],
    to: current.input[field],
  }))
})

/**
 * 執行修改並統一處理結果：成功關窗並提示；失敗把錯誤回傳給呼叫端決定下一步。
 * 資料已被別人刪除（404）時，列表已經同步拿掉，這裡只關窗並說明。
 */
async function run(action: () => Promise<unknown>, done: string) {
  busy.value = true
  dialogError.value = null
  try {
    await action()
    close()
    notify(done)
  } catch (actionError) {
    if (actionError instanceof HttpError && actionError.status === 404) {
      close()
      notify('這筆資料已被其他人刪除，已從列表移除')
      return actionError
    }
    dialogError.value = (actionError as Error).message
    return actionError
  } finally {
    busy.value = false
  }
}

async function submitCreate(input: UserInput) {
  const createError = await run(() => list.createRow(input), '已新增資料')
  if (createError instanceof HttpError && createError.status === 422)
    open({
      type: 'create',
      draft: input,
      serverErrors: createError.details as FieldErrors,
    })
}

async function confirmUpdate(row: User, input: UserInput, version: number) {
  const updateError = await run(
    () => list.updateRow(row.id, input, version),
    `已更新 #${row.id}`,
  )
  if (!(updateError instanceof HttpError)) return
  // 後端驗證失敗：回到編輯表單並標出錯誤欄位
  if (updateError.status === 422)
    open({
      type: 'edit',
      row,
      draft: input,
      serverErrors: updateError.details as FieldErrors,
    })
  // 別人先改過：列出差異，讓使用者決定
  if (updateError.status === 409)
    open({
      type: 'conflict',
      row,
      input,
      current: (updateError.details as ConflictDetails).current,
    })
}

const conflictRows = computed(() => {
  const current = dialog.value
  if (current?.type !== 'conflict') return []
  return FIELDS.map((field) => ({
    label: FIELD_LABELS[field],
    original: current.row[field],
    theirs: current.current[field],
    mine: current.input[field],
  }))
})

function onPin(row: User) {
  open({ type: 'pin', row, index: rows.value.indexOf(row) + 1 })
}

function confirmDelete(row: User) {
  return run(() => list.removeRow(row.id), `已刪除 #${row.id}`)
}

function confirmUnpin(row: User) {
  pinned.unpin(row.id)
  close()
  notify(`已取消釘選 #${row.id}`)
}

function submitPin(row: User, position: number) {
  try {
    pinned.pin(row, position)
    close()
    notify(`已把 #${row.id} 釘選在第 ${position} 列`)
  } catch (pinError) {
    dialogError.value = (pinError as Error).message
  }
}
</script>

<template>
  <div class="layout">
    <header class="top">
      <div>
        <h1>使用者資料管理</h1>
        <p class="meta">
          <template v-if="booting">正在產生 10,000,000 筆 mock 資料…</template>
          <template v-else>
            共
            <b data-testid="total">{{ total.toLocaleString() }}</b> 筆，已載入
            <span data-testid="loaded">{{
              list.rows.value.length.toLocaleString()
            }}</span>
            筆
            <span class="hint">
              （資料產生 {{ bootMs }}ms，每次捲動載入 500 筆，已取消
              <span data-testid="aborted">{{ abortedRequests }}</span>
              個過期請求）
            </span>
          </template>
        </p>
      </div>
      <div class="tools">
        <input
          v-model="keyword"
          class="search"
          type="search"
          placeholder="搜尋所有欄位，例如 Chen、Engineer、42、2015-03"
          aria-label="搜尋所有欄位"
          :disabled="booting"
        />
        <select
          v-model="sortChoice"
          class="mobile-sort"
          aria-label="排序"
          :disabled="booting"
        >
          <option value="">不排序</option>
          <template
            v-for="column in COLUMNS"
            :key="column.key"
          >
            <option :value="`${column.key}:asc`">{{ column.label }} ↑</option>
            <option :value="`${column.key}:desc`">{{ column.label }} ↓</option>
          </template>
        </select>
        <button
          class="btn primary"
          :disabled="booting"
          @click="open({ type: 'create' })"
        >
          新增
        </button>
      </div>
    </header>

    <p
      v-if="notice"
      class="notice"
      role="status"
    >
      {{ notice }}
    </p>

    <main class="main">
      <UserTable
        v-if="!booting"
        :rows="rows"
        :pins="pinned.pins.value"
        :new-ids="newIds"
        :sort-by="query.sortBy"
        :order="query.order"
        :loading="loading"
        :has-more="hasMore"
        :stale="stale"
        :error="error"
        :reset-key="list.resetKey.value"
        @sort="list.toggleSort"
        @load-more="list.loadMore"
        @retry="list.retry"
        @edit="(row) => open({ type: 'edit', row })"
        @delete="(row) => open({ type: 'confirmDelete', row })"
        @pin="onPin"
        @unpin="(row) => open({ type: 'confirmUnpin', row })"
      />
      <div
        v-else
        class="booting"
      >
        載入中…
      </div>
    </main>

    <EditUserDialog
      v-if="dialog?.type === 'create'"
      title="新增使用者"
      submit-text="新增"
      :initial="dialog.draft"
      :server-errors="dialog.serverErrors"
      :busy="busy"
      :error="dialogError"
      @cancel="close"
      @submit="submitCreate"
    />

    <EditUserDialog
      v-else-if="dialog?.type === 'edit'"
      :key="`edit-${dialog.row.id}`"
      :title="`編輯使用者 #${dialog.row.id}`"
      :initial="dialog.draft ?? dialog.row"
      :server-errors="dialog.serverErrors"
      @cancel="close"
      @submit="
        (input) =>
          dialog?.type === 'edit' &&
          open({ type: 'confirmUpdate', row: dialog.row, input })
      "
    />

    <ConfirmDialog
      v-else-if="dialog?.type === 'confirmUpdate'"
      title="確定要更新這筆資料嗎？"
      confirm-text="確定更新"
      :busy="busy"
      :error="dialogError"
      @cancel="open({ type: 'edit', row: dialog.row, draft: dialog.input })"
      @confirm="confirmUpdate(dialog.row, dialog.input, dialog.row.version)"
    >
      <p>#{{ dialog.row.id }} {{ dialog.row.userName }}</p>
      <table
        v-if="changes.length"
        class="diff"
      >
        <thead>
          <tr>
            <th>欄位</th>
            <th>原本</th>
            <th>改為</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in changes"
            :key="c.label"
          >
            <td>{{ c.label }}</td>
            <td class="from">{{ c.from }}</td>
            <td class="to">{{ c.to }}</td>
          </tr>
        </tbody>
      </table>
      <p
        v-else
        class="hint"
      >
        沒有任何欄位變更。
      </p>
    </ConfirmDialog>

    <ConfirmDialog
      v-else-if="dialog?.type === 'conflict'"
      title="這筆資料剛被其他人修改"
      confirm-text="用我的版本覆蓋"
      cancel-text="放棄我的修改"
      danger
      :busy="busy"
      :error="dialogError"
      @cancel="close"
      @confirm="
        confirmUpdate(dialog.current, dialog.input, dialog.current.version)
      "
    >
      <p>
        #{{ dialog.row.id }}
        在你編輯期間已被更新。列表已換成最新內容，你可以放棄修改，或用你的版本覆蓋。
      </p>
      <table class="diff">
        <thead>
          <tr>
            <th>欄位</th>
            <th>其他人改成</th>
            <th>你要改成</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in conflictRows"
            :key="c.label"
            :class="{ differs: c.theirs !== c.mine }"
          >
            <td>{{ c.label }}</td>
            <td>{{ c.theirs }}</td>
            <td class="to">{{ c.mine }}</td>
          </tr>
        </tbody>
      </table>
      <template #extra>
        <button
          class="btn"
          type="button"
          :disabled="busy"
          @click="
            dialog?.type === 'conflict' &&
            open({ type: 'edit', row: dialog.current, draft: dialog.input })
          "
        >
          重新編輯
        </button>
      </template>
    </ConfirmDialog>

    <ConfirmDialog
      v-else-if="dialog?.type === 'confirmDelete'"
      title="確定要刪除這筆資料嗎？"
      confirm-text="確定刪除"
      danger
      :busy="busy"
      :error="dialogError"
      @cancel="close"
      @confirm="confirmDelete(dialog.row)"
    >
      <p>
        <b>#{{ dialog.row.id }} {{ dialog.row.userName }}</b
        >（{{ dialog.row.position }}，{{ dialog.row.location }}）
      </p>
      <p class="hint">刪除後無法復原。</p>
    </ConfirmDialog>

    <PinDialog
      v-else-if="dialog?.type === 'pin'"
      :row="dialog.row"
      :current-index="dialog.index"
      :total="total"
      :error="dialogError"
      @cancel="close"
      @submit="
        (position) => dialog?.type === 'pin' && submitPin(dialog.row, position)
      "
    />

    <ConfirmDialog
      v-else-if="dialog?.type === 'confirmUnpin'"
      title="取消釘選？"
      confirm-text="取消釘選"
      @cancel="close"
      @confirm="confirmUnpin(dialog.row)"
    >
      <p>
        #{{ dialog.row.id }} {{ dialog.row.userName }} 目前釘選在第
        {{ pinned.pins.value.get(dialog.row.id) }}
        列，取消後會回到依排序規則的位置。
      </p>
    </ConfirmDialog>

    <div
      v-if="toast"
      class="toast"
      role="status"
    >
      {{ toast }}
    </div>
  </div>
</template>

<style scoped>
.layout {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-block: 16px;
  padding-left: max(24px, env(safe-area-inset-left, 0px));
  padding-right: max(24px, env(safe-area-inset-right, 0px));
  box-sizing: border-box;
}
.top {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: space-between;
  align-items: flex-end;
}
h1 {
  margin: 0;
  font-size: 22px;
}
.meta {
  margin: 4px 0 0;
  color: var(--muted);
}
.meta b {
  color: var(--text);
}
.tools {
  display: flex;
  gap: 8px;
  width: min(520px, 100%);
}
.search {
  font: inherit;
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
}
.mobile-sort {
  display: none;
  font: inherit;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
}
.notice {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--pinned);
}
.diff tr.differs td {
  font-weight: 600;
}
.main {
  flex: 1;
  min-height: 0;
}
.booting {
  padding: 40px;
  text-align: center;
  color: var(--muted);
}
.diff {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
.diff th,
.diff td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}
.diff .from {
  color: var(--muted);
  text-decoration: line-through;
}
.diff .to {
  font-weight: 600;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  background: var(--text);
  color: var(--surface);
  padding: 10px 16px;
  border-radius: 8px;
}
@media (max-width: 640px) {
  /* 手機：搜尋、排序、新增各佔一列，按得到也看得清楚 */
  .tools {
    flex-direction: column;
  }
  .search,
  .mobile-sort,
  .tools .btn {
    width: 100%;
    min-height: 44px;
    /* 16px 以下 iOS 會在點選時自動放大畫面 */
    font-size: 16px;
  }
  .mobile-sort {
    display: block;
  }
  .meta .hint {
    display: none;
  }
  .layout {
    padding-block: 12px;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
}
</style>
