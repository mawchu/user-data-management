<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  watchEffect,
} from 'vue'
import type { SortKey, SortOrder, UserRow } from '../types/user'

const props = defineProps<{
  rows: UserRow[]
  sortBy: SortKey | null
  order: SortOrder
  loading: boolean
  hasMore: boolean
  resetKey: number
}>()
const emit = defineEmits<{
  sort: [key: SortKey]
  loadMore: []
  edit: [row: UserRow]
  delete: [row: UserRow]
  pin: [row: UserRow]
  unpin: [row: UserRow]
}>()

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'userName', label: 'User name' },
  { key: 'position', label: 'Position' },
  { key: 'location', label: 'Location' },
  { key: 'age', label: 'Age' },
  { key: 'dateStart', label: 'Date Start' },
]

// 虛擬捲動：所有列都有固定高度，只渲染視窗內看得到的列（加上下各 OVERSCAN 列緩衝）
const ROW_HEIGHT = 44
const OVERSCAN = 8
// 離已載入資料底部剩不到這麼多列時，就先載入下一批
const PREFETCH_ROWS = 150

const scroller = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportHeight = ref(600)
const selectedId = ref<number | null>(null)

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
// 第 rowIndex % poolSize 格。往下捲 1 列時，只有捲出去的那一格搬到最下面換資料，
// 其餘格子的內容和位置都不變，不必一直建立、刪除 DOM。
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

let frame = 0
function onScroll() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(
    () => (scrollTop.value = scroller.value?.scrollTop ?? 0),
  )
}

let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(
    ([entry]) => (viewportHeight.value = entry.contentRect.height),
  )
  observer.observe(scroller.value!)
})
onBeforeUnmount(() => observer?.disconnect())

watchEffect(() => {
  if (
    props.hasMore &&
    !props.loading &&
    props.rows.length - end.value < PREFETCH_ROWS
  )
    emit('loadMore')
})

watch(
  () => props.resetKey,
  () => {
    if (scroller.value) scroller.value.scrollTop = 0
    scrollTop.value = 0
  },
)

function ariaSort(key: SortKey) {
  if (props.sortBy !== key) return 'none'
  return props.order === 'asc' ? 'ascending' : 'descending'
}
</script>

<template>
  <div
    ref="scroller"
    class="scroller"
    role="table"
    aria-label="使用者列表"
    :aria-rowcount="rows.length"
    @scroll="onScroll"
  >
    <div
      class="row head"
      role="row"
    >
      <div
        class="cell num"
        role="columnheader"
      >
        列
      </div>
      <div
        class="cell id"
        role="columnheader"
      >
        ID
      </div>
      <div
        v-for="column in COLUMNS"
        :key="column.key"
        class="cell"
        role="columnheader"
        :aria-sort="ariaSort(column.key)"
      >
        <button
          class="sort"
          :class="{ active: sortBy === column.key }"
          @click="emit('sort', column.key)"
        >
          {{ column.label }}
          <span
            class="arrow"
            aria-hidden="true"
            >{{
              sortBy !== column.key ? '↕' : order === 'asc' ? '↑' : '↓'
            }}</span
          >
        </button>
      </div>
      <div
        class="cell actions"
        role="columnheader"
      >
        操作
      </div>
    </div>

    <div
      class="body"
      :style="{ height: `${rows.length * ROW_HEIGHT}px` }"
      @focusin="onFocusIn"
    >
      <div
        v-for="{ slot, rowIndex, row } in slots"
        :key="slot"
        class="row"
        :class="{
          pinned: row.pinnedAt !== null,
          selected: selectedId === row.id,
        }"
        :style="{ transform: `translateY(${rowIndex * ROW_HEIGHT}px)` }"
        role="row"
        :aria-rowindex="rowIndex + 1"
        :data-id="row.id"
        @click="selectedId = row.id"
      >
        <div
          class="cell num"
          role="cell"
        >
          {{ (rowIndex + 1).toLocaleString() }}
          <span
            v-if="row.pinnedAt !== null"
            class="pin-badge"
            :title="`釘選在第 ${row.pinnedAt} 列`"
            >📌</span
          >
        </div>
        <div
          class="cell id"
          role="cell"
        >
          {{ row.id }}
        </div>
        <div
          class="cell"
          role="cell"
        >
          {{ row.userName }}
        </div>
        <div
          class="cell"
          role="cell"
        >
          {{ row.position }}
        </div>
        <div
          class="cell"
          role="cell"
        >
          {{ row.location }}
        </div>
        <div
          class="cell"
          role="cell"
        >
          {{ row.age }}
        </div>
        <div
          class="cell"
          role="cell"
        >
          {{ row.dateStart }}
        </div>
        <div
          class="cell actions"
          role="cell"
        >
          <button
            class="btn small"
            @click.stop="emit('edit', row)"
          >
            編輯
          </button>
          <button
            v-if="row.pinnedAt === null"
            class="btn small"
            @click.stop="emit('pin', row)"
          >
            釘選
          </button>
          <button
            v-else
            class="btn small"
            @click.stop="emit('unpin', row)"
          >
            取消釘選
          </button>
          <button
            class="btn small danger"
            @click.stop="emit('delete', row)"
          >
            刪除
          </button>
        </div>
      </div>
    </div>

    <div class="footer">
      <template v-if="loading">載入中…</template>
      <template v-else-if="!hasMore && rows.length">已經到底了</template>
      <template v-else-if="!rows.length">沒有符合的資料</template>
    </div>
  </div>
</template>

<style scoped>
.scroller {
  height: 100%;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
}
.row {
  display: grid;
  grid-template-columns:
    96px 96px minmax(150px, 1.3fr) minmax(170px, 1.4fr)
    minmax(110px, 1fr) 84px 120px 236px;
  min-width: 1090px;
  height: 44px;
  align-items: center;
  border-bottom: 1px solid var(--border);
}
.row.head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--surface-2);
  font-weight: 600;
}
.body {
  position: relative;
}
.body .row {
  position: absolute;
  inset: 0 0 auto 0;
}
.body .row:hover {
  background: var(--hover);
}
.row.selected {
  background: var(--selected) !important;
}
.row.pinned {
  background: var(--pinned);
}
.cell {
  padding: 0 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.num,
.id {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.pin-badge {
  margin-left: 2px;
}
.actions {
  display: flex;
  gap: 6px;
}
.sort {
  all: unset;
  cursor: pointer;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.sort:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.sort .arrow {
  color: var(--muted);
}
.sort.active .arrow {
  color: var(--accent);
}
.footer {
  position: sticky;
  left: 0;
  padding: 12px;
  text-align: center;
  color: var(--muted);
}
</style>
