<template>
  <div v-if="show" class="poll-dialog">
    <div class="poll-dialog-box">
      <div class="poll-dialog-title">{{ t('forward_to') || 'Переслать в чат' }}</div>
      <div class="forward-list">
        <button v-for="c in targets" :key="c.key" class="poll-option" @click="$emit('select', c.key)">
          <span class="poll-option-label">{{ c.label }}</span>
        </button>
      </div>
      <div class="poll-dialog-row">
        <button class="btn-primary" @click="$emit('close')">{{ t('cancel') || 'Отмена' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from '../i18n.js'

// Выбор чата для пересылки (Этап 2 декомпозиции App.vue): презентационный,
// список целей считает родитель (features/forward.js), отсюда — только
// события select/close.
const { t } = useI18n()

defineProps({
  show: { type: Boolean, default: false },
  targets: { type: Array, default: () => [] },
})

defineEmits(['close', 'select'])
</script>

<style scoped>
.poll-dialog {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}
.poll-dialog-box {
  background: var(--bg-primary, #0b0f17);
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 14px;
  padding: 18px;
  width: min(420px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.poll-dialog-title { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
.forward-list {
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.poll-dialog-row { display: flex; gap: 8px; margin-top: 4px; }
.poll-dialog-row .btn-primary { flex: 0 0 auto; padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer; }
</style>
