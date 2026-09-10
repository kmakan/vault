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

// Глобальный обработчик ошибок Vue: без него краш рендера (ошибка в
// шаблоне/computed во время звонка) оставлял ПУСТОЙ #app — «все элементы
// пропали» (0.1.156, входящий звонок). Теперь: (1) ошибка логируется с
// полным стеком в debug-мост, (2) Vue не роняет всё дерево —
// app.config.errorHandler перехватывает до отмонтирования.
const app = createApp(App);
app.config.errorHandler = (err, instance, info) => {
  const msg = err && err.stack ? err.stack : String(err);
  console.error('[vue] render/error:', msg, '| component:', info);
  try { invoke('debug_log', { msg: `[error] [vue] ${info}: ${msg}` }).catch(() => {}); } catch (_) {}
};
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.stack ? e.reason.stack : String(e.reason);
  console.error('[promise] unhandled:', msg);
});
window.addEventListener('error', (e) => {
  if (e.error) console.error('[window]', e.error.stack || String(e.error));
});
app.mount('#app');
