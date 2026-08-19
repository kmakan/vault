<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    :class="['vault-icon', cls]"
    aria-hidden="true"
  >
    <defs v-if="gradient">
      <linearGradient :id="gradId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#818cf8" />
        <stop offset="100%" stop-color="#c084fc" />
      </linearGradient>
    </defs>
    <g
      :stroke="gradient ? `url(#${gradId})` : 'currentColor'"
      stroke-width="2"
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
  gradient: { type: Boolean, default: false },
  cls: { type: String, default: '' },
});

const paths = computed(() => icons[props.name] || []);
const gradId = 'vault-icon-grad-' + props.name;
</script>
