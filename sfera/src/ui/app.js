// Sfera UI: состояние экранов. Только оркестрация вызовов Rust —
// правила, форматы, права и цены остаются в Rust (ADR-006 §9.3).
// Модуль не трогает DOM, поэтому проверяется в node без GUI.

import { createShell } from './shell.js';
import { hasLocale, translate } from '../locales/index.js';
import { THEMES } from '../themes/index.js';

export function createAppState({
  bridge,
  locale = 'ru',
  theme = 'dark',
  clock = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (!bridge) throw new Error('bridge required');

  const shell = createShell();
  const state = {
    locale: hasLocale(locale) ? locale : 'en',
    theme: THEMES[theme] ? theme : 'dark',
    tab: shell.active(),
    apiVersion: null,
    identity: null,
    feed: [],
    contacts: [],
    audiences: [],
    caps: null,
    error: null,
  };

  async function load(key, fn) {
    try {
      state.error = null;
      state[key] = await fn();
      return state[key];
    } catch (e) {
      state.error = String(e?.message ?? e);
      return null;
    }
  }

  return {
    state,

    t(key, params) {
      return translate(state.locale, key, params);
    },

    setLocale(code) {
      if (!hasLocale(code)) return false;
      state.locale = code;
      return true;
    },

    setTheme(id) {
      if (!THEMES[id]) return false;
      state.theme = id;
      return true;
    },

    themeVars() {
      return THEMES[state.theme].vars;
    },

    openTab(id) {
      const ok = shell.select(id);
      if (ok) state.tab = shell.active();
      return ok;
    },

    tabs() {
      return shell.tabs();
    },

    async init() {
      state.apiVersion = await bridge.apiVersion();
      await Promise.all([
        load('identity', () => bridge.identity()),
        load('feed', () => bridge.feed()),
        load('contacts', () => bridge.contacts()),
        load('audiences', () => bridge.audiences()),
        load('caps', () => bridge.storeCaps()),
      ]);
      return state;
    },

    loadFeed: () => load('feed', () => bridge.feed()),
    loadContacts: () => load('contacts', () => bridge.contacts()),
    loadAudiences: () => load('audiences', () => bridge.audiences()),
    loadCaps: () => load('caps', () => bridge.storeCaps()),

    // Тело, адресат и медиа приходят из формы; форма аудитории — из Rust.
    // UI не собирает `PostAudience` и не подставляет версию протокола.
    async publish({ body, audience, media = [] }) {
      if (!body || !body.trim()) throw new Error('empty post');
      if (!audience) throw new Error('audience required');
      if (state.apiVersion == null) throw new Error('bridge not initialized');
      const now = clock();
      const post = await bridge.publishPost({
        v: state.apiVersion,
        ts: now,
        body,
        audience,
        media,
        now,
      });
      state.feed = await bridge.feed();
      return post;
    },

    companion(deepLinkHandled) {
      return bridge.companionAction(deepLinkHandled);
    },
  };
}
