<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  watchEffect,
} from 'vue'
import type { SortKey, SortOrder, User } from '../types/user'

const props = defineProps<{
  rows: User[]
  /** id -> 釘選位置 */
  pins: ReadonlyMap<number, number>
  /** 剛新增的資料 */
  newIds: ReadonlySet<number>
  sortBy: SortKey | null
  order: SortOrder
  loading: boolean
  hasMore: boolean
  /** 新條件還在載入，畫面上是舊資料 */
  stale: boolean
  error: string | null
  resetKey: number
}>()
const emit = defineEmits<{
  sort: [key: SortKey]
  loadMore: []
  retry: []
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

// 虛擬捲動：所有列都有固定高度，只渲染視窗內看得到的列（加上下各 OVERSCAN 列緩衝）。
// 手機（寬度 640px 以下）改成卡片，高度不同，但同一種版面內仍然固定
const DESKTOP_ROW_HEIGHT = 44
const MOBILE_ROW_HEIGHT = 124
const MOBILE_QUERY = '(max-width: 640px)'
const OVERSCAN = 8
// 離已載入資料底部剩不到這麼多列時，就先載入下一批
const PREFETCH_ROWS = 150

const scroller = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportHeight = ref(600)
const selectedId = ref<number | null>(null)
const isMobile = ref(false)
const ROW_HEIGHT = computed(() =>
  isMobile.value ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT,
)

const start = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT.value) - OVERSCAN),
)
const end = computed(() =>
  Math.min(
    props.rows.length,
    Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT.value) +
      OVERSCAN,
  ),
)
// DOM 回收：格子數量固定（視窗放得下的列數 + 上下緩衝），第 rowIndex 列固定交給
// 第 rowIndex % poolSize 格。往下捲 1 列時，只有捲出去的那一格搬到最下面換資料，
// 其餘格子的內容和位置都不變，不必一直建立、刪除 DOM。
const poolSize = computed(
  () => Math.ceil(viewportHeight.value / ROW_HEIGHT.value) + OVERSCAN * 2 + 1,
)
const slots = computed(() => {
  const size = poolSize.value
  const result: { slot: number; rowIndex: number; row: User }[] = []
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
let media: MediaQueryList | undefined
const onMediaChange = () => {
  // 版面切換時列高改變，換算成同一列的位置，避免跳到別的地方
  const firstRow = Math.floor(scrollTop.value / ROW_HEIGHT.value)
  isMobile.value = media!.matches
  if (scroller.value)
    scroller.value.scrollTop = scrollTop.value = firstRow * ROW_HEIGHT.value
}
onMounted(() => {
  observer = new ResizeObserver(
    ([entry]) => (viewportHeight.value = entry.contentRect.height),
  )
  observer.observe(scroller.value!)
  media = window.matchMedia(MOBILE_QUERY)
  isMobile.value = media.matches
  media.addEventListener('change', onMediaChange)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  media?.removeEventListener('change', onMediaChange)
})

// 預先載入。失敗（error）或正在換條件（stale）時不觸發，避免請求失敗後一直重送
watchEffect(() => {
  if (
    props.hasMore &&
    !props.loading &&
    !props.error &&
    !props.stale &&
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
    :aria-busy="stale || loading"
    :class="{ stale }"
    :style="{ '--row-height': `${ROW_HEIGHT}px` }"
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
      :inert="stale"
      @focusin="onFocusIn"
    >
      <div
        v-for="{ slot, rowIndex, row } in slots"
        :key="slot"
        class="row"
        :class="{
          pinned: pins.has(row.id),
          added: newIds.has(row.id),
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
            v-if="pins.has(row.id)"
            class="pin-badge"
            :title="`釘選在第 ${pins.get(row.id)} 列`"
            >📌</span
          >
          <span
            v-if="newIds.has(row.id)"
            class="new-badge"
            >新增</span
          >
        </div>
        <div
          class="cell id"
          role="cell"
        >
          {{ row.id }}
        </div>
        <div
          class="cell name"
          role="cell"
        >
          {{ row.userName }}
        </div>
        <div
          class="cell position"
          role="cell"
        >
          {{ row.position }}
        </div>
        <div
          class="cell location"
          role="cell"
        >
          {{ row.location }}
        </div>
        <div
          class="cell age"
          role="cell"
          data-label="Age"
        >
          {{ row.age }}
        </div>
        <div
          class="cell date"
          role="cell"
          data-label="Start"
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
            v-if="!pins.has(row.id)"
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

    <div
      class="footer"
      :class="{ 'has-error': error }"
    >
      <template v-if="error">
        <span role="alert">載入失敗：{{ error }}</span>
        <button
          class="btn small"
          @click="emit('retry')"
        >
          重試
        </button>
      </template>
      <template v-else-if="loading">載入中…</template>
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
.scroller.stale .body {
  opacity: 0.45;
  transition: opacity 0.15s;
}
.row {
  display: grid;
  grid-template-columns:
    96px 104px minmax(150px, 1.3fr) minmax(170px, 1.4fr)
    minmax(110px, 1fr) 84px 120px 236px;
  min-width: 1098px;
  height: var(--row-height);
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
.new-badge {
  margin-left: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 12px;
  background: var(--accent);
  color: #fff;
}
.row.added {
  box-shadow: inset 3px 0 0 var(--accent);
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
.footer.has-error {
  display: flex;
  gap: 12px;
  justify-content: center;
  align-items: center;
  color: var(--danger);
}

/* 手機：每列改成固定高度的卡片，表頭隱藏，排序改用頁首的選單 */
@media (max-width: 640px) {
  .row.head {
    display: none;
  }
  .body .row {
    min-width: 0;
    box-sizing: border-box;
    padding: 8px 12px 8px 0;
    grid-template-columns: 64px 1fr auto;
    grid-template-areas:
      'num name id'
      'num position date'
      'num location age'
      'num actions actions';
    align-content: center;
    row-gap: 4px;
  }
  .cell {
    padding: 0 4px;
  }
  .num {
    grid-area: num;
    align-self: start;
    padding-left: 12px;
  }
  .id,
  .date,
  .age {
    text-align: right;
  }
  .id {
    grid-area: id;
  }
  .id::before {
    content: '#';
  }
  .name {
    grid-area: name;
    font-weight: 600;
  }
  .position {
    grid-area: position;
  }
  .location {
    grid-area: location;
  }
  .age {
    grid-area: age;
  }
  .date {
    grid-area: date;
  }
  .age::before,
  .date::before {
    content: attr(data-label) ' ';
    color: var(--muted);
  }
  .actions {
    grid-area: actions;
  }
  .new-badge {
    display: block;
    width: fit-content;
    margin: 4px 0 0;
  }
}
</style>
