<template>
  <div
    class="user-avatar"
    :style="{
      width: size + 'px',
      height: size + 'px',
      fontSize: (size * 0.4) + 'px',
    }"
    :title="email"
  >
    <!-- Uploaded image -->
    <img
      v-if="resolvedAvatar"
      :src="resolvedAvatar"
      class="user-avatar__image"
      :alt="email"
    />
    <!-- Fallback: initials + color -->
    <template v-else>
      <div class="user-avatar__bg" :style="{ backgroundColor: bgColor }"></div>
      <span class="user-avatar__initials">{{ initials }}</span>
      <svg
        v-if="pattern"
        class="user-avatar__pattern"
        :width="size"
        :height="size"
        viewBox="0 0 100 100"
      >
        <rect
          v-for="(cell, i) in pattern"
          :key="i"
          :x="cell.x"
          :y="cell.y"
          :width="cell.w"
          :height="cell.h"
          :fill="cell.fill"
        />
      </svg>
    </template>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import api from '../api.js'

const props = defineProps({
  email: { type: String, required: true },
  avatarUrl: { type: String, default: '' },
  size: { type: Number, default: 40 },
  showPattern: { type: Boolean, default: false },
})

// Resolve avatar: prop > localStorage > API
const resolvedAvatar = ref('')
// Токен загрузки: при смене email/avatarUrl (переход между чатами) старый
// async-запрос не должен перетереть новый результат (гонка). Каждый вызов
// loadAvatar инкрементирует seq; результат применяется только если seq
// актуален на момент завершения.
let avatarSeq = 0

async function loadAvatar() {
  // Сбрасываем сразу: при переходе на контакт БЕЗ аватара в шапке иначе
  // остаётся аватар предыдущего чата (resolvedAvatar от старого email).
  resolvedAvatar.value = ''
  const seq = ++avatarSeq
  if (props.avatarUrl) {
    resolvedAvatar.value = props.avatarUrl
    return
  }
  // Fast local cache (sqlite kv_store + in-memory Map в api.js)
  const stored = await api.getAvatar(props.email)
  if (seq !== avatarSeq) return // устаревший запрос — email уже сменился
  if (stored) {
    resolvedAvatar.value = stored
    return
  }
  // Backend-аватаров нет (serverless); getAvatar уже кэширует в памяти.
}

onMounted(loadAvatar)
watch(() => props.avatarUrl, loadAvatar)
watch(() => props.email, loadAvatar)

// Deterministic hash from email
function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

const colors = [
  '#E91E63', '#9C27B0', '#673AB7', '#3F51B5',
  '#2196F3', '#00BCD4', '#009688', '#4CAF50',
  '#8BC34A', '#FF9800', '#FF5722', '#795548',
  '#607D8B', '#F44336', '#03A9F4', '#CDDC39',
]

const bgColor = computed(() => {
  const hash = hashString(props.email)
  return colors[hash % colors.length]
})

const initials = computed(() => {
  const parts = props.email.split('@')[0].replace(/[._-]/g, '')
  if (parts.length >= 2) {
    return parts[0].toUpperCase() + parts[1].toUpperCase()
  }
  return parts[0].toUpperCase()
})

const pattern = computed(() => {
  if (!props.showPattern) return null
  const hash = hashString(props.email)
  const cells = []
  const cellSize = 20

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      const bit = (hash >> (row * 5 + col)) & 1
      if (bit) {
        cells.push({
          x: col * cellSize,
          y: row * cellSize,
          w: cellSize,
          h: cellSize,
          fill: 'rgba(255,255,255,0.3)',
        })
        if (col < 2) {
          cells.push({
            x: (4 - col) * cellSize,
            y: row * cellSize,
            w: cellSize,
            h: cellSize,
            fill: 'rgba(255,255,255,0.3)',
          })
        }
      }
    }
  }
  return cells
})
</script>

<style scoped>
.user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: white;
  font-weight: 600;
  font-family: var(--font-family, 'Inter', sans-serif);
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
  user-select: none;
}

.user-avatar__bg {
  position: absolute;
  inset: 0;
  border-radius: 50%;
}

.user-avatar__image {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.user-avatar__initials {
  position: relative;
  z-index: 1;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.user-avatar__pattern {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 0;
}
</style>
