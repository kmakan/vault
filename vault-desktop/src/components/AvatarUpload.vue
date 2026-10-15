<template>
  <div class="avatar-upload">
    <h4 class="avatar-upload__title">{{ t('avatar_title') || 'Profile Photo' }}</h4>
    <div class="avatar-upload__preview" @click="triggerUpload">
      <UserAvatar v-if="avatarUrl" :email="email" :avatarUrl="avatarUrl" :size="96" />
      <UserAvatar v-else :email="email" :size="96" :showPattern="true" />
      <div class="avatar-upload__overlay">
        <span class="avatar-upload__camera"><Icon name="camera" :size="24" /></span>
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
import Icon from './Icon.vue'
import { useI18n } from '../i18n.js'
import api from '../api.js'
import * as AvatarImage from '../avatar-image.js'

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

  // Предел 500КБ — тот же, что у аватара группы (ADR-003 партия 12).
  if (AvatarImage.avatarTooBig(file.size)) {
    alert(t('avatar_too_large') || 'Image must be under 500KB')
    return
  }

  uploading.value = true
  uploaded.value = false

  try {
    // Пресет другой намеренно: профиль 256×256 PNG (резче и без артефактов на
    // JPEG), группа 128×128 JPEG (рассылается в конвертах).
    const dataUrl = await AvatarImage.fileToAvatarDataUrl(file, AvatarImage.PROFILE_AVATAR)

    // Save to sqlite kv_store (данные Vault — не localStorage)
    await api.setAvatar(props.email, dataUrl)

    // Sync to backend
    try {
      await api.uploadAvatar(props.email, dataUrl)
    } catch (err) {
      console.warn('Avatar sync to server failed:', err)
    }

    uploaded.value = true
    emit('update', dataUrl)

    setTimeout(() => { uploaded.value = false }, 2000)
  } catch (err) {
    // Раньше промес зависал навсегда: img.onload при битом файле не наступает,
    // а обработчика отказа не было — колёсико «загрузка» крутилось бы вечно и
    // никто об этом не узнал бы.
    console.warn('Avatar image failed:', err && err.message || err)
    alert(t('err_image_decode') || 'Could not read the image')
  } finally {
    uploading.value = false
  }
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
