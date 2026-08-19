// dbg.js — ВРЕМЕННЫЙ отладочный канал (удалить перед коммитом!).
// 1) Пересылает console.log/error/warn и ошибки окна на локальный HTTP-логгер.
// 2) Очередь команд: поллит GET /cmd?id=<wid> раз в 300 мс; сервер отдаёт
//    содержимое /tmp/vault_cmd_<wid>.txt (и удаляет его), код выполняется
//    как тело async-функции с аргументом app = корневой proxy Vue,
//    результат уходит в /tmp/vault_result_<wid>.txt через GET /result.
(function () {
  const BASE = 'http://127.0.0.1:9999';
  function wid() {
    try {
      const e = localStorage.getItem('vault-email');
      return (e ? e.split('@')[0] : 'unknown').replace(/[^a-z0-9_-]/gi, '_');
    } catch (_) { return 'unknown'; }
  }
  function send(tag, text) {
    try {
      const i = new Image();
      i.src = BASE + '/log?t=' + encodeURIComponent(tag) + '&m=' + encodeURIComponent(String(text).slice(0, 800));
    } catch (_) {}
  }
  window.addEventListener('error', (e) => send('WINDOW-ERROR', e.message + ' @ ' + e.filename + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => send('REJECT', (e.reason && (e.reason.message || e.reason)) || String(e.reason)));
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...a) => { send('LOG', a.map(x => (x && x.message) || x).join(' ')); orig.log(...a); };
  console.error = (...a) => { send('CONSOLE-ERROR', a.map(x => (x && x.message) || x).join(' ')); orig.error(...a); };
  console.warn = (...a) => { send('WARN', a.map(x => (x && x.message) || x).join(' ')); orig.warn(...a); };

  async function exec(expr) {
    const app = window.__vaultRoot;
    if (!app) throw new Error('vue app not mounted yet');
    const fn = new Function('app', 'return (async (app) => {' + expr + '})(app)');
    return await fn(app);
  }

  async function postResult(ok, val) {
    try {
      const r = await fetch(BASE + '/result?id=' + encodeURIComponent(wid()) +
        '&ok=' + (ok ? '1' : '0') +
        '&r=' + encodeURIComponent(String(val).slice(0, 4000)));
      await r.text();
    } catch (_) {}
  }

  async function tick() {
    try {
      const r = await fetch(BASE + '/cmd?id=' + encodeURIComponent(wid()));
      const expr = (await r.text()).trim();
      if (expr) {
        try {
          const val = await exec(expr);
          await postResult(true, val === undefined ? 'undefined' : JSON.stringify(val));
        } catch (e) {
          await postResult(false, (e && e.message) || String(e));
        }
      }
    } catch (_) { /* логгер не запущен — молча пропускаем */ }
  }
  setInterval(tick, 300);
})();
