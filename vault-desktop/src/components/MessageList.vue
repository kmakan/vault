<template>
  <div class="messages" ref="container" @scroll="$emit('scroll', $event)">
    <div v-if="chat && starredOnly && list.length === 0" class="messages-empty">
      <div class="empty-icon"><Icon name="star" :size="28" gradient /></div>
      <div class="empty-text">{{ t('starred_empty') || 'Нет избранных сообщений' }}</div>
    </div>
    <div v-else-if="chat && list.length === 0" class="messages-empty">
      <div class="empty-icon"><Icon name="lock" :size="28" gradient /></div>
      <div class="empty-text">{{ t('chat_empty') || 'Нет сообщений — отправьте первое' }}</div>
    </div>
    <!-- Закреплённое сообщение группы (баннер; открепить может админ) -->
    <div v-if="type === 'group' && pinnedId" class="pinned-banner" @click="$emit('scroll-pinned')">
      <Icon name="pin" :size="14" cls="pinned-banner-icon" />
      <span class="pinned-banner-text">{{ pinnedPreview || t('pinned_message') || 'Закреплённое сообщение' }}</span>
      <button v-if="isAdmin" class="pinned-banner-unpin" :title="t('unpin_message') || 'Открепить'" @click.stop="$emit('unpin')"><Icon name="x" :size="13" /></button>
    </div>
    <slot></slot>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useI18n } from '../i18n.js'
import Icon from './Icon.vue'

// Контейнер списка сообщений (Этап 3 декомпозиции App.vue): скролл-бокс,
// пустые состояния и баннер закреплённого. Карточки сообщений приходят
// слотом от родителя (MessageItem выделит их следующим шагом), доступ
// к DOM-элементу — через expose: App-методы скролла/пиннинга работают
// с корневым .messages (scrollHeight/offsetTop, data-msg-id внутри).
const { t } = useI18n()

const container = ref(null)
defineExpose({ container })

defineProps({
  chat: { type: String, default: '' },
  type: { type: String, default: 'contact' },
  list: { type: Array, default: () => [] },
  starredOnly: { type: Boolean, default: false },
  pinnedId: { type: String, default: '' },
  pinnedPreview: { type: String, default: '' },
  isAdmin: { type: Boolean, default: false },
})

defineEmits(['scroll', 'scroll-pinned', 'unpin'])
</script>

<!-- Стили скролл-контейнера и пустых состояний; стили карточек (.message*)
     остаются глобальными в App.vue до выделения MessageItem. -->
<style scoped>
.messages {
  flex: 1;
  /* flex-элемент с overflow:auto обязан иметь
     min-height: 0, иначе он растягивается на высоту контента и скролл
     (в т.ч. колесиком мыши) не появляется.
     */
  min-height: 0;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  position: relative; /* offsetTop элементов считается от этого контейнера */
}

.messages-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  gap: 12px;
}

.empty-icon { font-size: 64px; margin-bottom: 16px; opacity: 0.5; }

.empty-text { font-size: 16px; }

/* Закреплённое сообщение группы (баннер поверх списка) */
.pinned-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(99, 102, 241, 0.12);
  border: 1px solid rgba(99, 102, 241, 0.35);
  border-radius: 10px;
  cursor: pointer;
  flex-shrink: 0;
  font-size: 13px;
}
.pinned-banner-icon { flex-shrink: 0; }
.pinned-banner-text {
  flex: 1;
  color: var(--text-primary, #f1f5f9);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pinned-banner-unpin {
  background: transparent;
  border: none;
  color: var(--text-muted, #64748b);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 6px;
}
.pinned-banner-unpin:hover { background: rgba(255,255,255,0.1); color: var(--text-primary, #f1f5f9); }
</style>
