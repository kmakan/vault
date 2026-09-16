<template>
  <div ref="rootRef" class="contacts-list" @scroll.passive="updateActive">
    <div class="search-box">
      <input type="text" :placeholder="t('contacts_search')" :value="search" @input="$emit('search', $event.target.value)" />
    </div>

    <!-- Быстрая навигация по секциям списка (M2 UX): липкие вкладки-якоря
         «Контакты / Группы / Каналы» со счётчиками и индикатором непрочитанного.
         Клик — плавный скролл к секции; скролл-спай подсветит активную. -->
    <div v-if="tabsVisible" class="list-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="list-tab"
        :class="{ active: activeSec === tab.id }"
        @click="jumpTo(tab.id)"
      >
        <Icon :name="tab.icon" :size="13" />
        <span>{{ tab.label }}</span>
        <span class="tab-count">{{ tab.count }}</span>
        <span v-if="tab.unread" class="tab-unread" :title="t('chat_unread') || 'Непрочитанные'" />
      </button>
    </div>

    <div class="list-section" data-sec="contacts">
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
        <span v-if="isRecentlySeen(contact.email) || isOnline(contact.email)" class="status-dot online" :title="t('contact_seen_recently')"></span>
        <button class="contact-delete" :title="t('contact_delete') || 'Удалить контакт'" @click.stop="$emit('delete', contact.email)"><Icon name="trash" :size="14" /></button>
      </div>
    </div>

    <!-- Email load error (debug aid) -->
    <div v-if="error" class="email-error-hint">{{ error }}</div>
    </div>

    <!-- Groups Section -->
    <div v-if="groups.length > 0" ref="groupsRef" class="list-section groups-section" data-sec="groups">
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
    <!-- Channels Section (M2): broadcast подписки — тот же сайдбар-паттерн,
         что группы; непрочитанные считает родитель (channelUnread kv-лог). -->
    <div v-if="channels.length > 0" ref="channelsRef" class="list-section groups-section" data-sec="channels">
      <div class="groups-header">
        <Icon name="megaphone" :size="14" cls="groups-header-icon" />
        {{ t('nav_channels') || 'Channels' }}
      </div>
      <div
        v-for="ch in channels"
        :key="ch.id"
        :class="['contact-item', { active: active === `channel:${ch.id}` }]"
        @click="$emit('select-channel', ch)"
        @contextmenu="$emit('menu', { type: 'channel', id: ch.id }, $event)"
      >
        <img v-if="channelAvatars[ch.id]" :src="channelAvatars[ch.id]" class="group-avatar group-avatar-img" :alt="ch.name" />
        <div v-else class="group-avatar channel-avatar">
          <Icon name="megaphone" :size="16" />
        </div>
        <div class="contact-info">
          <div class="contact-name">{{ ch.name }}</div>
          <div class="contact-email">
            <Icon v-if="ch.is_owner" name="key" :size="10" />
            {{ ch.is_owner ? (t('channel_owner_tag') || 'автор') : (t('channel_sub_tag') || 'подписка') }}
          </div>
        </div>
        <div class="contact-status">
          <span v-if="channelUnread(ch.id)" class="unread-badge">{{ channelUnread(ch.id) }}</span>
          <Icon v-if="isMuted('channel:' + ch.id)" name="bell-off" :size="14" cls="chat-mute-icon" :title="t('chat_muted') || 'Без звука'" />
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
import { computed, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from '../i18n.js'
import Icon from './Icon.vue'
import UserAvatar from './UserAvatar.vue'
import FoldersBar from './FoldersBar.vue'

// Список чатов сайдбара (Этап 3 декомпозиции App.vue): презентационный
// компонент — поиск/архив/папки фильтрует родитель (App.vue + features),
// отсюда — только события выбора и контекстные действия.
const { t } = useI18n()

const props = defineProps({
  search: { type: String, default: '' },
  contacts: { type: Array, default: () => [] },
  groups: { type: Array, default: () => [] },
  channels: { type: Array, default: () => [] },
  channelAvatars: { type: Object, default: () => ({}) },
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
  isOnline: { type: Function, default: () => false },
  membersLabel: { type: Function, required: true },
  channelUnread: { type: Function, default: () => 0 },
})

defineEmits(['search', 'select-chat', 'select-group', 'select-channel', 'select-notes', 'menu', 'delete', 'open-keys', 'open-qr', 'archive-toggle', 'folder'])

// ── Вкладки-якоря секций (M2 UX) ───────────────────────────────────────────
const rootRef = ref(null)
const groupsRef = ref(null)
const channelsRef = ref(null)

const sumUnread = (list, idOf) =>
  list.reduce((acc, x) => acc + (props.unreadOf(idOf(x)) ? Number(props.unreadOf(idOf(x))) : 0), 0)

const tabs = computed(() => {
  const out = []
  out.push({
    id: 'contacts', icon: 'chat', label: t('nav_contacts') || 'Чаты',
    count: props.contacts.length + 1, // + заметки для себя (всегда в секции)
    unread: props.contacts.reduce((a, c) => a + (Number(props.unreadOf(c.email)) || 0), 0),
  })
  if (props.groups.length) {
    out.push({ id: 'groups', icon: 'users', label: t('nav_groups') || 'Группы', count: props.groups.length, unread: sumUnread(props.groups, g => 'group:' + g.id) })
  }
  if (props.channels.length) {
    out.push({ id: 'channels', icon: 'megaphone', label: t('nav_channels') || 'Каналы', count: props.channels.length, unread: props.channels.reduce((a, ch) => a + (Number(props.channelUnread(ch.id)) || 0), 0) })
  }
  return out
})
// Полоса имеет смысл только при длинном списке: при 2 секциях и так видно.
const tabsVisible = computed(() => tabs.value.length > 1)

const activeSec = ref('contacts')
function sectionTop(el) {
  const root = rootRef.value
  if (!root || !el) return null
  return el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
}
function updateActive() {
  const root = rootRef.value
  if (!root) return
  // активна последняя секция, чей верх выше порога (4px от верха контейнера)
  let cur = 'contacts'
  for (const [id, el] of [['groups', groupsRef.value], ['channels', channelsRef.value]]) {
    const top = el ? sectionTop(el) : null
    if (top !== null && top - root.scrollTop <= 4) cur = id
  }
  activeSec.value = cur
}
function jumpTo(id) {
  const root = rootRef.value
  const el = id === 'groups' ? groupsRef.value : id === 'channels' ? channelsRef.value : null
  if (!root) return
  const top = el ? sectionTop(el) : 0
  root.scrollTo({ top: Math.max(0, top - (id === 'contacts' ? 0 : 2)), behavior: 'smooth' })
  activeSec.value = id
}
// пересчёт активной вкладки при смене состава секций (фильтр поиска и пр.)
let ro = null
onMounted(async () => {
  await nextTick()
  if (rootRef.value && 'ResizeObserver' in window) {
    ro = new ResizeObserver(() => updateActive())
    ro.observe(rootRef.value)
  }
})
onBeforeUnmount(() => ro?.disconnect?.())
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
/* ── Вкладки-якоря секций: липкая полоса под поиском ── */
.list-tabs {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  gap: 4px;
  margin: 0 12px;
  padding: 6px 0;
  background: var(--bg-secondary, #12122a);
  border-bottom: 1px solid var(--border-subtle);
}
.list-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-full, 999px);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  position: relative;
  transition: background var(--transition-fast, .15s), color var(--transition-fast, .15s);
  white-space: nowrap;
  min-width: 0;
}
.list-tab:hover { color: var(--text-primary); background: var(--bg-hover, #26264f); }
.list-tab.active {
  color: var(--accent-primary, #818cf8);
  background: var(--accent-glow, rgba(99, 102, 241, 0.15));
}
.list-tab .tab-count {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-tertiary, #1e1e3a);
  border-radius: 8px;
  padding: 1px 5px;
  min-width: 16px;
  text-align: center;
}
.list-tab.active .tab-count { color: var(--accent-primary, #818cf8); background: var(--accent-glow, rgba(99,102,241,.18)); }
.tab-unread {
  position: absolute;
  top: 3px;
  right: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent-primary, #6366f1);
  box-shadow: 0 0 0 2px var(--bg-secondary, #12122a);
}
.groups-section {
  margin-top: 16px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
/* канал: иконка-аватар по центру круга (наследует .group-avatar из App global) */
:deep(.channel-avatar) {
  display: flex;
  align-items: center;
  justify-content: center;
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
