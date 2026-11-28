<script setup>
import { computed } from 'vue'

const props = defineProps({ state: { type: Object, required: true } })
const isEn = computed(() => props.state.site?.locale === 'en')
const channels = computed(() => props.state.channels?.channels ?? [])
</script>

<template>
  <main class="content-page">
    <div class="container">
      <p><a href="/sfera">Sfera</a></p>
      <h1>{{ isEn ? 'Public channels' : 'Публичные каналы' }}</h1>
      <p class="lead">
        {{ isEn
          ? 'Open pages signed by their authors. No account is required to read them.'
          : 'Открытые страницы, подписанные их авторами. Для чтения аккаунт не нужен.' }}
      </p>
      <div class="cards channel-list">
        <a
          v-for="channel in channels"
          :key="channel.id"
          class="card channel-card"
          :href="`/sfera/channels/${encodeURIComponent(channel.id)}`"
        >
          <h2>{{ channel.title }}</h2>
          <p v-if="channel.description">{{ channel.description }}</p>
          <p class="muted">@{{ channel.id }} · {{ channel.posts }}</p>
        </a>
      </div>
      <p v-if="!channels.length" class="card">
        {{ isEn ? 'There are no public channels yet.' : 'Публичных каналов пока нет.' }}
      </p>
      <p><a class="btn btn-ghost" href="/sfera/docs/public-channels">{{ isEn ? 'How public channels work' : 'Как устроены публичные каналы' }}</a></p>
    </div>
  </main>
</template>

<style scoped>
.channel-list { margin: 24px 0; }
.channel-card { display: block; color: inherit; text-decoration: none; }
.channel-card h2 { margin-top: 0; }
</style>
