<script setup>
// Лента: только отрисовка записей, которые собрал `social-feed`.
import { computed, ref, watch } from 'vue';
import PostDiscussion from '../components/PostDiscussion.vue';

const props = defineProps({ state: Object, api: Object });

const kinds = ref({});
const mediaStatus = ref('');
// Фильтр по сфере — локальное состояние экрана; какие сферы есть, знает Rust.
const filter = ref('all');

// Плашка «обновлено / в очереди». Без транспорта не обещаем доставку.
const syncText = computed(() => {
  const status = props.state.sync;
  const at = props.state.lastSyncAt
    ? new Date(props.state.lastSyncAt * 1000).toLocaleTimeString()
    : '—';
  if (!status) return props.api.t('feed_sync_unknown', { at });
  if (!status.has_transport) {
    return props.api.t('feed_sync_no_transport', { at, n: status.pending });
  }
  return props.api.t('feed_sync_queued', { at, n: status.pending });
});

const visible = computed(() => {
  const feed = props.state.feed ?? [];
  if (filter.value === 'all') return feed;
  if (filter.value === 'mine') return feed.filter((e) => e.is_mine === true);
  return feed.filter(
    (e) => e.audience_view?.kind === 'sphere' && e.audience_view.id === filter.value,
  );
});

// Структуру аудитории разобрал Rust (`audience_view`), здесь только подпись.
function audienceLabel(entry) {
  const view = entry.audience_view;
  if (!view) return '';
  switch (view.kind) {
    case 'all':
      return props.api.t('feed_audience_all');
    case 'sphere':
      return props.api.t('feed_audience_sphere', { id: view.id });
    case 'selected':
      return props.api.t('feed_audience_selected', { n: view.count });
    case 'except':
      return props.api.t('feed_audience_except', { n: view.count });
    default:
      return '';
  }
}

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
      <span class="badge">{{ visible.length }}</span>
    </header>

    <p class="muted sync">{{ syncText }}</p>

    <div v-if="state.audiences.length" class="filters">
      <button type="button" class="chip-btn" :class="{ on: filter === 'all' }"
              @click="filter = 'all'">{{ api.t('feed_filter_all') }}</button>
      <button type="button" class="chip-btn" :class="{ on: filter === 'mine' }"
              @click="filter = 'mine'">{{ api.t('feed_filter_mine') }}</button>
      <button v-for="a in state.audiences" :key="a.id" type="button" class="chip-btn"
              :class="{ on: filter === a.id }" @click="filter = a.id">{{ a.id }}</button>
    </div>

    <p v-if="state.error" class="error">{{ state.error }}</p>
    <p v-if="mediaStatus" class="error">{{ mediaStatus }}</p>

    <div v-if="!visible.length" class="empty">{{ api.t('feed_empty') }}</div>

    <article v-for="entry in visible" :key="entry.id" class="card post">
      <div class="post-head">
        <span class="fp">{{ entry.post?.post?.author?.fp }}</span>
        <span class="muted audience">{{ audienceLabel(entry) }}</span>
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
      <PostDiscussion :post="entry" :state="state" :api="api" />
    </article>
  </section>
</template>

<style scoped>
.sync {
  margin: 0 0 10px;
  font-size: 12px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.chip-btn {
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-primary);
  border-radius: 999px;
  padding: 4px 12px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.chip-btn.on {
  border-color: var(--accent-primary);
  background: var(--bg-secondary);
}
.post-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px 12px;
}
.post-head .audience { margin-right: auto; }
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
