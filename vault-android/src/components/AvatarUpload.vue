<template>
  <div class="avatar-upload">
    <h4 class="avatar-upload__title">{{ t('avatar_title') || 'Profile Photo' }}</h4>
    <div class="avatar-upload__preview" @click="triggerUpload">
      <UserAvatar v-if="avatarUrl" :email="email" :avatarUrl="avatarUrl" :size="96" />
      <UserAvatar v-else :email="email" :size="96" :showPattern="true" />
      <div class="avatar-upload__overlay">
        <span class="avatar-upload__camera">📷</span>
      </div>
    </div>
    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/webp"
      class="avatar-upload__input"
      @change="onFileSelected"
    />
    <div class="avatar-upload__actions">
      <button
        v-if="avatarUrl"
        class="avatar-upload__btn avatar-upload__btn--remove"
        @click="removeAvatar"
      >
        {{ t('avatar_remove') || 'Remove' }}
      </button>
      <span v-if="uploading" class="avatar-upload__status">{{ t('general_loading') || 'Loading...' }}</span>
      <span v-else-if="uploaded" class="avatar-upload__status avatar-upload__status--ok">✓ {{ t('general_success') || 'Saved' }}</span>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from 'vue'
import UserAvatar from './UserAvatar.vue'
import { useI18n } from '../i18n.js'
import api from '../api.js'

const { t } = useI18n()

const props = defineProps({
  email: { type: String, required: true },
  avatarUrl: { type: String, default: '' },
})

const emit = defineEmits(['update'])

const fileInput = ref(null)
const uploading = ref(false)
const uploaded = ref(false)

function triggerUpload() {
  fileInput.value?.click()
}

async function onFileSelected(e) {
  const file = e.target.files?.[0]
  if (!file) return

  // Validate size (max 500KB)
  if (file.size > 500 * 1024) {
    alert(t('avatar_too_large') || 'Image must be under 500KB')
    return
  }

  uploading.value = true
  uploaded.value = false

  const reader = new FileReader()
  reader.onload = () => {
    // Resize to 256x256
    const img = new Image()
    img.onload = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      const ctx = canvas.getContext('2d')
      // Center crop
      const size = Math.min(img.width, img.height)
      const sx = (img.width - size) / 2
      const sy = (img.height - size) / 2
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 256, 256)
      const dataUrl = canvas.toDataURL('image/png')
      
      // Save to sqlite kv_store (данные Vault — не localStorage)
      await api.setAvatar(props.email, dataUrl)
      
      // Sync to backend
      try {
        await api.uploadAvatar(props.email, dataUrl)
      } catch (err) {
        console.warn('Avatar sync to server failed:', err)
      }
      
      uploading.value = false
      uploaded.value = true
      emit('update', dataUrl)
      
      setTimeout(() => { uploaded.value = false }, 2000)
    }
    img.src = reader.result
  }
  reader.readAsDataURL(file)
}

async function removeAvatar() {
  await api.removeAvatar(props.email)
  try {
    await api.deleteAvatar(props.email)
  } catch (err) {
    console.warn('Avatar delete on server failed:', err)
  }
  emit('update', '')
}
</script>

<style scoped>
.avatar-upload {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
}

.avatar-upload__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #e0e0e0);
}

.avatar-upload__preview {
  position: relative;
  cursor: pointer;
  border-radius: 50%;
  overflow: hidden;
}

.avatar-upload__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.2s;
}

.avatar-upload__preview:hover .avatar-upload__overlay {
  opacity: 1;
}

.avatar-upload__camera {
  font-size: 24px;
}

.avatar-upload__input {
  display: none;
}

.avatar-upload__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar-upload__btn {
  padding: 6px 12px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.avatar-upload__btn--remove {
  background: var(--danger-color, #ef4444);
  color: white;
}

.avatar-upload__btn--remove:hover {
  background: var(--danger-hover, #dc2626);
}

.avatar-upload__status {
  font-size: 12px;
  color: var(--text-secondary, #9ca3af);
}

.avatar-upload__status--ok {
  color: var(--success-color, #22c55e);
}
</style>
