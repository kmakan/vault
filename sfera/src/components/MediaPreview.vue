<script setup>
// Просмотр медиа поверх любого экрана: лента и хранилище открывают файл
// одним и тем же вызовом. Расшифровка — в Rust; здесь только показ.
defineProps({ state: Object, api: Object });
</script>

<template>
  <div v-if="state.preview" class="overlay" @click.self="api.closePreview()">
    <div class="panel" role="dialog" aria-modal="true">
      <div class="head">
        <h2>{{ api.t('storage_preview_title') }}</h2>
        <button type="button" class="close" :aria-label="api.t('storage_preview_close')"
                @click="api.closePreview()">×</button>
      </div>
      <img v-if="state.previewUrl" class="image" :src="state.previewUrl"
           :alt="api.t('storage_preview_title')" />
      <p v-else class="muted">{{ api.t('storage_preview_no_image') }}</p>
      <p class="muted meta">{{ state.preview.mime }} · {{ state.preview.size }} B</p>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.55);
}
.panel {
  width: min(760px, 100%);
  max-height: 90vh;
  overflow: auto;
  box-sizing: border-box;
  padding: 16px;
  border-radius: var(--radius-lg);
  background: var(--bg-primary);
  border: 1px solid var(--border-subtle);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.head h2 {
  font-size: 15px;
  margin: 0;
}
.close {
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
}
.image {
  display: block;
  max-width: 100%;
  max-height: 70vh;
  margin: 12px auto 0;
  border-radius: var(--radius-md);
  object-fit: contain;
}
.meta {
  margin: 10px 0 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}
</style>
