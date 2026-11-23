<script setup>
// Лента: только отрисовка записей, которые собрал `social-feed`.
import { ref, watch } from 'vue';

const props = defineProps({ state: Object, api: Object });

const kinds = ref({});
const mediaStatus = ref('');

// Подписи типов — по ключам локалей; сам тип приходит из Rust.
const KIND_LABEL = {
  Image: 'media_image',
  Audio: 'media_audio',
  Video: 'media_video',
  Document: 'media_document',
};

async function loadKinds(feed) {
  const mimes = new Set();
  for (const entry of feed ?? []) {
    for (const m of entry.post?.post?.media ?? []) mimes.add(m.mime);
  }
  for (const mime of mimes) {
    if (kinds.value[mime]) continue;
    try {
      kinds.value[mime] = await props.api.mediaKind(mime);
    } catch {
      // Тип не угадываем: без ответа Rust останется честный «Файл».
    }
  }
}

watch(() => props.state.feed, loadKinds, { immediate: true });

function kindLabel(mime) {
  const key = KIND_LABEL[kinds.value[mime]];
  return key ? props.api.t(key) : props.api.t('media_document');
}

async function openMedia(m) {
  mediaStatus.value = '';
  try {
    await props.api.openFile(m.blob_id);
  } catch (e) {
    mediaStatus.value = props.api.t('storage_preview_fail') + ': ' + (e?.message ?? e);
  }
}

function when(ts) {
  return ts ? new Date(ts * 1000).toLocaleString() : '';
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>{{ api.t('nav_feed') }}</h1>
      <span class="badge">{{ state.feed.length }}</span>
    </header>

    <p v-if="state.error" class="error">{{ state.error }}</p>
    <p v-if="mediaStatus" class="error">{{ mediaStatus }}</p>

    <div v-if="!state.feed.length" class="empty">{{ api.t('feed_empty') }}</div>

    <article v-for="entry in state.feed" :key="entry.id" class="card post">
      <div class="post-head">
        <span class="fp">{{ entry.post?.post?.author?.fp }}</span>
        <time class="muted">{{ when(entry.post?.post?.ts) }}</time>
      </div>
      <p class="post-body">{{ entry.post?.post?.body }}</p>
      <div v-if="entry.post?.post?.media?.length" class="media-row">
        <button v-for="m in entry.post.post.media" :key="m.blob_id" type="button"
                class="media-btn" @click="openMedia(m)">
          <img v-if="state.thumbs[m.blob_id]" class="media-thumb"
               :src="state.thumbs[m.blob_id]" alt="" />
          <span>{{ kindLabel(m.mime) }} · {{ m.size }} B</span>
        </button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.post-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.post-body {
  margin: 10px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.media-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.media-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.media-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--radius-sm);
}
.media-btn:hover {
  border-color: var(--accent-primary);
}
</style>
