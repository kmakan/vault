<template>
  <div class="icon-picker">
    <label class="icon-label">{{ t('app_icon') || 'App Icon' }}</label>
    <div class="icon-grid">
      <button
        v-for="icon in icons"
        :key="icon.id"
        :class="['icon-card', { active: currentIcon === icon.id }]"
        @click="selectIcon(icon.id)"
        :title="icon.name"
      >
        <img :src="icon.src" :alt="icon.name" class="icon-preview" />
        <span class="icon-name">{{ icon.name }}</span>
        <span v-if="currentIcon === icon.id" class="icon-check">✓</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from '../i18n.js'

const { t } = useI18n()
const currentIcon = ref('letter')
const emit = defineEmits(['icon-changed'])

const icons = [
  { id: 'logo', name: 'Vault', src: '/icons/vault-logo.svg' },
  { id: 'shield', name: 'Shield', src: '/icons/vault-shield.svg' },
  { id: 'door', name: 'Vault Door', src: '/icons/vault-door.svg' },
  { id: 'keyhole', name: 'Keyhole', src: '/icons/vault-keyhole.svg' },
  { id: 'letter', name: 'Vault msg', src: '/icons/vault-letter.svg' },
  { id: 'envelope', name: 'Envelope', src: '/icons/vault-envelope.svg' },
]

onMounted(() => {
  currentIcon.value = localStorage.getItem('vault-icon') || 'letter'
})

function selectIcon(id) {
  currentIcon.value = id
  localStorage.setItem('vault-icon', id)
  // Update favicon
  const link = document.querySelector("link[rel='icon']")
  if (link) {
    const icon = icons.find(i => i.id === id)
    if (icon) link.href = icon.src
  }
  // Notify the app header to swap the visible logo
  emit('icon-changed', id)
  // Also broadcast on a window-level bus so even a detached settings view
  // (or the sidebar header) can react to the change independently.
  window.dispatchEvent(new CustomEvent('vault-icon-changed', { detail: id }))
}
</script>

<style scoped>
.icon-picker {
  margin-bottom: 20px;
}

.icon-label {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.icon-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  /* На узких экранах (Android): сетка не должна вылезать за границы —
     переключаемся на 4 колонки и позволяем перенос. */
  grid-auto-rows: minmax(0, auto);
  min-width: 0;
}

@media (max-width: 400px) {
  .icon-grid {
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .icon-card {
    padding: 8px 4px;
  }
}

.icon-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  background: var(--bg-tertiary, #1a1a3e);
  border: 2px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
}

.icon-card:hover {
  background: var(--bg-hover, #1e1e4a);
  border-color: var(--border-hover, rgba(255,255,255,0.1));
}

.icon-card.active {
  border-color: var(--accent-primary, #6366f1);
  background: var(--accent-glow, rgba(99, 102, 241, 0.15));
}

.icon-preview {
  width: 40px;
  height: 40px;
  border-radius: 8px;
}

.icon-name {
  font-size: 10px;
  color: var(--text-secondary, #94a3b8);
}

.icon-card.active .icon-name {
  color: var(--text-primary, #f1f5f9);
  font-weight: 500;
}

.icon-check {
  position: absolute;
  top: 4px;
  right: 6px;
  font-size: 12px;
  color: var(--accent-primary, #6366f1);
  font-weight: 700;
}
</style>
