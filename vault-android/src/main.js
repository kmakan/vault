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

// Android: uncaught JS errors must be VISIBLE — on a phone a dead webview
// with no console looks like "buttons don't work". Show a red banner with
// the error text so the user can report what actually broke.
const showFatal = (msg) => {
  try {
    let el = document.getElementById('vault-fatal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vault-fatal';
      el.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;' +
        'background:#7f1d1d;color:#fecaca;border:1px solid #ef4444;border-radius:8px;' +
        'padding:10px 12px;font:12px/1.4 monospace;white-space:pre-wrap;word-break:break-word;' +
        'max-height:40vh;overflow:auto;';
      document.body.appendChild(el);
    }
    el.textContent = String(msg).slice(0, 1000);
  } catch { /* ignore */ }
};
window.addEventListener('error', (e) => {
  showFatal('JS error: ' + (e.message || e.type) + (e.filename ? '\n' + e.filename + ':' + e.lineno : ''));
  __dl('error', ['uncaught', e.message, e.filename, e.lineno]);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  showFatal('Unhandled promise: ' + (r && r.message ? r.message : String(r)));
  __dl('error', ['unhandledrejection', String(r)]);
});

createApp(App).mount('#app');
