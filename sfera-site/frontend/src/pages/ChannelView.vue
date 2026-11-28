<script setup>
import { computed } from 'vue'

const props = defineProps({ state: { type: Object, required: true } })
const isEn = computed(() => props.state.site?.locale === 'en')
const channel = computed(() => props.state.channel?.channel ?? {})
const posts = computed(() => props.state.channel?.posts ?? [])

function when(ts) {
  if (!ts) return ''
  return new Intl.DateTimeFormat(isEn.value ? 'en' : 'ru', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ts * 1000))
}
</script>

<template>
  <main class="content-page">
    <div class="container">
      <p><a href="/sfera/channels">{{ isEn ? 'Public channels' : 'Публичные каналы' }}</a></p>
      <h1>{{ channel.title }}</h1>
      <p v-if="channel.description" class="lead">{{ channel.description }}</p>
      <p class="muted">@{{ channel.id }}</p>

      <section class="channel-feed" aria-label="Posts">
        <article v-for="post in posts" :key="post.id" class="card public-post">
          <time class="muted" :datetime="new Date(post.ts * 1000).toISOString()">{{ when(post.ts) }}</time>
          <p class="post-body">{{ post.body }}</p>
        </article>
        <p v-if="!posts.length" class="card">
          {{ isEn ? 'There are no posts in this channel yet.' : 'В этом канале пока нет постов.' }}
        </p>
      </section>
      <p class="muted signature-note">
        {{ isEn
          ? 'The channel manifest and every post are signed by the author and verified by the public vitrine.'
          : 'Манифест канала и каждый пост подписаны автором и проверены публичной витриной.' }}
      </p>
    </div>
  </main>
</template>

<style scoped>
.channel-feed { display: grid; gap: 16px; margin: 24px 0; }
.public-post { overflow-wrap: anywhere; }
.post-body { white-space: pre-wrap; line-height: 1.65; }
.signature-note { font-size: 0.9rem; }
</style>
