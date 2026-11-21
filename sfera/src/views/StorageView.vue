<script setup>
// Хранилище: возможности провайдера приходят из `social_store_caps`.
// Файл шифруется в Rust до записи; UI не видит ключ и не знает формата блоба.
import { ref } from 'vue';

const props = defineProps({ state: Object, api: Object });
const fileInput = ref(null);
const uploadStatus = ref('');
const busy = ref(false);

async function onFile(event) {
  const file = event.target.files?.[0];
  if (!file || busy.value) return;
  busy.value = true;
  uploadStatus.value = '';
  try {
    const result = await props.api.uploadFile(file);
    uploadStatus.value = props.api.t('storage_uploaded', {
      name: file.name, kind: result.kind, size: result.size,
    });
  } catch (e) {
    uploadStatus.value = props.api.t('storage_upload_fail') + ': ' + (e?.message ?? e);
  } finally {
    busy.value = false;
    if (fileInput.value) fileInput.value.value = '';
  }
}

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

    <div class="card upload">
      <h2>{{ api.t('storage_upload_title') }}</h2>
      <input ref="fileInput" type="file" class="file-input" @change="onFile" />
      <p v-if="uploadStatus" class="muted">{{ uploadStatus }}</p>
    </div>

    <div class="card gallery">
      <h2>{{ api.t('storage_gallery') }}</h2>
      <p v-if="!state.library?.length" class="muted">{{ api.t('storage_gallery_empty') }}</p>
      <div v-else class="gallery-grid">
        <article v-for="item in state.library" :key="item.blob_id" class="tile">
          <span class="tile-kind">{{ item.kind }}</span>
          <span class="fp">{{ item.blob_id.slice(0, 12) }}…</span>
          <span class="muted">{{ item.size }} B</span>
          <button class="tile-remove" :aria-label="api.t('storage_forget')"
                  @click="api.forgetFile(item.blob_id)">×</button>
        </article>
      </div>
    </div>

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

.upload { margin-bottom: 12px; }
.upload h2 { font-size: 15px; margin: 0 0 8px; }
.file-input { max-width: 100%; font: inherit; font-size: 12px; }

.gallery { margin-bottom: 12px; }
.gallery h2 { font-size: 15px; margin: 0 0 10px; }
.gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; }
.tile { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 10px; border-radius: var(--radius-md); background: var(--bg-secondary); font-size: 11px; }
.tile-kind { color: var(--accent-secondary); font-weight: 600; }
.tile-remove { position: absolute; top: 4px; right: 6px; border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 16px; }
</style>
