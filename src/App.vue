<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import UserTable from './components/UserTable.vue'
import { useUserList } from './composables/useUserList'
import { usersApi } from './api/users'

const list = useUserList()
const { rows, total, loading, hasMore, error, query, resetKey } = list

const booting = ref(true)
const bootMs = ref(0)
const keyword = ref('')

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
      />
      <div v-else class="booting">載入中…</div>
    </main>

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
@media (max-width: 640px) {
  .layout {
    padding-block: 12px;
    padding-left: max(16px, env(safe-area-inset-left, 0px));
    padding-right: max(16px, env(safe-area-inset-right, 0px));
  }
}
</style>
