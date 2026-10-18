<script setup lang="ts">
import { reactive, ref } from 'vue'
import BaseDialog from './BaseDialog.vue'
import type { UserInput, UserRow } from '../types/user'
import { AGE_MAX, AGE_MIN, DATE_MAX, DATE_MIN, validateUserInput, type FieldErrors } from '../utils/validate'

const props = defineProps<{ row: UserRow; draft?: UserInput; serverErrors?: FieldErrors }>()
const emit = defineEmits<{ submit: [input: UserInput]; cancel: [] }>()

const form = reactive<Record<keyof UserInput, string | number>>({ ...(props.draft ?? props.row) })
const errors = ref<FieldErrors>(props.serverErrors ?? {})

const FIELDS = [
  { key: 'userName', label: 'User name', type: 'text' },
  { key: 'position', label: 'Position', type: 'text' },
  { key: 'location', label: 'Location', type: 'text' },
  { key: 'age', label: 'Age', type: 'number' },
  { key: 'dateStart', label: 'Date Start', type: 'date' },
] as const

function submit() {
  const input: UserInput = {
    userName: String(form.userName).trim(),
    position: String(form.position).trim(),
    location: String(form.location).trim(),
    // type="number" 的 v-model 會自動轉成數字，空白時則是空字串
    age: String(form.age).trim() === '' ? NaN : Number(form.age),
    dateStart: String(form.dateStart),
  }
  errors.value = validateUserInput(input)
  if (Object.keys(errors.value).length === 0) emit('submit', input)
}
</script>

<template>
  <BaseDialog :title="`編輯使用者 #${row.id}`" @close="emit('cancel')">
    <form id="edit-user-form" class="form" novalidate @submit.prevent="submit">
      <label v-for="f in FIELDS" :key="f.key" class="field">
        <span>{{ f.label }}</span>
        <input
          v-model="form[f.key]"
          :name="f.key"
          :type="f.type"
          :min="f.key === 'age' ? AGE_MIN : f.key === 'dateStart' ? DATE_MIN : undefined"
          :max="f.key === 'age' ? AGE_MAX : f.key === 'dateStart' ? DATE_MAX : undefined"
          :step="f.key === 'age' ? 1 : undefined"
          :aria-invalid="!!errors[f.key]"
        />
        <small v-if="errors[f.key]" class="error">{{ errors[f.key] }}</small>
      </label>
    </form>
    <template #buttons>
      <button class="btn" type="button" @click="emit('cancel')">取消</button>
      <button class="btn primary" type="submit" form="edit-user-form">下一步</button>
    </template>
  </BaseDialog>
</template>

<style scoped>
.form {
  display: grid;
  gap: 12px;
}
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
input[aria-invalid='true'] {
  border-color: var(--danger);
}
</style>
