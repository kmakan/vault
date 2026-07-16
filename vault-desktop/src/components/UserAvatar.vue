<template>
  <div
    class="user-avatar"
    :style="{
      width: size + 'px',
      height: size + 'px',
      backgroundColor: bgColor,
      fontSize: (size * 0.4) + 'px',
    }"
    :title="email"
  >
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
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  email: { type: String, required: true },
  size: { type: Number, default: 40 },
  showPattern: { type: Boolean, default: false },
})

// Deterministic hash from email
function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash)
}

// Color palette (vibrant, accessible on dark/light)
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

// Generate 5x5 identicon pattern (mirror left half)
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
        // Mirror to right side
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
