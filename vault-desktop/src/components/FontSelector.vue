<template>
  <div class="font-selector">
    <label class="font-label">{{ t('font') || 'Font' }}</label>
    <div class="font-grid">
      <button
        v-for="(font, id) in fonts"
        :key="id"
        :class="['font-card', { active: currentFont === id, pro: font.pro }]"
        @click="selectFont(id)"
      >
        <span class="font-icon">{{ font.icon }}</span>
        <span class="font-name">{{ font.name }}</span>
        <span v-if="font.pro" class="font-pro-badge">PRO</span>
        <span v-if="currentFont === id" class="font-check">✓</span>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from '../i18n.js'
import { fonts, applyFont, loadSavedFont } from '../fonts.js'

const { t } = useI18n()
const currentFont = ref('system')

onMounted(() => {
  currentFont.value = loadSavedFont()
})

function selectFont(id) {
  currentFont.value = id
  applyFont(id)
}
</script>

<style scoped>
.font-selector {
  margin-bottom: 20px;
}

.font-label {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #64748b);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.font-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.font-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-tertiary, #1a1a3e);
  border: 2px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
}

.font-card:hover {
  background: var(--bg-hover, #1e1e4a);
}

.font-card.active {
  border-color: var(--accent-primary, #6366f1);
  background: var(--accent-glow, rgba(99, 102, 241, 0.15));
}

.font-icon {
  font-size: 16px;
}

.font-name {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary, #94a3b8);
  text-align: left;
}

.font-card.active .font-name {
  color: var(--text-primary, #f1f5f9);
  font-weight: 500;
}

.font-pro-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 2px 5px;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: white;
  border-radius: 4px;
  letter-spacing: 0.5px;
}

.font-check {
  font-size: 12px;
  color: var(--accent-primary, #6366f1);
  font-weight: 700;
}
</style>
