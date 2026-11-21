<script setup>
// Лента: только отрисовка записей, которые собрал `social-feed`.
defineProps({ state: Object, api: Object });

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

    <div v-if="!state.feed.length" class="empty">{{ api.t('feed_empty') }}</div>

    <article v-for="entry in state.feed" :key="entry.id" class="card post">
      <div class="post-head">
        <span class="fp">{{ entry.post?.post?.author?.fp }}</span>
        <time class="muted">{{ when(entry.post?.post?.ts) }}</time>
      </div>
      <p class="post-body">{{ entry.post?.post?.body }}</p>
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
</style>
