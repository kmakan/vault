<template>
  <div class="contacts-list">
    <div class="search-box">
      <input type="text" :placeholder="t('contacts_search')" :value="search" @input="$emit('search', $event.target.value)" />
    </div>

    <!-- Заметки для себя: локальный чат с собой.
         Не зависит от peer_keys, почты и шифрования — хранится только
         в localStorage vault-notes-<email>. -->
    <div
      class="contact-item notes-self"
      :class="{ active: active === '__notes__' }"
      @click="$emit('select-notes')"
    >
      <div class="notes-self-avatar">
        <Icon name="pencil" :size="18" gradient cls="notes-self-icon" />
      </div>
      <div class="contact-info">
        <div class="contact-name">{{ t('notes_self') || 'Заметки для себя' }}</div>
        <div class="contact-email">{{ t('notes_self_hint') || 'Только на этом устройстве' }}</div>
      </div>
    </div>
    <!-- Onboarding: no contacts and no peer keys yet -->
    <div v-if="empty" class="contacts-empty">
      <div class="contacts-empty-title">{{ t('contacts_empty_title') }}</div>
      <div class="contacts-empty-hint">{{ t('contacts_empty_hint') }}</div>
      <div class="contacts-empty-actions">
        <button class="btn-primary" @click="$emit('open-keys')"><Icon name="key" :size="15" /> {{ t('nav_keys') }}</button>
        <button class="btn-secondary" @click="$emit('open-qr')"><Icon name="link" :size="15" /> {{ t('nav_add_contact') }}</button>
      </div>
    </div>
    <div
      v-for="contact in contacts"
      :key="contact.email"
      :class="['contact-item', { active: active === contact.email }]"
      @click="$emit('select-chat', contact.email)"
      @contextmenu="$emit('menu', { type: 'contact', email: contact.email }, $event)"
    >
      <UserAvatar :email="contact.email" :avatarUrl="avatarOf(contact.email)" :size="36" />
      <div class="contact-info">
        <div class="contact-name">{{ nameOf(contact.email) }}</div>
        <div class="contact-email">{{ contact.email }}</div>
      </div>
      <div class="contact-status">
        <span v-if="unreadOf(contact.email)" class="unread-badge">{{ unreadOf(contact.email) }}</span>
        <Icon v-if="isMuted(contact.email.toLowerCase())" name="bell-off" :size="14" cls="chat-mute-icon" :title="t('chat_muted') || 'Без звука'" />
        <span v-if="!peerKeys[contact.email]" class="contact-no-key" :title="t('contact_no_key_hint') || 'Нет ключа собеседника — обменяйтесь ключами (по id участника или QR)'"><Icon name="unlock" :size="13" /></span>
        <span v-if="isRecentlySeen(contact.email)" class="status-dot online" :title="t('contact_seen_recently')"></span>
        <button class="contact-delete" :title="t('contact_delete') || 'Удалить контакт'" @click.stop="$emit('delete', contact.email)"><Icon name="trash" :size="14" /></button>
      </div>
    </div>

    <!-- Email load error (debug aid) -->
    <div v-if="error" class="email-error-hint">{{ error }}</div>

    <!-- Groups Section -->
    <div v-if="groups.length > 0" class="groups-section">
      <div class="groups-header">
        <Icon name="users" :size="14" cls="groups-header-icon" />
        {{ t('nav_groups') || 'Groups' }}
      </div>
      <div
        v-for="group in groups"
        :key="group.id"
        :class="['contact-item', { active: active === `group:${group.id}` }]"
        @click="$emit('select-group', group)"
        @contextmenu="$emit('menu', { type: 'group', id: group.id }, $event)"
      >
        <img v-if="avatars[group.id]" :src="avatars[group.id]" class="group-avatar group-avatar-img" :alt="group.name" />
        <div v-else class="group-avatar">
          {{ groupIconMap[group.id] || group.name.charAt(0).toUpperCase() }}
        </div>
        <div class="contact-info">
          <div class="contact-name">{{ group.name }}</div>
          <div class="contact-email">{{ (group.members || []).length }} {{ membersLabel((group.members || []).length) }}</div>
        </div>
        <div class="contact-status">
          <span v-if="unreadOf('group:' + group.id)" class="unread-badge">{{ unreadOf('group:' + group.id) }}</span>
          <Icon v-if="isMuted('group:' + group.id)" name="bell-off" :size="14" cls="chat-mute-icon" :title="t('chat_muted') || 'Без звука'" />
        </div>
      </div>
    </div>
    <!-- переключатель архива (виден, когда есть архивные чаты) -->
    <!-- v-if: показываем и когда showArchived=true, даже если архив
         опустел — иначе после «из архива» последнего чата переключатель
         исчезал и выйти из режима архива было нельзя
         -->
    <div v-if="hasArchived || showArchived" class="archive-toggle" @click="$emit('archive-toggle')">
      <Icon :name="showArchived ? 'eye-off' : 'archive'" :size="14" />
      <span>{{ showArchived ? (t('chat_hide_archive') || 'Скрыть архив') : (t('chat_show_archive') || 'Показать архив') }}</span>
    </div>
    <!-- Папки: горизонтальная лента созданных папок — отдельный
         компонент (список и активная папка живут в App:
         features/folders.js + контекстное меню чата) -->
    <FoldersBar :folders="folders" :active="activeFolder" @select="f => $emit('folder', f)" />
  </div>
</template>

<script setup>
import { useI18n } from '../i18n.js'
import Icon from './Icon.vue'
import UserAvatar from './UserAvatar.vue'
import FoldersBar from './FoldersBar.vue'

// Список чатов сайдбара (Этап 3 декомпозиции App.vue): презентационный
// компонент — поиск/архив/папки фильтрует родитель (App.vue + features),
// отсюда — только события выбора и контекстные действия.
const { t } = useI18n()

defineProps({
  search: { type: String, default: '' },
  contacts: { type: Array, default: () => [] },
  groups: { type: Array, default: () => [] },
  avatars: { type: Object, default: () => ({}) },
  groupIconMap: { type: Object, default: () => ({}) },
  folders: { type: Array, default: () => [] },
  activeFolder: { type: String, default: '' },
  active: { type: String, default: '' },
  error: { type: String, default: '' },
  empty: { type: Boolean, default: false },
  showArchived: { type: Boolean, default: false },
  hasArchived: { type: Boolean, default: false },
  peerKeys: { type: Object, default: () => ({}) },
  // функции-рендеры родителя (nameOf/unreadOf и пр.) — передаются как
  // props, чтобы компонент оставался без логики состояния App
  nameOf: { type: Function, required: true },
  avatarOf: { type: Function, required: true },
  unreadOf: { type: Function, required: true },
  isMuted: { type: Function, required: true },
  isRecentlySeen: { type: Function, required: true },
  membersLabel: { type: Function, required: true },
})

defineEmits(['search', 'select-chat', 'select-group', 'select-notes', 'menu', 'delete', 'open-keys', 'open-qr', 'archive-toggle', 'folder'])
</script>

<!-- Стили .contact-*/.unread-badge/.groups-*/.archive-toggle/.search-box/
     .email-error-hint/.contacts-empty* живут здесь как scoped; глобально в
     App.vue остаются шаренные с шапкой чата .group-avatar*,
     .notes-self-avatar*/.notes-self-icon, .chat-mute-icon, .status-dot. -->
<style scoped>
.search-box {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.search-box input {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: all var(--transition-fast);
}
.search-box input::placeholder {
  color: var(--text-muted);
}
.search-box input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-glow);
}
.contacts-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Android: последний контакт не прятался под системной навигацией */
  padding-bottom: var(--safe-bottom, 0px);
}
.contacts-empty {
  padding: 24px 20px;
  text-align: center;
}
.contacts-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.contacts-empty-hint {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
  margin-bottom: 16px;
}
.contacts-empty-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.contacts-empty-actions .btn-primary,
.contacts-empty-actions .btn-secondary {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.contact-item {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  cursor: pointer;
  transition: all var(--transition-fast);
  border-left: 3px solid transparent;
}
.contact-item:hover {
  background: var(--bg-hover);
}
.contact-item.active {
  background: var(--bg-active);
  border-left-color: var(--accent-primary);
}
.contact-info {
  flex: 1;
  min-width: 0;
}
.contact-name {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.contact-email {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.contact-status {
  margin-left: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
/* Бейдж непрочитанных сообщений на контакте/группе — оранжевый кружок
   с белой цифрой. Появляется только когда есть >0. */
.unread-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--accent-primary);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
  display: inline-block;
  flex-shrink: 0;
}
/* Бейдж «нет ключа» — контакт виден (напр. из участников группы), но для
   чата 1-на-1 нужно сначала обменяться ключами (🔗). */
.contact-no-key {
  font-size: 12px;
  opacity: 0.7;
  cursor: help;
}
/* Удаление контакта — появляется при наведении на контакт */
.contact-delete {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  opacity: 0;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
}
.contact-item:hover .contact-delete {
  opacity: 0.55;
}
.contact-item:hover .contact-delete:hover {
  opacity: 1;
  background: rgba(220, 60, 60, 0.18);
}
.groups-section {
  margin-top: 16px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.groups-header {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.groups-header-icon {
  display: block;
  flex-shrink: 0;
}
.email-error-hint {
  margin: 8px 10px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--text-secondary, #94a3b8);
  background: var(--bg-tertiary, #1a1a3e);
  border: 1px solid var(--danger, #ef4444);
  border-radius: 6px;
  word-break: break-word;
}
/* переключатель архива в списке чатов */
.archive-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 12px;
  padding: 8px 12px;
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-tertiary, #1e1e3a);
  color: var(--text-secondary, #94a3b8);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}
.archive-toggle:hover { background: var(--bg-hover, #26264f); color: var(--text-primary, #f1f5f9); }
</style>
