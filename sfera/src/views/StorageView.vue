<script setup>
// Хранилище: возможности провайдера приходят из `social_store_caps`.
// Медиа лежит у пользователя; приложение показывает только факты.
const props = defineProps({ state: Object, api: Object });

// Локальный диск не имеет квоты и отдаёт u64::MAX — это «без ограничения»,
// а не число мегабайт. Квоты облачных провайдеров приходят реальными.
function quota(bytes) {
  if (!bytes || bytes >= Number.MAX_SAFE_INTEGER) return props.api.t('storage_unlimited');
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${Math.round(gb)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>{{ api.t('nav_storage') }}</h1>
    </header>

    <p v-if="state.error" class="error">{{ state.error }}</p>

    <div v-if="!state.caps" class="empty">{{ api.t('storage_none') }}</div>

    <div v-else class="card">
      <div class="row">
        <span class="muted">{{ api.t('storage_device') }}</span>
        <span>{{ state.caps.kind }}</span>
      </div>
      <div class="row">
        <span class="muted">{{ api.t('storage_quota') }}</span>
        <span>{{ quota(state.caps.max_file_bytes) }}</span>
      </div>
      <div class="row">
        <span class="muted">{{ api.t('storage_health') }}</span>
        <span class="chips">
          <span class="chip" :class="{ on: state.caps.range }">Range</span>
          <span class="chip" :class="{ on: state.caps.public_link }">
            {{ api.t('storage_public_link') }}
          </span>
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.row:last-child {
  border-bottom: 0;
}
.chips {
  display: flex;
  gap: 6px;
}
</style>
