<script setup lang="ts">
import { onMounted, ref } from 'vue'

defineProps<{ title: string }>()
const emit = defineEmits<{ close: [] }>()
const dialogElement = ref<HTMLDialogElement>()

// 原生 <dialog>：showModal() 內建焦點鎖定、Esc 關閉與背景遮罩
onMounted(() => dialogElement.value?.showModal())
</script>

<template>
  <dialog ref="dialogElement" class="dialog" @cancel.prevent="emit('close')" @click.self="emit('close')">
    <div class="panel">
      <h2>{{ title }}</h2>
      <slot />
      <div class="buttons"><slot name="buttons" /></div>
    </div>
  </dialog>
</template>

<style scoped>
.dialog {
  border: none;
  border-radius: 12px;
  padding: 0;
  width: min(460px, calc(100vw - 32px));
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 20px 50px rgb(0 0 0 / 0.25);
}
.dialog::backdrop {
  background: rgb(15 23 42 / 0.45);
}
.panel {
  padding: 20px 24px;
}
h2 {
  margin: 0 0 12px;
  font-size: 18px;
}
.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
</style>
