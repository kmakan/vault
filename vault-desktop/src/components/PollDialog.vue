<template>
  <div v-if="show" class="poll-dialog">
    <div class="poll-dialog-box">
      <div class="poll-dialog-title">{{ t('poll_create') || 'Создать голосование' }}</div>
      <input v-model="question" class="duress-input" :placeholder="t('poll_question_ph') || 'Вопрос'" />
      <input v-for="(o, i) in options" :key="i" v-model="options[i]" class="duress-input" :placeholder="t('poll_option_ph') + ' ' + (i + 1)" />
      <div class="poll-dialog-row">
        <button v-if="options.length < 10" class="btn-primary" @click="options.push('')">{{ t('poll_add_option') || '+ вариант' }}</button>
        <button class="btn-primary" :disabled="!question.trim() || options.filter(o => o.trim()).length < 2" @click="confirm">{{ t('poll_send') || 'Отправить' }}</button>
        <button class="btn-primary" @click="cancel">{{ t('cancel') || 'Отмена' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import { useI18n } from '../i18n.js'

// Создание голосования: состояние формы живёт здесь (Этап 2 декомпозиции
// App.vue), наружу уходят только события — родитель шифрует и отправляет.
const { t } = useI18n()

const props = defineProps({
  show: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'confirm'])

const question = ref('')
const options = ref(['', ''])

function reset() {
  question.value = ''
  options.value = ['', '']
}

function confirm() {
  const q = question.value.trim()
  const opts = options.value.map(o => o.trim()).filter(Boolean)
  if (!q || opts.length < 2) return
  emit('confirm', q, opts)
  reset()
}

function cancel() {
  emit('close')
}

// Открытие диалога всегда начинается с чистой формы.
watch(() => props.show, v => { if (v) reset() })
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
.poll-dialog-box .duress-input {
  background: rgba(148, 163, 184, 0.08);
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 8px;
  padding: 9px 11px;
  color: inherit;
  font-size: 14px;
  outline: none;
}
.poll-dialog-box .duress-input:focus { border-color: var(--accent-primary, #6366f1); }
.poll-dialog-row { display: flex; gap: 8px; margin-top: 4px; }
.poll-dialog-row .btn-primary { flex: 0 0 auto; padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer; }
</style>
