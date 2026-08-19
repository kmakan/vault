<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :class="['vault-icon', cls]"
    aria-hidden="true"
  >
    <g
      :stroke="strokeColor"
      :stroke-width="strokeWidth"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <template v-for="(p, i) in paths" :key="i">
        <path v-if="p.type === 'path'" :d="p.d" />
        <circle v-else-if="p.type === 'circle'" :cx="p.cx" :cy="p.cy" :r="p.r" />
        <rect v-else-if="p.type === 'rect'" :x="p.x" :y="p.y" :width="p.w" :height="p.h" :rx="p.rx" />
        <line v-else-if="p.type === 'line'" :x1="p.x1" :y1="p.y1" :x2="p.x2" :y2="p.y2" />
      </template>
    </g>
  </svg>
</template>

<script setup>
import { computed } from 'vue';
import { icons } from '../icons.js';

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 18 },
  // Единый цвет иконок Vault (решение 19.08: все функциональные иконки —
  // одним фиолетовым; градиент на мелких глифах не читается).
  color: { type: String, default: '#8b5cf6' },
  // Толщина линий: единая 2.25; шестерёнка (settings) — 2.0, её огромный
  // путь при большей толщине слипается (замечание пользователя 19.08).
  cls: { type: String, default: '' },
});

const paths = computed(() => icons[props.name] || []);
const strokeColor = props.color;
const strokeWidth = props.name === 'settings' ? 2 : 2.25;
</script>