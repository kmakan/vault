<template>
  <div class="app-behavior">
    <label class="behavior-label">{{ t('app_behavior') || 'App Behavior' }}</label>
    
    <div class="behavior-option">
      <div class="behavior-info">
        <div class="behavior-title">{{ t('close_to_tray') || 'Close to Tray' }}</div>
        <div class="behavior-desc">{{ t('close_to_tray_desc') || 'Keep app running in system tray when closing the window' }}</div>
      </div>
      <label class="toggle">
        <input type="checkbox" v-model="closeToTray" @change="saveSetting" />
        <span class="toggle-slider"></span>
      </label>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from '../i18n.js'
import { invoke } from '@tauri-apps/api/core'

const { t } = useI18n()
const closeToTray = ref(false)

onMounted(async () => {
  try {
    closeToTray.value = await invoke('get_close_to_tray')
  } catch {
    closeToTray.value = localStorage.getItem('vault-close-to-tray') === 'true'
  }
})

async function saveSetting() {
  localStorage.setItem('vault-close-to-tray', String(closeToTray.value))
  try {
    await invoke('set_close_to_tray', { enabled: closeToTray.value })
  } catch {
    // Tauri not available (browser dev mode)
  }
}
</script>

<style scoped>
.app-behavior {
  margin-bottom: 20px;
}

.behavior-label {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.behavior-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-tertiary, #1a1a3e);
  border-radius: 10px;
  gap: 12px;
}

.behavior-info {
  flex: 1;
}

.behavior-title {
  font-size: 14px;
  color: var(--text-primary, #f1f5f9);
  font-weight: 500;
  margin-bottom: 2px;
}

.behavior-desc {
  font-size: 12px;
  color: var(--text-secondary, #94a3b8);
}

/* Toggle switch */
.toggle {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}

.toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background: var(--bg-hover, #374151);
  border-radius: 24px;
  transition: 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background: white;
  border-radius: 50%;
  transition: 0.2s;
}

.toggle input:checked + .toggle-slider {
  background: var(--accent-primary, #6366f1);
}

.toggle input:checked + .toggle-slider::before {
  transform: translateX(20px);
}
</style>
