<script setup>
// Публичные каналы: список и лента приходят из Rust (social-public),
// UI не проверяет подписи и не решает права.
import { computed, onMounted, ref } from 'vue';

const props = defineProps({ state: Object, api: Object });

const selected = ref('');
const channelId = ref('');
const channelTitle = ref('');
const channelDescription = ref('');
const postBody = ref('');
const busy = ref(false);

const channels = computed(() => props.state.publicChannels ?? []);
const current = computed(() => props.state.publicChannelViews?.[selected.value] ?? null);

onMounted(async () => {
  await props.api.loadPublicChannels();
});

async function openChannel(id) {
  selected.value = id;
  await props.api.loadPublicChannel(id);
}

async function createChannel() {
  if (busy.value) return;
  busy.value = true;
  try {
    const created = await props.api.createPublicChannel(
      channelId.value.trim(), channelTitle.value.trim(), channelDescription.value.trim(),
    );
    channelId.value = '';
    channelTitle.value = '';
    channelDescription.value = '';
    await openChannel(created.id);
  } catch (error) {
    props.state.error = String(error?.message ?? error);
  } finally {
    busy.value = false;
  }
}

async function publish() {
  if (busy.value || !selected.value) return;
  busy.value = true;
  try {
    await props.api.publishPublicPost(selected.value, postBody.value);
    postBody.value = '';
  } catch (error) {
    props.state.error = String(error?.message ?? error);
  } finally {
    busy.value = false;
  }
}

function when(ts) {
  return ts ? new Date(ts * 1000).toLocaleString() : '—';
}
</script>

<template>
  <section class="view channels-view">
    <h2>{{ api.t('channels_title') }}</h2>
    <p class="muted">{{ api.t('channels_hint') }}</p>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>

    <div class="channel-layout">
      <div class="channel-list">
        <button
          v-for="channel in channels"
          :key="channel.id"
          type="button"
          class="card channel-card"
          :class="{ active: selected === channel.id }"
          @click="openChannel(channel.id)"
        >
          <strong>{{ channel.title }}</strong>
          <span class="muted">@{{ channel.id }} · {{ channel.posts }}</span>
        </button>
        <p v-if="!channels.length" class="muted">{{ api.t('channels_empty') }}</p>

        <form class="card channel-form" @submit.prevent="createChannel">
          <h3>{{ api.t('channels_create') }}</h3>
          <input v-model="channelId" :placeholder="api.t('channels_id')" required />
          <input v-model="channelTitle" :placeholder="api.t('channels_name')" required />
          <textarea v-model="channelDescription" :placeholder="api.t('channels_description')" rows="2" />
          <button type="submit" class="primary" :disabled="busy">{{ api.t('channels_create') }}</button>
        </form>
      </div>

      <div v-if="current" class="channel-feed">
        <h3>{{ current.channel.title }}</h3>
        <p v-if="current.channel.description" class="muted">{{ current.channel.description }}</p>
        <article v-for="post in current.posts" :key="post.id" class="card post">
          <time class="muted">{{ when(post.ts) }}</time>
          <p class="post-body">{{ post.body }}</p>
        </article>
        <p v-if="!current.posts.length" class="muted">{{ api.t('channels_no_posts') }}</p>

        <form class="card channel-form" @submit.prevent="publish">
          <textarea v-model="postBody" :placeholder="api.t('channels_post_placeholder')" rows="3" required />
          <button type="submit" class="primary" :disabled="busy">{{ api.t('channels_publish') }}</button>
        </form>
      </div>
    </div>
  </section>
</template>

<style scoped>
.channel-layout {
  display: grid;
  grid-template-columns: minmax(200px, 280px) 1fr;
  gap: 16px;
}
.channel-list { display: flex; flex-direction: column; gap: 8px; }
.channel-card {
  text-align: left;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.channel-card.active { border-color: var(--accent-primary); }
.channel-form { display: flex; flex-direction: column; gap: 8px; }
.channel-form input, .channel-form textarea {
  width: 100%;
  box-sizing: border-box;
}
.channel-feed { display: flex; flex-direction: column; gap: 10px; }
.post-body { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .channel-layout { grid-template-columns: 1fr; }
}
</style>
