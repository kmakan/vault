// Замены нативных диалогов (alert/confirm/prompt) — ДО монтирования Vue,
// чтобы ни один вызов не ушёл в системный WebKit-диалог с заголовком tauri://localhost
import './ui.js';
import './style.css';
import { createApp } from 'vue';
import App from './App.vue';
import { invoke } from '@tauri-apps/api/core';

// Debug-мост: console.* фронтенда дублируется в stderr процесса через
// Tauri-команду debug_log (видно в /tmp/*.log при запуске из терминала).
// Только в dev/release-сборках с отладкой — ошибочные ветки не влияют.
const __dl = (level, args) => {
  try {
    const parts = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    });
    invoke('debug_log', { msg: `[${level}] ${parts.join(' ')}` }).catch(() => {});
  } catch { /* ignore */ }
};
const origLog = console.log, origWarn = console.warn, origErr = console.error;
console.log = (...a) => { __dl('log', a); origLog(...a); };
console.warn = (...a) => { __dl('warn', a); origWarn(...a); };
console.error = (...a) => { __dl('error', a); origErr(...a); };

createApp(App).mount('#app');
