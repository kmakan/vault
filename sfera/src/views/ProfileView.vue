<script setup>
// Профиль: идентичность из Rust, переключение языка и темы. Платные
// возможности и организации появятся здесь же, отдельной вкладки не будет.
import { ref } from 'vue';
import { availableLocales } from '../locales/index.js';
import { THEMES } from '../themes/index.js';

const props = defineProps({ state: Object, api: Object });

const locales = availableLocales();
const themes = Object.keys(THEMES);
const linkUri = ref('');

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
