// Гейт загрузки фронтенда: собранное приложение обязано РЕНДЕРИТЬСЯ и не падать
// на старте. Запускается после `vite build` (внутри `npm run build`).
//
// ЗАЧЕМ. 18.10 на живом телефоне APK 0.1.224 открылся ПУСТЫМ ЭКРАНОМ, хотя
// `npm run build` и все восемь гейтов были зелёными, смоуки 68/68. Причина —
// класс «зелёная сборка, сломанный прод» в <script> SFC, невидимый ни линтеру,
// ни статическим гейтам, ни смоукам (ни один смоук не запускает App.vue целиком):
//
//   1. `0948c88` добавил `import { reactive } from 'vue'`, но в App.vue уже
//      использовались `computed`/`watch` (блок J.3b) → `ReferenceError:
//      computed is not defined` в setup → корневой шаблон рендерит `<!---->`.
//   2. `6cdb79b` завёл прокси чата голым `chatStore.state.*` (соседние прокси
//      пишут `this.sessionStore...`) → `ReferenceError: chatStore is not
//      defined` при первом же чтении прокси.
//   3. Голый `mailboxStore.state.*` в прокси channels/emailBodyCache → падало
//      на ПЕРВОМ же шаге ветки авто-входа (loadBodyCache пишет кэш).
//   4. Хранилище групп отдавалось из setup как `groups` и перекрывало
//      data-поле `groups` (список групп): `this.groups = r.groups` в
//      loadGroups() затирало хранилище массивом, после чего
//      `this.groups.mergeGroupKeys()` падало TypeError.
//
// 3 и 4 видны ТОЛЬКО на ветке авто-входа (сохранённые credentials). Поэтому
// гейт состоит из двух фаз:
//   фаза 1 «экран входа» — пустой бэкенд, приложение обязано отрендериться;
//   фаза 2 «авто-вход»   — бэкенд отдаёт сохранённые credentials и ключ,
//                          приложение обязано дойти до ЧАТОВ (isLoggedIn),
//                          не потерять token и не бросить Reference/TypeError.
//
// Проверка честная: берём НАСТОЯЩИЙ dist/ (то, что вшивается в APK/бинарник),
// поднимаем на 127.0.0.1, открываем headless-браузером, подставляем заглушку
// Tauri-моста и требуем:
//   • в #app есть отрендеренное содержимое;
//   • в консоли/Runtime нет ошибок неопределённых идентификаторов и TypeError;
//   • (фаза 2) isLoggedIn=true, groups — массив, groupsStore — хранилище.
//
// Зависимостей не добавляет: Node ≥22 (глобальный WebSocket, fetch) + любой
// установленный Chrome/Chromium. Если браузера нет — гейт ПРОПУСКАЕТСЯ с
// громким предупреждением (нельзя валить сборку на машине без Chrome), но
// факт пропуска печатается в сводку.
//
// Отладка заглушки: `SMOKE_DEBUG=1 node scripts/boot-smoke.mjs` печатает все
// вызванные команды бэкенда (и это подсказывает, чего не хватает в таблице).
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const INDEX = path.join(DIST, 'index.html');
const READY_TIMEOUT_MS = 20000;
const SETTLE_MS = 9000;
const STRICT = !process.argv.includes('--no-strict');
const DEBUG = !!process.env.SMOKE_DEBUG;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
};

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) {
    if (c.includes('/')) {
      if (existsSync(c)) return c;
      continue;
    }
    try {
      const p = execFileSync('sh', ['-c', `command -v ${c}`], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (p) return p;
    } catch {
      /* нет такого бинарника — идём дальше */
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpConnect(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* браузер ещё поднимается */
    }
    await sleep(250);
  }
  return null;
}

// ── Заглушка Tauri-моста ────────────────────────────────────────────────
// Режим берётся из URL (?smoke=autologin), а не из отдельной инъекции: одна
// инъекция обслуживает обе фазы, и «сохранённые данные» появляются ровно
// тогда, когда их ждёт фаза 2.
const STUB = `(function () {
  var auto = new URLSearchParams(location.search).get('smoke') === 'autologin';
  var calls = [];
  window.__SMOKE_CALLS = calls;
  var EMAIL = 'smoke@example.test';
  var hex = function (c) { return new Array(65).join(c); };
  var creds = {
    email: EMAIL, password: 'smoke-pass',
    imap_server: 'imap.example.test', imap_port: 993,
    smtp_server: 'smtp.example.test', smtp_port: 465,
  };
  var keypair = { public_key: hex('a'), private_key: hex('b') };
  var table = {
    load_credentials: function () { return auto ? creds : null; },
    load_my_keypair: function () { return auto ? keypair : null; },
    get_fingerprint: function () { return hex('c'); },
    get_key_store_metadata: function () { return { version: 1, key_count: auto ? 1 : 0, last_modified: 0 }; },
    load_peer_keys: function () { return []; },
    groups_load_own: function () { return []; },
    groups_backfill_my_fingerprint: function () { return null; },
    email_connect: function () { return true; },
    email_disconnect: function () { return true; },
    db_body_cache_load_all: function () { return []; },
    db_body_cache_get: function () { return null; },
    db_cursors_load: function () { return {}; },
    db_emails_load: function () { return []; },
    db_history_load: function () { return []; },
    db_tombstones_load: function () { return []; },
    contacts_load: function () { return { contacts: [], contactAliases: {} }; },
    load_contacts: function () { return { contacts: [], contactAliases: {} }; },
    channels_load: function () { return []; },
    load_channels: function () { return []; },
  };
  var invoke = async function (cmd) {
    calls.push(cmd);
    var f = table[cmd];
    try { return f ? f() : null; } catch (e) { return null; }
  };
  // Диагностика (видна только при SMOKE_DEBUG): сколько было загрузок
  // документа и доходило ли состояние до «в чатах» хоть на миг.
  try {
    sessionStorage.setItem('smokeBoots', String((+(sessionStorage.getItem('smokeBoots') || 0) + 1)));
  } catch (e) { /* ignore */ }
  setInterval(function () {
    try {
      var app = document.querySelector('#app');
      var p = app && app._vnode && app._vnode.component && app._vnode.component.proxy;
      if (p && p.isLoggedIn) { window.__smokeMaxLoggedIn = true; window.__smokeEmail = p.email; }
      window.__smokeTimeline = window.__smokeTimeline || [];
      var last = window.__smokeTimeline[window.__smokeTimeline.length - 1];
      var dom = document.querySelector('.login-screen') ? 'L' : (document.querySelector('.app-container > *') ? 'A' : '-');
      var snap = (p ? (p.isLoggedIn ? 'IN' : 'out') : 'noinst')
        + '|store:' + (p && p.sessionStore ? (p.sessionStore.state.isLoggedIn ? 'IN' : 'out') + ':' + String(p.sessionStore.getCurrentEmail() || '') : '?')
        + '|' + String((p && p.email) || '')
        + '|err:' + String((p && p.loginError) || '').slice(0, 20)
        + '|dom:' + dom;
      if (!last || last[1] !== snap) window.__smokeTimeline.push([Math.round(performance.now()), snap]);
    } catch (e) { /* ignore */ }
  }, 20);
  window.__smokeLogs = [];
  ['log', 'info', 'warn', 'error'].forEach(function (lvl) {
    var orig = console[lvl];
    console[lvl] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          parts.push(typeof a === 'string' ? a : (a && a.message) ? a.message : String(a));
        }
        window.__smokeLogs.push(lvl + ': ' + parts.join(' ').slice(0, 160));
        if (window.__smokeLogs.length > 300) window.__smokeLogs.shift();
      } catch (e) { /* ignore */ }
      return orig.apply(console, arguments);
    };
  });
  if (auto) {
    localStorage.setItem('vault-email', EMAIL);
    localStorage.setItem('vault-token', 'serverless-' + EMAIL);
    localStorage.removeItem('vault-recovery-pending');
  } else {
    localStorage.removeItem('vault-email');
    localStorage.removeItem('vault-token');
    localStorage.removeItem('vault-recovery-pending');
  }
  var existing = window.__TAURI_INTERNALS__;
  if (existing && existing.invoke && !existing.__smoked) {
    var orig = existing.invoke.bind(existing);
    existing.invoke = function (cmd, args) { calls.push(cmd); return orig(cmd, args); };
    existing.__smoked = true;
    return;
  }
  window.__TAURI_INTERNALS__ = {
    invoke: invoke,
    transformCallback: function (cb) { return cb; },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    plugins: {},
  };
})();`;

const STATE_EXPR = `(() => {
  const app = document.querySelector('#app');
  const inst = app && app._vnode && app._vnode.component;
  const p = inst && inst.proxy;
  return JSON.stringify({
    children: app ? app.children.length : 0,
    htmlLen: app ? app.innerHTML.length : 0,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
    hasProxy: !!p,
    isLoggedIn: p ? !!p.isLoggedIn : null,
    email: p ? String(p.email || '') : '',
    groupsIsArray: p ? Array.isArray(p.groups) : null,
    groupsLen: p && Array.isArray(p.groups) ? p.groups.length : null,
    groupsStoreOk: p ? !!(p.groupsStore && p.groupsStore.state) : null,
    loginError: p ? String(p.loginError || '').slice(0, 90) : '',
    token: (localStorage.getItem('vault-token') || '').slice(0, 40),
    storeLogged: !!(p && p.sessionStore && p.sessionStore.state.isLoggedIn),
    storeEmail: p && p.sessionStore ? String(p.sessionStore.getCurrentEmail() || '') : '',
    isLoggedInInData: p ? Object.keys(p.$data || {}).includes('isLoggedIn') : null,
    hasComputed: !!(p && p.$options && p.$options.computed && p.$options.computed.isLoggedIn),
    boots: +(sessionStorage.getItem('smokeBoots') || 0),
    maxLoggedIn: !!window.__smokeMaxLoggedIn,
    maxEmail: String(window.__smokeEmail || ''),
  });
})()`;

// ── Фазы ────────────────────────────────────────────────────────────────
const PHASES = [
  {
    name: 'экран входа',
    query: '',
    check(s, problems) {
      const failed = [];
      if (s.children < 1 || s.htmlLen < 40) {
        failed.push(`корень #app пуст (children=${s.children}, len=${s.htmlLen}) — приложение не отрендерилось`);
      }
      for (const p of problems) if (/is not defined|ReferenceError|TypeError/.test(p)) failed.push(p);
      return failed;
    },
  },
  {
    name: 'авто-вход (сохранённые данные)',
    query: '?smoke=autologin',
    check(s, problems) {
      const failed = [];
      for (const p of problems) if (/is not defined|ReferenceError|TypeError/.test(p)) failed.push(p);
      if (!s.hasProxy) failed.push('не достучались до корневого компонента (#app._vnode.component)');
      else {
        if (!s.isLoggedIn) {
          failed.push(`авто-вход не дошёл до чатов (isLoggedIn=false, loginError=«${s.loginError}») — ветка после restoreSession падает`);
        }
        if (s.email !== 'smoke@example.test') failed.push(`email не восстановлен (получено «${s.email}»)`);
        if (s.groupsIsArray !== true) failed.push(`this.groups должен быть СПИСКОМ групп (получено: массив=${s.groupsIsArray})`);
        if (s.groupsStoreOk !== true) failed.push('this.groupsStore должен быть хранилищем групп (.state)');
        if (!s.token) failed.push('авто-вход потерял vault-token (следующий старт не попробует вход)');
      }
      return failed;
    },
  },
];

async function main() {
  if (!existsSync(INDEX)) {
    console.error('✗ boot-smoke: нет dist/index.html — сначала `vite build`');
    process.exit(1);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.warn('⚠ boot-smoke: Chrome/Chromium не найден — проверка загрузки ПРОПУЩЕНА (поставьте CHROME_PATH)');
    process.exit(0);
  }

  // ── статический сервер dist/ ────────────────────────────────────────
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = path.join(DIST, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const httpPort = server.address().port;

  const cdpProbe = createServer();
  await new Promise((r) => cdpProbe.listen(0, '127.0.0.1', r));
  const cdpPort = cdpProbe.address().port;
  await new Promise((r) => cdpProbe.close(r));

  const profile = mkdtempSync(path.join(tmpdir(), 'vault-boot-'));
  const proc = spawn(
    chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let failed = [];
  const summaries = [];
  try {
    const wsUrl = await cdpConnect(cdpPort);
    if (!wsUrl) throw new Error('CDP недоступен');

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('не удалось открыть WebSocket CDP'));
      setTimeout(() => rej(new Error('таймаут WebSocket CDP')), READY_TIMEOUT_MS);
    });

    let msgId = 0;
    const pending = new Map();
    let problems = [];
    let collecting = false;
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
        return;
      }
      if (!collecting) return;
      const p = m.params || {};
      if (m.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails || {};
        problems.push(`EXCEPTION ${d.exception?.description || d.text || ''}`.slice(0, 300));
      } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) {
        const args = (p.args || []).map((a) => String(a.value ?? a.description ?? '')).join(' ');
        if (/\[vue\]/.test(args) || p.type === 'error') problems.push(`CONSOLE[${p.type}] ${args}`.slice(0, 300));
      } else if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(p.entry?.level)) {
        problems.push(`LOG[${p.entry.level}] ${String(p.entry.text).slice(0, 300)}`);
      }
    };
    const cmd = (method, params) => {
      const id = ++msgId;
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      return new Promise((res) => pending.set(id, res));
    };

    await cmd('Runtime.enable');
    await cmd('Log.enable');
    await cmd('Page.enable');
    await cmd('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

    for (const phase of PHASES) {
      problems = [];
      await cmd('Page.navigate', { url: `http://127.0.0.1:${httpPort}/index.html${phase.query}` });
      collecting = true; // ошибки ПЕРВОЙ загрузки (без заглушки) не считаем
      await sleep(SETTLE_MS);

      const res = await cmd('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
      const state = JSON.parse(res.result?.result?.value || '{}');
      const realProblems = problems.filter((p) => !/\[crypto\] нет сохранённого ключа/.test(p));
      const phaseFailed = phase.check(state, realProblems);

      if (DEBUG) {
        const callsRes = await cmd('Runtime.evaluate', {
          expression: 'JSON.stringify([...new Set(window.__SMOKE_CALLS || [])])',
          returnByValue: true,
        });
        let calls = [];
        try { calls = JSON.parse(callsRes.result?.result?.value || '[]'); } catch { /* ignore */ }
        console.log(`  [debug] фаза «${phase.name}»: команды бэкенда = ${calls.join(' ')}`);
        console.log(`  [debug] загрузок документа = ${state.boots}, доходило до чатов = ${state.maxLoggedIn} (email=«${state.maxEmail}»), сейчас email=«${state.email}», loginError=«${state.loginError}»`);
        console.log(`  [debug] isLoggedIn: proxy=${state.isLoggedIn}, store=${state.storeLogged} (store email=«${state.storeEmail}»), в data=${state.isLoggedInInData}, computed есть=${state.hasComputed}`);
        const reRes = await cmd('Runtime.evaluate', {
          expression: `(async () => {
            const p = document.querySelector('#app')._vnode.component.proxy;
            const tick = () => new Promise((r) => setTimeout(r, 120));
            const snap = () => ({ proxy: p.isLoggedIn, store: p.sessionStore.state.isLoggedIn, email: p.email });
            const before = snap();
            p.$forceUpdate();
            await tick();
            const afterForce = snap();
            p.sessionStore.login();   // запись ЧЕРЕЗ тот же proxy, что читает computed
            await tick();
            const afterProxyWrite = snap();
            return JSON.stringify({ before, afterForce, afterProxyWrite });
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        console.log('  [debug] после $forceUpdate: ' + (reRes.result?.result?.value || '{}'));
        const tlRes = await cmd('Runtime.evaluate', {
          expression: 'JSON.stringify(window.__smokeTimeline || [])',
          returnByValue: true,
        });
        console.log('  [debug] переходы: ' + (tlRes.result?.result?.value || '[]'));
        const logsRes = await cmd('Runtime.evaluate', {
          expression: 'JSON.stringify((window.__smokeLogs || []).slice(-40))',
          returnByValue: true,
        });
        let appLogs = [];
        try { appLogs = JSON.parse(logsRes.result?.result?.value || '[]'); } catch { /* ignore */ }
        for (const l of appLogs) console.log('    [app] ' + l);
      }

      failed = failed.concat(phaseFailed.map((f) => `[${phase.name}] ${f}`));
      summaries.push(
        `«${phase.name}»: ${state.htmlLen} симв.` +
        (state.hasProxy ? `, isLoggedIn=${state.isLoggedIn}, группа=${state.groupsLen}` : '') +
        `, ошибок: ${realProblems.length}`,
      );
    }
    ws.close();
  } catch (e) {
    failed.push(`проверка не выполнена: ${e.message}`);
  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    if (proc.exitCode === null) proc.kill('SIGKILL');
    await new Promise((r) => server.close(r));
    rmSync(profile, { recursive: true, force: true });
  }

  const summary = summaries.join(' · ');
  if (failed.length && STRICT) {
    console.error(`✗ boot-smoke: приложение не загрузилось (${failed.length} проблем)`);
    for (const f of failed) console.error('  ' + f);
    console.error('  ' + summary);
    process.exit(1);
  }
  if (failed.length) {
    console.warn('⚠ boot-smoke (--no-strict): ' + failed.join(' | '));
    process.exit(0);
  }
  console.log(`✓ boot-smoke: ${summary}`);
}

main();
