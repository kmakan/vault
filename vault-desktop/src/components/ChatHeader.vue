<template>
  <div class="chat-header" v-if="chat">
    <div class="chat-header-info">
      <button v-if="isMobile" class="chat-back-btn" @click="$emit('back')" :title="t('back') || 'Назад'">
        <Icon name="chevron-left" :size="22" />
      </button>
      <!-- На узких экранах она ПЕРЕВОРАЧИВАЕТСЯ вертикально (media <768)
           сжималось и перекрывалось кнопками действий (звезда избранного
           добавила 6-ю кнопку справа).
           -->
      <div class="chat-head-col">
      <template v-if="type === 'group'">
        <img v-if="group && groupAvatar" :src="groupAvatar" class="group-avatar group-avatar-img" :alt="group.name" />
        <div v-else class="group-avatar">
          {{ (group && (groupIcon || group.name?.charAt(0).toUpperCase())) || '?' }}
        </div>
      </template>
      <template v-else-if="chat === '__notes__'">
        <div class="notes-self-avatar notes-self-avatar-lg">
          <Icon name="pencil" :size="20" gradient cls="notes-self-icon" />
        </div>
      </template>
      <template v-else>
        <button class="chat-avatar-btn" :title="t('profile_title_of', { name: nameOf(chat) || chat })" @click="$emit('open-card', chat)">
          <UserAvatar :email="chat" :avatarUrl="avatarOf(chat)" :size="40" />
        </button>
      </template>
      <div class="chat-header-text" :class="{ 'text-inline': type !== 'group' && chat !== '__notes__' }">
        <h3>{{ name }}</h3>
        <div class="chat-status">
          <template v-if="type === 'group'">
            <span class="members-count" @click="$emit('members')">
              <Icon name="users" :size="15" gradient cls="members-count-icon" />
              {{ (group?.members || []).length }} {{ membersLabel((group?.members || []).length) }}
            </span>
          </template>
          <template v-else-if="chat === '__notes__'">
            <span>{{ t('notes_self_status') || 'Локально · только на этом устройстве' }}</span>
          </template>
          <template v-else>
            <Icon v-if="hasPeerKey" name="lock" :size="11" /><Icon v-else name="alert" :size="11" /><span class="chat-enc-text">{{ hasPeerKey ? ' Encrypted' : ' No key' }}</span>
            <span v-if="relayEmailDelivery" class="relay-delivery-badge" :title="t('relay_delivery_email_hint')" @click="$emit('relay-explain')">
              <Icon name="mail" :size="11" /><span>{{ t('relay_delivery_email') }}</span>
            </span>
          </template>
        </div>
      </div>
      </div>
    </div>
    <div class="chat-actions">
      <template v-if="type === 'group'">
        <button v-if="isAdmin" class="chat-action-btn" @click="$emit('add-member')" :title="t('add_member') || 'Добавить участника'"><Icon name="user-plus" :size="17" /><span class="chat-action-label">{{ t('add_member') || 'Добавить участника' }}</span></button>
        <button class="chat-action-btn" :title="t('group_refresh') || 'Перечитать группу (полный скан)'" @click="$emit('refresh-group')"><Icon name="refresh" :size="17" /></button>
        <button class="chat-action-btn" @click="$emit('group-settings')" :title="t('group_settings') || 'Настройки группы'"><Icon name="settings" :size="17" /><span class="chat-action-label">{{ t('group_settings') || 'Настройки' }}</span></button>
      </template>
      <template v-else-if="chat && chat !== '__notes__'">
        <!-- Замок-индикатор был убран по просьбе пользователя. -->
        <button v-if="expCalls && hasPeerKey" class="chat-action-btn" @click="$emit('call')" :title="t('call_start') || 'Позвонить'"><Icon name="phone" :size="17" /></button>
        <button class="chat-action-btn" @click="$emit('edit-contact', chat)" :title="t('contact_edit') || 'Локальные имя и аватар контакта'"><Icon name="pencil" :size="17" /></button>
      </template>
      <!-- Исчезающие сообщения: таймер для этого чата.
           Единый стиль с chat-action-btn; состояние — цвет иконки
           (серый выкл / янтарный вкл) и заливка кнопки.
           -->
      <div v-if="chat && chat !== '__notes__'" class="ephemeral-menu">
        <button class="chat-action-btn ephemeral-btn" :class="{ 'ephemeral-on': ephemeralTtl > 0 }"
          :title="t('ephemeral_title') + (ephemeralTtl ? t('ephemeral_on_suffix').replace('{ttl}', ephemeralLabel(ephemeralTtl)) : t('ephemeral_off_suffix'))"
          @click="$emit('ephemeral-menu')">
          <Icon name="lock" :size="17" :color="ephemeralTtl > 0 ? '#f59e0b' : '#8b949e'" />
        </button>
        <div v-if="ephemeralMenuOpen" class="export-menu ephemeral-dropdown">
          <button v-for="opt in ephemeralOptions" :key="opt.v"
            :class="{ active: ephemeralTtl === opt.v }"
            @click="$emit('ephemeral-apply', opt.v)">
            {{ opt.label }}
          </button>
        </div>
      </div>
      <!-- Избранное: показать только помеченные сообщения чата.
           Активный режим — янтарная звезда (стиль исчезающих сообщений).
           -->
      <button v-if="chat && chat !== '__notes__'" class="chat-action-btn" :class="{ 'starred-on': starredOnly }"
        :title="(t('chat_starred') || 'Избранное') + (starredOnly ? ' — показать все сообщения' : '')"
        @click="$emit('toggle-starred')">
        <Icon name="star" :size="17" :color="starredOnly ? '#f59e0b' : '#8b949e'" />
      </button>
      <button @click="$emit('toggle-search')" :title="t('nav_search') || 'Search'"><Icon name="search" :size="17" /></button>
      <div class="export-dropdown" v-if="chat">
        <button class="export-btn" @click="$emit('export-menu')" :title="t('chat_export') || 'Export'">
          <Icon name="download" :size="17" cls="export-icon" />
        </button>
        <div v-if="exportMenuOpen" class="export-menu">
          <button @click="$emit('export-json')"><Icon name="copy" :size="14" /> JSON</button>
          <button @click="$emit('export-txt')"><Icon name="pencil" :size="14" /> TXT</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from '../i18n.js'
import Icon from './Icon.vue'
import UserAvatar from './UserAvatar.vue'

// Шапка чата (Этап 3 декомпозиции App.vue): презентационный компонент —
// аватар/имя/статус/кнопки действий; состояние (активный чат, группы,
// исчезающие сообщения, избранное) живёт в родителе, отсюда — события.
const { t } = useI18n()

defineProps({
  chat: { type: String, default: '' },
  type: { type: String, default: 'contact' },
  name: { type: String, default: '' },
  group: { type: Object, default: null },
  groupAvatar: { type: String, default: '' },
  groupIcon: { type: String, default: '' },
  isMobile: { type: Boolean, default: false },
  isAdmin: { type: Boolean, default: false },
  hasPeerKey: { type: Boolean, default: false },
  relayEmailDelivery: { type: Boolean, default: false },
  expCalls: { type: Boolean, default: false },
  ephemeralTtl: { type: Number, default: 0 },
  ephemeralMenuOpen: { type: Boolean, default: false },
  ephemeralOptions: { type: Array, default: () => [] },
  starredOnly: { type: Boolean, default: false },
  exportMenuOpen: { type: Boolean, default: false },
  // функции-рендеры родителя (имя контакта, аватар, подпись участников)
  nameOf: { type: Function, required: true },
  avatarOf: { type: Function, required: true },
  membersLabel: { type: Function, required: true },
  ephemeralLabel: { type: Function, required: true },
})

defineEmits(['back', 'open-card', 'members', 'relay-explain', 'add-member', 'refresh-group', 'group-settings', 'call', 'edit-contact', 'ephemeral-menu', 'ephemeral-apply', 'toggle-starred', 'toggle-search', 'export-menu', 'export-json', 'export-txt'])
</script>

<!-- Стили шапки чата (chat-header/chat-head-col/chat-actions/ephemeral/
     export/members-count/chat-back-btn + media<768) — scoped здесь;
     глобальными в App.vue остаются .group-avatar*, .notes-self-avatar*
     (шарятся с ContactList) и .chat-mute-icon. -->
<style scoped>
.chat-header {
  flex-shrink: 0;
  padding: 16px 24px;
  /* Android edge-to-edge: на узких экранах чат занимает всю ширину и шапка
     оказывается под статус-баром — отступ через safe-area-inset-top. */
  padding-top: calc(16px + var(--safe-top, 0px));
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-secondary);
}

.chat-header-info {
  display: flex;
  align-items: center;
  gap: 14px;
  /* flex:1 + min-width:0 — без них имя чата не сжимается и выталкивает
     кнопки действий за экран (узкие экраны android). */
  flex: 1;
  min-width: 0;
}

/* На десктопе — ряд.
   На мобильном (media <768 ниже) — колонка: имя и замок ПОД аватаром
   чтобы не перекрываться кнопками действий (звезда добавила 6-ю кнопку).
   */
.chat-head-col {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.chat-header-info h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-status {
  font-size: 12px;
  color: var(--text-muted);
}

/* §1: индикатор канала доставки — конверт «почта», когда релей недоступен
   или суточный лимит исчерпан. Спокойный янтарный, не пугает. */
.relay-delivery-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 6px;
  color: var(--accent-warning, #d97706);
  cursor: pointer;
  opacity: 0.9;
}
.relay-delivery-badge:active {
  opacity: 1;
}

.chat-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.chat-actions button {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 18px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.chat-actions button:hover {
  background: var(--bg-hover);
}

/* Текстовые кнопки действий в шапке группового чата
   («Добавить участника», «Настройки») — заметнее, чем голые эмодзи. */
.chat-actions button.chat-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-weight: 500;
  padding: 6px 10px;
  border: none; 
  background: transparent;
  border-radius: var(--radius-sm, 8px);
  color: var(--text-secondary, #aaa);
  white-space: nowrap;
}

.chat-actions button.chat-action-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary, #fff);
  border-color: var(--border, rgba(255,255,255,0.2));
}

.chat-avatar-btn {
  padding: 0; border: none; background: none; cursor: pointer;
  border-radius: 50%; flex-shrink: 0;
}
.chat-avatar-btn:hover { box-shadow: 0 0 0 2px rgba(245,158,11,.5); }

/* Members count (кликабельный счётчик участников в шапке группы) */
.members-count {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.members-count-icon {
  display: block;
  flex-shrink: 0;
  filter: drop-shadow(0 0 3px rgba(139, 92, 246, 0.4));
}

/* Активный режим «показать только избранное» в шапке чата */
.chat-action-btn.starred-on {
  background: rgba(245, 158, 11, 0.15);
  border-radius: 6px;
}

/* Export dropdown */
.export-dropdown {
  position: relative;
}

.export-btn {
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-action-icon {
  display: block;
}

.export-menu {
  position: absolute;
  top: 100%;
  right: 0;
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 8px;
  box-shadow: var(--shadow-md, 0 4px 12px rgba(0,0,0,0.4));
  overflow: hidden;
  z-index: 50;
  min-width: 120px;
}

/* Исчезающие сообщения: кнопка-таймер в шапке чата.
   Неактивный — как остальные (без обводки, серый замок).
   Активный — янтарный замок + янтарные обводка и заливка кнопки.
   */
.ephemeral-menu { position: relative; }
.chat-actions button.chat-action-btn.ephemeral-on {
  border: 1px solid rgba(245, 158, 11, 0.65);
  background: rgba(245, 158, 11, 0.12);
}
.export-menu.ephemeral-dropdown { min-width: 150px; }
.export-menu.ephemeral-dropdown button {
  display: block; width: 100%; text-align: left;
  padding: 9px 14px; background: none; border: none;
  color: var(--text-primary, #e6edf3); font-size: 13px; cursor: pointer;
}
.export-menu.ephemeral-dropdown button:hover { background: var(--bg-hover, rgba(255,255,255,0.06)); }
.export-menu.ephemeral-dropdown button.active { color: var(--accent-warn, #f59e0b); }

.export-menu button {
  display: block;
  width: 100%;
  padding: 10px 14px;
  background: none;
  border: none;
  color: var(--text-primary, #f1f5f9);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s;
}

.export-menu button:hover {
  background: var(--bg-hover, #1e1e4a);
}

/* Кнопка «назад» в шапке чата (только мобильный режим). */
.chat-back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-full, 999px);
  color: var(--text-secondary, #94a3b8);
  cursor: pointer;
}
.chat-back-btn:hover {
  background: var(--bg-hover, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #e2e8f0);
}

/* Узкие экраны: шапка уплотняется, текстовые подписи скрываются. */
@media (max-width: 767px), (max-height: 479px) {
  .chat-header {
    padding: 10px 12px;
    /* safe-area сохраняется и в узкоэкранном режиме (иначе шапка чата
       залезает под статус-бар Android). */
    padding-top: calc(10px + var(--safe-top, 0px));
    gap: 6px;
  }
  .chat-header-info {
    gap: 10px;
  }
  /* встают под аватаром, ничего не перекрывается кнопками справа. */
  .chat-head-col {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .chat-head-col .chat-header-text {
    min-width: 0;
    max-width: 100%;
    align-items: flex-start;
  }
  .chat-head-col .chat-header-text.text-inline {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  .chat-head-col .chat-header-text.text-inline .chat-status {
    order: -1;      /* замок ПЕРЕД именем */
    flex-shrink: 0;
  }
  .chat-head-col .chat-header-text.text-inline h3 {
    flex: 1;
    min-width: 0;
    margin-bottom: 0;
  }
  .chat-header-text h3 {
    font-size: 14px;
    line-height: 1.25;
    margin-bottom: 1px;
  }
  .chat-head-col .group-avatar,
  .chat-head-col .chat-avatar-btn {
    width: 32px;
    height: 32px;
  }
  .chat-header-info h3 {
    font-size: 15px;
  }
  /* Android: email под аватаром не помещается и перекрывает элементы — скрыт. */
  .chat-avatar-email {
    display: none;
  }
  .chat-status {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chat-actions {
    gap: 2px;
  }
  .chat-actions button {
    padding: 6px;
  }
  .chat-actions button.chat-action-btn {
    padding: 6px 8px;
    border: none;
  }
  .chat-action-label {
    display: none;
  }
}

/* Touch-устройства (Android): hover нет, слово «Encrypted» не влезает
   рядом с кнопками — остаётся только иконка замка. Плюс запрет нативного
   выделения текста шапки (long-press открывает наше меню, а ползунки
   выделения попадают на оверлей). */
@media (hover: none) and (pointer: coarse) {
  .chat-enc-text {
    display: none;
  }
  .chat-header-text {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
}
</style>
