<script setup lang="ts">
import { ref } from 'vue'
import BaseDialog from './BaseDialog.vue'
import type { UserRow } from '../types/user'

const props = defineProps<{ row: UserRow; currentIndex: number; total: number; busy?: boolean; error?: string | null }>()
const emit = defineEmits<{ submit: [position: number]; cancel: [] }>()

const position = ref(String(props.currentIndex))
const localError = ref<string | null>(null)

function submit() {
  const n = Number(position.value)
  if (!Number.isInteger(n) || n < 1) {
    localError.value = '請輸入 1 以上的整數'
    return
  }
  localError.value = null
  emit('submit', n)
}
</script>

<template>
  <BaseDialog title="釘選到指定位置" @close="!busy && emit('cancel')">
    <p>
      把 <b>#{{ row.id }} {{ row.userName }}</b> 固定在第幾列？之後不論依哪個欄位排序，它都會顯示在這一列。
    </p>
    <form id="pin-form" class="form" novalidate @submit.prevent="submit">
      <label class="field">
        <span>位置（1–{{ total.toLocaleString() }}）</span>
        <input v-model="position" name="position" type="number" min="1" step="1" autofocus />
      </label>
    </form>
    <p v-if="localError || error" class="error" role="alert">{{ localError || error }}</p>
    <template #buttons>
      <button class="btn" type="button" :disabled="busy" @click="emit('cancel')">取消</button>
      <button class="btn primary" type="submit" form="pin-form" :disabled="busy">{{ busy ? '處理中…' : '釘選' }}</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.field {
  display: grid;
  gap: 4px;
}
.field span {
  font-size: 13px;
  color: var(--muted);
}
input {
  font: inherit;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
}
</style>
