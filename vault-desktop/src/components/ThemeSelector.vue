<template>
  <div class="theme-selector">
    <label class="theme-label">{{ t('theme') || 'Theme' }}</label>
    <div class="theme-grid">
      <button
        v-for="(theme, id) in themes"
        :key="id"
        :class="['theme-card', { active: currentTheme === id }]"
        @click="selectTheme(id)"
      >
        <span class="theme-icon">{{ theme.icon }}</span>
        <span class="theme-name">{{ theme.name }}</span>
        <span v-if="currentTheme === id" class="theme-check">✓</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from '../i18n.js'
import { themes, applyTheme, loadSavedTheme } from '../themes.js'

const { t } = useI18n()
const currentTheme = ref('dark')

onMounted(() => {
  currentTheme.value = loadSavedTheme()
})

function selectTheme(id) {
  currentTheme.value = id
  applyTheme(id)
}
</script>

<style scoped>
.theme-selector {
  margin-bottom: 20px;
}

.theme-label {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.theme-card {
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

.theme-card:hover {
  background: var(--bg-hover, #1e1e4a);
  border-color: var(--border-hover, rgba(255,255,255,0.1));
}

.theme-card.active {
  border-color: var(--accent-primary, #6366f1);
  background: var(--accent-glow, rgba(99, 102, 241, 0.15));
}

.theme-icon {
  font-size: 22px;
}

.theme-name {
  font-size: 11px;
  color: var(--text-secondary, #94a3b8);
}

.theme-card.active .theme-name {
  color: var(--text-primary, #f1f5f9);
  font-weight: 500;
}

.theme-check {
  position: absolute;
  top: 4px;
  right: 6px;
  font-size: 12px;
  color: var(--accent-primary, #6366f1);
  font-weight: 700;
}
</style>
