<script setup>
// Только экран действий. Подпись, ID, версии, права и целевая аудитория —
// протокол Rust. Сводка реакций готовится в `social_discussion`, не здесь.
import { computed, ref } from 'vue';

const props = defineProps({ post: Object, state: Object, api: Object });
const body = ref('');
const parentId = ref(null);
const busy = ref(false);
const error = ref('');
const discussion = computed(() => props.state.discussions?.[props.post.id] ?? { comments: [], reactions: [] });
const comments = computed(() => discussion.value.comments ?? []);
const reactions = computed(() => discussion.value.reactions ?? []);

function name(fp) {
  return props.state.profiles?.[fp]?.profile?.display_name || `${fp.slice(0, 12)}…`;
}
function hasReacted(reaction) {
  return reaction.authors?.includes(props.state.identity?.fp);
}
async function react(reaction) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await props.api.reactToPost(props.post.id, reaction.emoji, hasReacted(reaction));
  } catch (e) {
    error.value = String(e?.message ?? e);
  } finally {
    busy.value = false;
  }
}
async function send() {
  if (!body.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await props.api.commentOnPost(props.post.id, body.value, parentId.value);
    body.value = '';
    parentId.value = null;
  } catch (e) {
    error.value = String(e?.message ?? e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="discussion">
    <div class="reaction-row">
      <button v-for="reaction in reactions" :key="reaction.emoji" type="button"
              class="reaction" :class="{ mine: hasReacted(reaction) }"
              :aria-label="`${api.t('reactions')}: ${reaction.emoji}`"
              :disabled="busy" @click="react(reaction)">
        {{ reaction.emoji }} <span>{{ reaction.count }}</span>
      </button>
      <button v-if="!reactions.length" type="button" class="reaction" :disabled="busy"
              @click="react({ emoji: '❤️', authors: [] })">❤️</button>
      <span class="muted">{{ comments.length }} {{ api.t('comments').toLowerCase() }}</span>
    </div>
    <div v-if="comments.length" class="comment-list">
      <div v-for="item in comments" :key="item.comment.id" class="comment"
           :class="{ reply: item.comment.parent_id }">
        <span class="fp">{{ name(item.comment.author.fp) }}</span>
        <span>{{ item.comment.body }}</span>
        <button type="button" class="reply-btn" @click="parentId = item.comment.id">
          {{ api.t('reply') }}
        </button>
      </div>
    </div>
    <p v-else class="muted comment-empty">{{ api.t('commentEmpty') }}</p>
    <form class="comment-form" @submit.prevent="send">
      <input v-model="body" :placeholder="api.t('commentPlaceholder')" maxlength="4000" />
      <button class="btn btn--sm" type="submit" :disabled="busy || !body.trim()">
        {{ api.t(parentId ? 'reply' : 'addComment') }}
      </button>
    </form>
    <p class="muted hint">{{ api.t('commentHint') }}</p>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<style scoped>
.discussion { margin-top: 12px; border-top: 1px solid var(--border-subtle); padding-top: 10px; }
.reaction-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.reaction { border: 1px solid var(--border-subtle); background: transparent; color: var(--text-primary); border-radius: 999px; padding: 4px 10px; cursor: pointer; }
.reaction.mine { border-color: var(--accent); }
.reaction:disabled { opacity: .5; }
.comment-list { margin-top: 10px; display: grid; gap: 8px; }
.comment { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.comment.reply { margin-left: 20px; }
.fp { color: var(--text-secondary); font-size: 12px; }
.reply-btn { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font-size: 12px; }
.comment-form { display: flex; gap: 8px; margin-top: 10px; }
.comment-form input { min-width: 0; flex: 1; }
.hint, .comment-empty { font-size: 12px; }
</style>
