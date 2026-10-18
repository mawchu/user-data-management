<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import UserTable from './components/UserTable.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import EditUserDialog from './components/EditUserDialog.vue'
import PinDialog from './components/PinDialog.vue'
import { useUserList } from './composables/useUserList'
import { HttpError, usersApi } from './api/users'
import type { UserInput, UserRow } from './types/user'
import type { FieldErrors } from './utils/validate'

const list = useUserList()
const { rows, total, loading, hasMore, error, query, resetKey } = list

const booting = ref(true)
const bootMs = ref(0)
const keyword = ref('')
const toast = ref<string | null>(null)

onMounted(async () => {
  const t = performance.now()
  await usersApi.ready
  bootMs.value = Math.round(performance.now() - t)
  booting.value = false
  await list.reload()
})

// 搜尋防抖（debounce）：停止輸入 300ms 後才查詢，避免每打一個字就掃一次千萬筆
let timer: ReturnType<typeof setTimeout> | undefined
watch(keyword, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    query.q = value
    list.reload()
  }, 300)
})

let toastTimer: ReturnType<typeof setTimeout> | undefined
function notify(message: string) {
  toast.value = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 3000)
}

type Dialog =
  | { type: 'edit'; row: UserRow; draft?: UserInput; serverErrors?: FieldErrors }
  | { type: 'confirmUpdate'; row: UserRow; input: UserInput }
  | { type: 'confirmDelete'; row: UserRow }
  | { type: 'pin'; row: UserRow; index: number }
  | { type: 'confirmUnpin'; row: UserRow }

const dialog = shallowRef<Dialog | null>(null)
const busy = ref(false)
const dialogError = ref<string | null>(null)

function open(d: Dialog) {
  dialogError.value = null
  dialog.value = d
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
const changes = computed(() => {
  const d = dialog.value
  if (d?.type !== 'confirmUpdate') return []
  return (Object.keys(FIELD_LABELS) as (keyof UserInput)[])
    .filter((k) => d.row[k] !== d.input[k])
    .map((k) => ({ label: FIELD_LABELS[k], from: d.row[k], to: d.input[k] }))
})

async function run(action: () => Promise<unknown>, done: string) {
  busy.value = true
  dialogError.value = null
  try {
    await action()
    close()
    notify(done)
  } catch (e) {
    dialogError.value = (e as Error).message
    return e
  } finally {
    busy.value = false
  }
}

async function confirmUpdate(d: Extract<Dialog, { type: 'confirmUpdate' }>) {
  const err = await run(() => list.updateRow(d.row.id, d.input), `已更新 #${d.row.id}`)
  // 後端驗證失敗：回到編輯表單並標出錯誤欄位
  if (err instanceof HttpError && err.status === 422) {
    open({ type: 'edit', row: d.row, draft: d.input, serverErrors: err.details as FieldErrors })
  }
}

function onPin(row: UserRow) {
  open({ type: 'pin', row, index: rows.value.indexOf(row) + 1 })
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
            共 <b data-testid="total">{{ total.toLocaleString() }}</b> 筆，已載入
            <span data-testid="loaded">{{ rows.length.toLocaleString() }}</span> 筆
            <span class="hint">（資料產生 {{ bootMs }}ms，每次捲動載入 500 筆）</span>
          </template>
        </p>
      </div>
      <input
        v-model="keyword"
        class="search"
        type="search"
        placeholder="搜尋所有欄位，例如 Chen、Engineer、42、2015-03"
        aria-label="搜尋所有欄位"
        :disabled="booting"
      />
    </header>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <main class="main">
      <UserTable
        v-if="!booting"
        :rows="rows"
        :sort-by="query.sortBy"
        :order="query.order"
        :loading="loading"
        :has-more="hasMore"
        :reset-key="resetKey"
        @sort="list.toggleSort"
        @load-more="list.loadMore"
        @edit="(row) => open({ type: 'edit', row })"
        @delete="(row) => open({ type: 'confirmDelete', row })"
        @pin="onPin"
        @unpin="(row) => open({ type: 'confirmUnpin', row })"
      />
      <div v-else class="booting">載入中…</div>
    </main>

    <EditUserDialog
      v-if="dialog?.type === 'edit'"
      :key="`edit-${dialog.row.id}`"
      :row="dialog.row"
      :draft="dialog.draft"
      :server-errors="dialog.serverErrors"
      @cancel="close"
      @submit="(input) => dialog && open({ type: 'confirmUpdate', row: dialog.row, input })"
    />

    <ConfirmDialog
      v-else-if="dialog?.type === 'confirmUpdate'"
      title="確定要更新這筆資料嗎？"
      confirm-text="確定更新"
      :busy="busy"
      :error="dialogError"
      @cancel="open({ type: 'edit', row: dialog.row, draft: dialog.input })"
      @confirm="confirmUpdate(dialog)"
    >
      <p>#{{ dialog.row.id }} {{ dialog.row.userName }}</p>
      <table v-if="changes.length" class="diff">
        <thead><tr><th>欄位</th><th>原本</th><th>改為</th></tr></thead>
        <tbody>
          <tr v-for="c in changes" :key="c.label">
            <td>{{ c.label }}</td><td class="from">{{ c.from }}</td><td class="to">{{ c.to }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="hint">沒有任何欄位變更。</p>
    </ConfirmDialog>

    <ConfirmDialog
      v-else-if="dialog?.type === 'confirmDelete'"
      title="確定要刪除這筆資料嗎？"
      confirm-text="確定刪除"
      danger
      :busy="busy"
      :error="dialogError"
      @cancel="close"
      @confirm="run(() => list.removeRow(dialog!.row.id), `已刪除 #${dialog!.row.id}`)"
    >
      <p>
        <b>#{{ dialog.row.id }} {{ dialog.row.userName }}</b>（{{ dialog.row.position }}，{{ dialog.row.location }}）
      </p>
      <p class="hint">刪除後無法復原。</p>
    </ConfirmDialog>

    <PinDialog
      v-else-if="dialog?.type === 'pin'"
      :row="dialog.row"
      :current-index="dialog.index"
      :total="total"
      :busy="busy"
      :error="dialogError"
      @cancel="close"
      @submit="(p) => run(() => list.pinRow(dialog!.row.id, p), `已把 #${dialog!.row.id} 釘選在第 ${p} 列`)"
    />

    <ConfirmDialog
      v-else-if="dialog?.type === 'confirmUnpin'"
      title="取消釘選？"
      confirm-text="取消釘選"
      :busy="busy"
      :error="dialogError"
      @cancel="close"
      @confirm="run(() => list.unpinRow(dialog!.row.id), `已取消釘選 #${dialog!.row.id}`)"
    >
      <p>#{{ dialog.row.id }} {{ dialog.row.userName }} 目前釘選在第 {{ dialog.row.pinnedAt }} 列，取消後會回到依排序規則的位置。</p>
    </ConfirmDialog>

    <div v-if="toast" class="toast" role="status">{{ toast }}</div>
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
.search {
  font: inherit;
  width: min(420px, 100%);
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
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
  .layout {
    padding-block: 12px;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
}
</style>
