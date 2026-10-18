<script setup lang="ts">
import { reactive, ref } from 'vue'
import BaseDialog from './BaseDialog.vue'
import type { UserInput } from '../types/user'
import {
  AGE_MAX,
  AGE_MIN,
  DATE_MAX,
  DATE_MIN,
  validateUserInput,
  type FieldErrors,
} from '../utils/validate'

const props = defineProps<{
  title: string
  /** 表單的初始值；新增時不帶 */
  initial?: UserInput
  serverErrors?: FieldErrors
  submitText?: string
  busy?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ submit: [input: UserInput]; cancel: [] }>()

const EMPTY: Record<keyof UserInput, string | number> = {
  userName: '',
  position: '',
  location: '',
  age: '',
  dateStart: '',
}
const form = reactive<Record<keyof UserInput, string | number>>({
  ...EMPTY,
  ...pick(props.initial),
})

// 只取表單的 5 個欄位（傳進來的可能是含 id、version 的整筆資料）
function pick(input?: UserInput) {
  if (!input) return {}
  const { userName, position, location, age, dateStart } = input
  return { userName, position, location, age, dateStart }
}
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
  <BaseDialog
    :title="title"
    @close="!busy && emit('cancel')"
  >
    <form
      id="edit-user-form"
      class="form"
      novalidate
      @submit.prevent="submit"
    >
      <label
        v-for="field in FIELDS"
        :key="field.key"
        class="field"
      >
        <span>{{ field.label }}</span>
        <input
          v-model="form[field.key]"
          :name="field.key"
          :type="field.type"
          :min="
            field.key === 'age'
              ? AGE_MIN
              : field.key === 'dateStart'
                ? DATE_MIN
                : undefined
          "
          :max="
            field.key === 'age'
              ? AGE_MAX
              : field.key === 'dateStart'
                ? DATE_MAX
                : undefined
          "
          :step="field.key === 'age' ? 1 : undefined"
          :aria-invalid="!!errors[field.key]"
        />
        <small
          v-if="errors[field.key]"
          class="error"
          >{{ errors[field.key] }}</small
        >
      </label>
    </form>
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>
    <template #buttons>
      <button
        class="btn"
        type="button"
        :disabled="busy"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        class="btn primary"
        type="submit"
        form="edit-user-form"
        :disabled="busy"
      >
        {{ busy ? '處理中…' : (submitText ?? '下一步') }}
      </button>
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
