<template>
  <div class="group-settings" v-if="group">
    <div class="group-settings__header">
      <h3>{{ t('group_settings') || 'Group Settings' }}</h3>
      <button class="btn-icon" @click="$emit('close')">✕</button>
    </div>

    <!-- Group Avatar + Info. Загрузка аватара — только админам группы. -->
    <div class="group-settings__info">
      <div class="group-settings__avatar-row">
        <div class="group-avatar-preview" :class="{ clickable: isAdmin }" @click="isAdmin && triggerGroupAvatar()">
          <UserAvatar
            :email="group.id || group.name"
            :avatarUrl="groupAvatarUrl"
            :size="64"
            :showPattern="true"
          />
          <div class="group-avatar-overlay" v-if="isAdmin">
            <span>📷</span>
          </div>
        </div>
        <input
          v-if="isAdmin"
          ref="groupAvatarInput"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          class="group-avatar-input"
          @change="onGroupAvatarSelected"
        />
        <div class="group-settings__name">
          <span class="group-name">{{ group.name }}</span>
          <span class="group-id">ID: {{ group.id }}</span>
          <div class="group-settings__meta">
            {{ group.members.length }} {{ t('members') || 'members' }}
            <span v-if="group.blocked?.length"> · {{ group.blocked.length }} {{ t('blocked') || 'blocked' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Add Member — только для админов (создатель или назначенный) -->
    <div class="group-settings__section" v-if="isAdmin">
      <h4>{{ t('add_member') }}</h4>
      <div class="add-member-row">
        <button class="btn btn-primary add-member-btn" @click="addMember">
          {{ t('add_member') }}
        </button>
      </div>
    </div>

    <!-- Members List -->
    <div class="group-settings__section">
      <h4>{{ t('members') || 'Members' }}</h4>
      <div class="member-list">
        <div
          v-for="member in group.members"
          :key="member.email"
          class="member-item"
        >
          <UserAvatar :email="member.email" :size="32" />
          <div class="member-item__info">
            <span class="member-item__email">{{ memberName(member.email) }}</span>
            <span v-if="member.invited" class="member-item__invited">{{ t('invite_pending') }}</span>
            <span class="member-item__role" :class="'role--' + (member.role || 'Member').toLowerCase()">
              {{ member.role }}
            </span>
          </div>
          <div class="member-item__actions" v-if="canRemove(member)">
            <select
              v-if="isAdmin"
              :value="member.role || 'Member'"
              @change="$emit('role-change', member.email, $event.target.value)"
              class="role-select"
              :disabled="member.email === group.created_by"
            >
              <option value="Admin">{{ t('role_admin') }}</option>
              <option value="Member">{{ t('role_member') }}</option>
            </select>
            <button
              class="btn-sm btn-danger"
              @click="$emit('remove', member.email)"
              :title="t('remove_member') || 'Remove from group'"
            >✕</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Blocked Users -->
    <div class="group-settings__section" v-if="group.blocked?.length">
      <h4>{{ t('blocked_users') || 'Blocked Users' }}</h4>
      <div class="member-list">
        <div
          v-for="email in group.blocked"
          :key="email"
          class="member-item member-item--blocked"
        >
          <UserAvatar :email="email" :size="32" />
          <span class="member-item__email">{{ email }}</span>
          <div class="member-item__actions" v-if="isAdmin">
            <button
              class="btn-sm btn-success"
              @click="$emit('unblock', email)"
              :title="t('unblock') || 'Unblock user'"
            >✓</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="group-settings__actions">
      <button
        v-if="!isCreator"
        class="btn btn-warning"
        @click="$emit('leave')"
      >{{ t('leave_group') || 'Leave Group' }}</button>
      <button
        v-if="isCreator"
        class="btn btn-danger"
        @click="$emit('delete')"
      >{{ t('delete_group') || 'Delete Group' }}</button>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { useI18n } from '../i18n.js'
import UserAvatar from './UserAvatar.vue'
import api from '../api.js'

const { t } = useI18n()

const props = defineProps({
  group: { type: Object, required: true },
  currentUser: { type: String, required: true },
  profiles: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['close', 'promote', 'demote', 'remove', 'block', 'unblock', 'leave', 'delete', 'avatar-update', 'add-member', 'role-change'])

function addMember() {
  // Открываем попап выбора контактов (основной UX добавления участника).
  emit('add-member')
}

// Имя участника из профиля (если есть), иначе email.
function memberName(email) {
  const p = props.profiles && props.profiles[email]
  return (p && p.name) || email
}

const isAdmin = computed(() => {
  const member = props.group.members?.find(m => m.email === props.currentUser)
  return member?.role === 'Admin' || props.group.created_by === props.currentUser
})

// Кого текущий пользователь имеет право удалить:
// - только админы удаляют участников;
// - создателя не удаляет никто (он может только выйти сам);
// - себя через «Покинуть группу».
function canRemove(member) {
  if (!props.group) return false
  if (!isAdmin.value) return false
  if (member.email === props.group.created_by) return false
  if (member.email === props.currentUser) return false
  return true
}

const isCreator = computed(() => props.group.created_by === props.currentUser)

// Group avatar
const groupAvatarInput = ref(null)
const groupAvatarUrl = ref('')

onMounted(() => {
  const stored = localStorage.getItem(`vault-group-avatar-${props.group.id}`)
  if (stored) groupAvatarUrl.value = stored
})

function triggerGroupAvatar() {
  groupAvatarInput.value?.click()
}

async function onGroupAvatarSelected(e) {
  const file = e.target.files?.[0]
  if (!file) return
  if (file.size > 500 * 1024) {
    alert(t('avatar_too_large') || 'Image must be under 500KB')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const img = new Image()
    img.onload = async () => {
      // Аватар группы рассылается участникам письмами (под шифром), поэтому
      // сжимаем до 128×128 JPEG — достаточно для UI и мало весит в конверте.
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 128
      const ctx = canvas.getContext('2d')
      const size = Math.min(img.width, img.height)
      const sx = (img.width - size) / 2
      const sy = (img.height - size) / 2
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8)
      localStorage.setItem(`vault-group-avatar-${props.group.id}`, dataUrl)
      groupAvatarUrl.value = dataUrl
      // Sync to backend
      try {
        await api.uploadGroupAvatar(props.group.id, dataUrl)
      } catch (err) {
        console.warn('Group avatar sync to server failed:', err)
      }
      emit('avatar-update', { groupId: props.group.id, avatar: dataUrl })
    }
    img.src = reader.result
  }
  reader.readAsDataURL(file)
}
</script>

<style scoped>
.group-settings {
  padding: 16px;
  background: var(--bg-secondary, #1a1a2e);
  border-radius: 12px;
  border: 1px solid var(--border-color, #333);
}

.group-settings__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.group-settings__header h3 {
  margin: 0;
  color: var(--text-primary, #fff);
  font-size: 16px;
}

.group-settings__info {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-color, #333);
}

.group-settings__name {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.group-name {
  font-weight: 600;
  color: var(--text-primary, #fff);
  font-size: 14px;
}

.group-id {
  font-size: 11px;
  color: var(--text-muted, #888);
  font-family: monospace;
}

.group-settings__meta {
  font-size: 12px;
  color: var(--text-secondary, #aaa);
  margin-top: 4px;
}

.group-settings__section {
  margin-bottom: 16px;
}

.group-settings__section h4 {
  margin: 0 0 8px 0;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--text-muted, #888);
  letter-spacing: 0.5px;
}

.add-member-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.add-member-input {
  flex: 1;
  min-width: 0;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #333);
  background: var(--bg-primary, #0d0d1a);
  color: var(--text-primary, #fff);
  font-size: 13px;
}

.role-select {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #333);
  background: var(--bg-primary, #0d0d1a);
  color: var(--text-primary, #fff);
  font-size: 12px;
  cursor: pointer;
}

.role-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.add-member-btn {
  flex-shrink: 0;
}

.member-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.member-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 8px;
  background: var(--bg-primary, #0d0d1a);
}

.member-item--blocked {
  opacity: 0.6;
}

.member-item__info {
  flex: 1;
  min-width: 0;
}

.member-item__email {
  display: block;
  font-size: 13px;
  color: var(--text-primary, #fff);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-item__invited {
  display: inline-block;
  margin-left: 6px;
  font-size: 11px;
  color: var(--accent-primary, #00d4aa);
  text-transform: none;
  letter-spacing: 0.2px;
}

.member-item__role {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.role--admin {
  color: var(--accent-primary, #00d4aa);
}

.role--member {
  color: var(--text-muted, #888);
}

.member-item__actions {
  display: flex;
  gap: 4px;
}

.btn-sm {
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}

.btn-success {
  background: var(--success, #4caf50);
  color: white;
}

.btn-warning {
  background: var(--warning, #ff9800);
  color: white;
}

.btn-danger {
  background: var(--danger, #f44336);
  color: white;
}

.group-settings__actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color, #333);
}

.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
}

.btn-icon {
  background: none;
  border: none;
  color: var(--text-muted, #888);
  cursor: pointer;
  font-size: 18px;
  padding: 4px;
}

.btn-icon:hover {
  color: var(--text-primary, #fff);
}

/* Group avatar */
.group-settings__avatar-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.group-avatar-preview {
  position: relative;
  cursor: default;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
}

/* Только админы могут менять аватар — курсор-подсказка */
.group-avatar-preview.clickable {
  cursor: pointer;
}

.group-avatar-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.2s;
  font-size: 20px;
}

.group-avatar-preview:hover .group-avatar-overlay {
  opacity: 1;
}

.group-avatar-input {
  display: none;
}
</style>
