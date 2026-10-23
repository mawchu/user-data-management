<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

// 原生 select 在手機模擬器裡選項很小、樣式也改不了，所以自己畫一個下拉選單
const props = defineProps<{
  options: { value: string; label: string }[]
  disabled?: boolean
}>()
const model = defineModel<string>({ required: true })

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const current = computed(
  () => props.options.find((option) => option.value === model.value)?.label,
)

function choose(value: string) {
  model.value = value
  open.value = false
}

function onOutside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onOutside)
    document.addEventListener('keydown', onKey)
  } else {
    document.removeEventListener('pointerdown', onOutside)
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => (open.value = false))
</script>

<template>
  <div
    ref="root"
    class="sort-menu"
  >
    <button
      type="button"
      class="trigger"
      aria-label="排序"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :disabled="disabled"
      @click="open = !open"
    >
      <span class="label">{{ current }}</span>
      <svg
        width="12"
        height="8"
        viewBox="0 0 12 8"
        aria-hidden="true"
      >
        <path
          d="M1 1l5 5 5-5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        />
      </svg>
    </button>
    <ul
      v-if="open"
      class="options"
      role="listbox"
    >
      <li
        v-for="option in options"
        :key="option.value"
        role="option"
        :aria-selected="option.value === model"
        :data-value="option.value"
        @click="choose(option.value)"
      >
        {{ option.label }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sort-menu {
  position: relative;
}
.trigger {
  font: inherit;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}
.trigger svg {
  flex: none;
  color: var(--muted);
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.options {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 60vh;
  overflow-y: auto;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.15);
}
.options li {
  min-height: 44px;
  display: flex;
  align-items: center;
  padding: 0 12px;
  cursor: pointer;
}
.options li[aria-selected='true'] {
  color: var(--accent);
  font-weight: 600;
}
.options li:hover {
  background: var(--surface-2);
}
</style>
