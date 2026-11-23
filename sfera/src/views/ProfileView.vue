<script setup>
// Профиль: идентичность из Rust, переключение языка и темы. Платные
// возможности и организации появятся здесь же, отдельной вкладки не будет.
import { computed, ref, watch } from 'vue';
import { availableLocales } from '../locales/index.js';
import { THEMES } from '../themes/index.js';

const props = defineProps({ state: Object, api: Object });

const locales = availableLocales();
const themes = Object.keys(THEMES);
const linkUri = ref('');
const name = ref('');
const bio = ref('');
const links = ref([]);
const profileBusy = ref(false);
const profileStatus = ref('');
const avatarInput = ref(null);
const avatarStatus = ref('');
const avatarBusy = ref(false);

// Превью аватара — миниатюра из каталога Rust; сам файл не читается.
const avatarThumb = computed(() => {
  const id = props.state.avatarDraft?.blob_id;
  return id ? props.state.thumbs[id] ?? '' : '';
});

// Стена — свои посты из ленты. Признак «мой» считает Rust (`is_mine`).
const ownPosts = computed(() => (props.state.feed ?? []).filter((e) => e.is_mine === true));

function when(ts) {
  return ts ? new Date(ts * 1000).toLocaleString() : '';
}

function pickAvatar() {
  avatarInput.value?.click();
}

async function onAvatar(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file || avatarBusy.value) return;
  avatarBusy.value = true;
  avatarStatus.value = '';
  try {
    await props.api.uploadAvatar(file);
  } catch (e) {
    avatarStatus.value = props.api.t('profile_avatar_fail') + ': ' + (e?.message ?? e);
  } finally {
    avatarBusy.value = false;
  }
}

// Форма заполняется из подписанного профиля, который пришёл из Rust.
watch(
  () => props.state.myProfile,
  (p) => {
    const profile = p?.profile;
    if (!profile) return;
    name.value = profile.display_name ?? '';
    bio.value = profile.bio ?? '';
    links.value = (profile.links ?? []).map((l) => ({ label: l.label, url: l.url }));
  },
  { immediate: true },
);

function addLink() {
  if (links.value.length >= 8) return;
  links.value.push({ label: '', url: '' });
}

function removeLink(index) {
  links.value.splice(index, 1);
}

async function saveProfile() {
  if (profileBusy.value) return;
  profileBusy.value = true;
  profileStatus.value = '';
  try {
    // Пустые строки ссылок не отправляем: валидация формы — в Rust.
    const clean = links.value
      .map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
      .filter((l) => l.label || l.url);
    await props.api.saveProfile({ displayName: name.value, bio: bio.value, links: clean });
    profileStatus.value = props.api.t('profile_saved');
  } catch (e) {
    profileStatus.value = props.api.t('profile_save_fail') + ': ' + (e?.message ?? e);
  } finally {
    profileBusy.value = false;
  }
}

async function acceptLink() {
  if (!linkUri.value.trim()) return;
  await props.api.acceptLink(linkUri.value.trim());
  linkUri.value = '';
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>{{ api.t('nav_profile') }}</h1>
    </header>

    <p v-if="state.error" class="error">{{ state.error }}</p>

    <div class="card">
      <h2>{{ api.t('profile_edit') }}</h2>
      <div class="avatar-row">
        <img v-if="avatarThumb" :src="avatarThumb" class="avatar" alt="" />
        <div v-else class="avatar placeholder" aria-hidden="true">?</div>
        <div class="avatar-actions">
          <button type="button" class="ghost" :disabled="avatarBusy" @click="pickAvatar">
            {{ avatarBusy ? api.t('create_encrypting') : api.t('profile_avatar_pick') }}
          </button>
          <button v-if="state.avatarDraft" type="button" class="ghost"
                  @click="api.clearAvatar()">
            {{ api.t('profile_avatar_remove') }}
          </button>
        </div>
        <input ref="avatarInput" type="file" accept="image/*" hidden @change="onAvatar" />
      </div>
      <p v-if="avatarStatus" class="muted">{{ avatarStatus }}</p>
      <label class="field">
        <span class="muted">{{ api.t('profile_name') }}</span>
        <input v-model="name" class="text-input" maxlength="80" autocomplete="off" />
      </label>
      <label class="field">
        <span class="muted">{{ api.t('profile_bio') }}</span>
        <textarea v-model="bio" class="text-input" rows="3" maxlength="500"></textarea>
      </label>
      <div class="links">
        <div v-for="(l, i) in links" :key="i" class="link-row">
          <input v-model="l.label" class="text-input" maxlength="40"
                 :placeholder="api.t('profile_link_label')" />
          <input v-model="l.url" class="text-input" maxlength="2048"
                 :placeholder="api.t('profile_link_url')" />
          <button type="button" class="ghost" :aria-label="api.t('profile_remove_link')"
                  @click="removeLink(i)">×</button>
        </div>
        <button v-if="links.length < 8" type="button" class="ghost" @click="addLink">
          {{ api.t('profile_add_link') }}
        </button>
      </div>
      <button class="primary" :disabled="profileBusy || !name.trim()" @click="saveProfile">
        {{ profileBusy ? api.t('create_encrypting') : api.t('common_save') }}
      </button>
      <p v-if="profileStatus" class="muted">{{ profileStatus }}</p>
    </div>

    <div class="card">
      <h2>{{ api.t('profile_wall') }}</h2>
      <p v-if="!ownPosts.length" class="muted">{{ api.t('profile_wall_empty') }}</p>
      <article v-for="post in ownPosts" :key="post.id" class="wall-post">
        <p class="wall-body">{{ post.post?.post?.body }}</p>
        <time class="muted">{{ when(post.post?.post?.ts) }}</time>
      </article>
    </div>

    <div class="card">
      <div class="row">
        <span class="muted">{{ api.t('profile_account') }}</span>
        <span :class="{ muted: !state.link?.linked }">
          {{ state.link?.linked ? state.link.account_fp : (state.identity?.fp ?? '—') }}
        </span>
      </div>
      <div v-if="state.link?.linked" class="row detail">
        <span class="muted">{{ api.t('profile_encryption_key') }}</span>
        <span class="fp">{{ state.link.encryption_fp }}</span>
      </div>
      <div class="row">
        <input v-model="linkUri" class="link-input" :placeholder="api.t('profile_link_uri')"
               autocomplete="off" spellcheck="false" />
        <button class="btn" @click="acceptLink">{{ api.t('profile_link_action') }}</button>
      </div>
      <p class="muted hint">{{ api.t('profile_link_hint') }}</p>
      <div class="row">
        <span class="muted">{{ api.t('settings_language') }}</span>
        <select class="select" :value="state.locale" @change="api.setLocale($event.target.value)">
          <option v-for="l in locales" :key="l.code" :value="l.code">{{ l.name }}</option>
        </select>
      </div>
      <div class="row">
        <span class="muted">{{ api.t('settings_theme') }}</span>
        <select class="select" :value="state.theme" @change="api.setTheme($event.target.value)">
          <option v-for="id in themes" :key="id" :value="id">{{ THEMES[id].name }}</option>
        </select>
      </div>
    </div>
  </section>
</template>

<style scoped>
.card h2 { font-size: 15px; margin: 0 0 10px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.text-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
}
.wall-post {
  border-top: 1px solid var(--border-subtle);
  padding: 8px 0;
}
.wall-post:first-of-type { border-top: 0; }
.wall-body {
  margin: 0 0 4px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.avatar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--border-subtle);
  flex: none;
}
.avatar.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  color: var(--text-muted, var(--text-secondary));
  font-size: 20px;
}
.avatar-actions { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.links { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
.link-row { display: flex; align-items: center; gap: 6px; }
.link-row .text-input { flex: 1; min-width: 0; }
.ghost {
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.ghost:hover { border-color: var(--accent-primary); }
.hint {
  margin: 10px 0 4px;
  line-height: 1.4;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.row:last-child {
  border-bottom: 0;
}
.select {
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
}

.link-input{flex:1;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid var(--border-hover,#30363d);background:var(--bg-primary,#0d1117);color:var(--text-primary,#e6edf3);font-size:12px;font-family:monospace}
.row.detail{padding-left:12px;border-left:2px solid var(--border-subtle,#30363d)}
</style>
