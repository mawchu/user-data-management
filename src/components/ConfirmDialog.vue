<script setup lang="ts">
import BaseDialog from './BaseDialog.vue'

defineProps<{
  title: string
  confirmText: string
  danger?: boolean
  busy?: boolean
  error?: string | null
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <BaseDialog
    :title="title"
    @close="!busy && emit('cancel')"
  >
    <slot />
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
        :disabled="busy"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        class="btn primary"
        :class="{ danger }"
        :disabled="busy"
        autofocus
        @click="emit('confirm')"
      >
        {{ busy ? '處理中…' : confirmText }}
      </button>
    </template>
  </BaseDialog>
</template>
