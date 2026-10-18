<script setup lang="ts">
// v1（保留對照，目前沒有被使用）：用資料 id 當 key，捲動時汰換頭尾的 DOM。
// 已由 ../UserTable.vue 的 DOM 回收版取代，差異與原因見 docs/adr/0012-dom-recycling.md。
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  watchEffect,
} from 'vue'
import type { SortKey, SortOrder, User } from '../../types/user'

const props = defineProps<{
  rows: User[]
  pins?: ReadonlyMap<number, number>
  sortBy: SortKey | null
  order: SortOrder
  loading: boolean
  hasMore: boolean
  resetKey: number
}>()
const emit = defineEmits<{
  sort: [key: SortKey]
  loadMore: []
  edit: [row: User]
  delete: [row: User]
  pin: [row: User]
  unpin: [row: User]
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
const visibleRows = computed(() => props.rows.slice(start.value, end.value))

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
    >
      <div
        class="window"
        :style="{ transform: `translateY(${start * ROW_HEIGHT}px)` }"
      >
        <div
          v-for="(row, offset) in visibleRows"
          :key="row.id"
          class="row"
          :class="{
            pinned: pins?.has(row.id),
            selected: selectedId === row.id,
          }"
          role="row"
          :aria-rowindex="start + offset + 1"
          :data-id="row.id"
          @click="selectedId = row.id"
        >
          <div
            class="cell num"
            role="cell"
          >
            {{ (start + offset + 1).toLocaleString() }}
            <span
              v-if="pins?.has(row.id)"
              class="pin-badge"
              :title="`釘選在第 ${pins?.get(row.id)} 列`"
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
              v-if="!pins?.has(row.id)"
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
.window {
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
