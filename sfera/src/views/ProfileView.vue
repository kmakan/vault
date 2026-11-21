<script setup>
// Профиль: идентичность из Rust, переключение языка и темы. Платные
// возможности и организации появятся здесь же, отдельной вкладки не будет.
import { availableLocales } from '../locales/index.js';
import { THEMES } from '../themes/index.js';

defineProps({ state: Object, api: Object });

const locales = availableLocales();
const themes = Object.keys(THEMES);
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
          {{ state.link?.linked ? state.link.account_fp : api.t('profile_not_linked') }}
        </span>
      </div>
      <div class="row">
        <span class="muted">{{ api.t('profile_fingerprint') }}</span>
        <span class="fp">{{ state.identity?.fp ?? '—' }}</span>
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
</style>
