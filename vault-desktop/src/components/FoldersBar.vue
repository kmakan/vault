<template>
  <div v-if="folders.length" class="folder-strip">
    <button v-for="f in folders" :key="f" class="folder-chip"
            :class="{ 'folder-chip-on': active === f }"
            @click="$emit('select', active === f ? '' : f)">{{ f }}</button>
  </div>
</template>

<script setup>
// Лента папок чатов (Этап 2 декомпозиции App.vue): презентационный
// компонент — список папок и активная считает родитель
// (features/folders.js), отсюда — только событие выбора (повторный
// тап по активной папке снимает выбор).
defineProps({
  folders: { type: Array, default: () => [] },
  active: { type: String, default: '' },
})

defineEmits(['select'])
</script>

<style scoped>
.folder-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 4px 10px 6px;
  scrollbar-width: thin;
}
.folder-chip {
  flex: 0 0 auto;
  background: rgba(148, 163, 184, 0.08);
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 999px;
  color: inherit;
  font-size: 12.5px;
  padding: 4px 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.folder-chip:hover { background: rgba(245, 158, 11, 0.12); }
.folder-chip-on {
  border-color: #f59e0b;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}
</style>
