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
// 5. `a3e82eb` (16.10, ADR-001 «toast-state owner») перевёл тост на uiStore,
//    но `uiStore` НЕ живёт на инстансе, а `setup()` читал `this?.showToast`
//    (в setup `this` === undefined). Оба пути тоста умерли МОЛЧА: фичи звали
//    uiStore.toast → пустышку, а метод App.vue падал на
//    `this.uiStore.setToastMessage` (TypeError). Нашлось на живой приёмке
//    19.10.2026 (t_e66389bd: скачивание рапортовало успех беззвучно).
//    Поэтому фаза 2 проверяет и КАНАЛ тоста, а не только рендер и login:
//      • `uiStore.tr(key)` обязан отдавать перевод, а не сам ключ;
//      • `uiStore.toast(...)` (путь фич) и `this.showToast(...)` (путь
//        App.vue) обязаны доводить текст до DOM (.app-toast).
//
// Проверка честная: берём НАСТОЯЩИЙ dist/ (то, что вшивается в APK/бинарник),
// поднимаем на 127.0.0.1, открываем headless-браузером, подставляем заглушку
// Tauri-моста и требуем:
//   • в #app есть отрендеренное содержимое;
//   • в консоли/Runtime нет ошибок неопределённых идентификаторов и TypeError;
//   • (фаза 2) isLoggedIn=true, groups — массив, groupsStore — хранилище.
//
// 6. 19.10.2026 (t_ddc24f52): `loadChannels()` звал `this.channelsStore` —
//    члена с таким именем у инстанса нет (владелец — модульный импорт).
//    TypeError бросался ВНУТРИ цикла по каналам, ловился `catch` рядом и
//    тонул в консоли: посты/непрочитанные всех каналов после первого не
//    загружались. На аккаунте с одним каналом симптом неотличим от нормы,
//    поэтому фаза 3 гоняет ДВА канала и требует, чтобы цикл дошёл до
//    последнего: посты и счётчики непрочитанного обоих.
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
  var mode = new URLSearchParams(location.search).get('smoke') || '';
  var auto = mode === 'autologin' || mode === 'channels';
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
  // Фаза «каналы»: ДВА канала с разными last_ts. Один канал не отличил бы
  // исправную загрузку от оборвавшейся на первом (см. фазу ниже).
  var CHANNELS = mode === 'channels' ? [
    { id: 'chn_smoke_1', name: 'Smoke One', created_by: EMAIL,
      created_at: '2026-01-01T00:00:00Z', owner_fpr: hex('d'), about: '',
      key: hex('e'), key_version: 1, is_owner: true, last_ts: 2000, known_subscribers: [] },
    { id: 'chn_smoke_2', name: 'Smoke Two', created_by: EMAIL,
      created_at: '2026-01-02T00:00:00Z', owner_fpr: hex('d'), about: '',
      key: hex('f'), key_version: 1, is_owner: true, last_ts: 4000, known_subscribers: [] },
  ] : [];
  // ts постов: канал 1 — 1 пост, 0 непрочитанных (1000 <= last_ts 2000);
  // канал 2 — 2 поста, 1 непрочитанный (5000 > last_ts 4000).
  var CHANNEL_POSTS = {
    chn_smoke_1: [{ id: 'post-1', ts: 1000, body: 'one', sender: '' }],
    chn_smoke_2: [
      { id: 'post-2', ts: 3000, body: 'two', sender: '' },
      { id: 'post-3', ts: 5000, body: 'three', sender: '' },
    ],
  };
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
    channels_load: function () { return CHANNELS; },
    load_channels: function () { return CHANNELS; },
    // Посты/аватары каналов App.vue читает через db.kvGet → db_kv_get.
    // В остальных фазах kv пуст, как и раньше (команды не было в таблице).
    db_kv_get: function (args) {
      if (mode !== 'channels') return null;
      var key = (args && args.key) || '';
      if (key.indexOf('channel-posts:') === 0) {
        return JSON.stringify(CHANNEL_POSTS[key.slice('channel-posts:'.length)] || []);
      }
      if (key.indexOf('channel-avatar:') === 0) return '';
      return null;
    },
  };
  var invoke = async function (cmd, args) {
    calls.push(cmd);
    var f = table[cmd];
    try { return f ? f(args) : null; } catch (e) { return null; }
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

// Проверка КАНАЛА ТОСТА (см. пункт 5 в шапке). Оба пути обязаны доводить текст
// до DOM: uiStore.toast — путь фич (relay/contacts/attachments/forward),
// this.showToast — путь App.vue. uiStore.tr обязан быть подключён к i18n.
const TOAST_EXPR = `(async () => {
  const app = document.querySelector('#app');
  const p = app && app._vnode && app._vnode.component && app._vnode.component.proxy;
  if (!p) return JSON.stringify({ hasProxy: false });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = () => {
    const el = document.querySelector('.app-toast');
    return el ? el.innerText.trim() : '';
  };
  const out = { hasProxy: true, i18nRegistered: false, storeToastShown: '', directToastShown: '' };
  try {
    out.i18nRegistered = p.uiStore ? p.uiStore.tr('download') !== 'download' : false;
  } catch (e) { out.i18nError = String((e && e.message) || e); }
  try {
    p.uiStore.toast('SMOKE-VIA-STORE');
    await wait(150);
    out.storeToastShown = shown();
  } catch (e) { out.storeError = String((e && e.message) || e); }
  try {
    p.showToast('SMOKE-VIA-METHOD');
    await wait(150);
    out.directToastShown = shown();
  } catch (e) { out.directError = String((e && e.message) || e); }
  return JSON.stringify(out);
})()`;

// Состояние загрузки каналов (фаза 3). Смысл — не «каналы есть», а «цикл
// загрузки ДОШЁЛ до последнего канала»: до 19.10 в `loadChannels()` стоял
// `this.channelsStore` (такого члена у инстанса нет) → TypeError ВНУТРИ цикла,
// а ошибка тонула в `catch (e) { console.error('Failed to load channels:', e) }`
// рядом: посты и счётчики всех каналов после первого не загружались.
const CHANNELS_EXPR = `(() => {
  const app = document.querySelector('#app');
  const p = app && app._vnode && app._vnode.component && app._vnode.component.proxy;
  if (!p) return JSON.stringify({ hasProxy: false });
  const ids = (p.channels || []).map((c) => c.id);
  const posts = {}; const unread = {};
  for (const id of ids) {
    posts[id] = Array.isArray(p.channelPosts && p.channelPosts[id]) ? p.channelPosts[id].length : null;
    unread[id] = Object.prototype.hasOwnProperty.call(p.channelUnread || {}, id) ? p.channelUnread[id] : null;
  }
  return JSON.stringify({ hasProxy: true, channelsLen: ids.length, ids, posts, unread });
})()`;

// ── Проверка живости UI-состояния (модалки/формы) ──────────────────────────
//
// КЛАСС, НАЙДЕННЫЙ 20.10.2026: флаги модалок и поля форм лежат в uiStore
// (ADR-004 J.5b/J.7). Если это состояние — ОБЫЧНЫЙ объект, computed в
// App.vue не имеет реактивных зависимостей, и Vue кэширует его значение
// НАВСЕГДА: флаг выставляется, а `.modal-overlay` в DOM не появляется.
// Ни один гейт этого не видел: сборка зелёная, смоуки зелёные, а настройки
// (и форма создания группы, и поиск чатов, и инвайт-попап) не открываются.
//
// Проверка — как действие пользователя: клик по кнопке настроек обязан
// открыть модалку, а запись в поле формы обязана дойти до владельца.
const MODAL_EXPR = `(async () => {
  const host = document.querySelector('#app');
  const app = host && host.__vue_app__;
  const inst = app && (app._instance || (app._container && app._container._vnode && app._container._vnode.component));
  const p = inst && inst.proxy;
  if (!p) return JSON.stringify({ error: 'нет инстанса' });
  const before = document.querySelectorAll('.modal-overlay').length;
  const btn = Array.from(document.querySelectorAll('button')).find((b) => {
    const t = (b.getAttribute('title') || '') + ' ' + (b.textContent || '');
    return /\u043d\u0430\u0441\u0442\u0440|settings/i.test(t);
  });
  if (btn) btn.click();
  await new Promise((r) => setTimeout(r, 400));
  const after = document.querySelectorAll('.modal-overlay').length;
  // Поле формы: значение обязано доехать до владельца (иначе форма создания
  // группы отправит пустое имя).
  // Чтение ДО записи: незакэшированный computed вычисляется заново и
  // заморозку не покажет — нужен уже закэшированный.
  const formBefore = p.newGroupName;
  p.newGroupName = 'boot-probe';
  await new Promise((r) => setTimeout(r, 150));
  const form = p.newGroupName;
  p.newGroupName = '';
  p.showSettings = false;
  await new Promise((r) => setTimeout(r, 150));
  return JSON.stringify({ before, after, form, formBefore, clicked: !!btn });
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
      // Канал тоста (пункт 5 в шапке): молчаливо мёртвый тост — тот же класс
      // «зелёная сборка, сломанный прод», что и ReferenceError в setup.
      const toast = s.toast;
      if (!toast || !toast.hasProxy) {
        failed.push('проверка тоста не выполнилась (нет инстанса)');
      } else {
        if (toast.i18nError) failed.push(`uiStore.tr падает: ${toast.i18nError}`);
        else if (!toast.i18nRegistered) failed.push('uiStore.tr не подключён к i18n (отдаёт сам ключ вместо перевода)');
        if (toast.storeError) failed.push(`uiStore.toast падает: ${toast.storeError}`);
        else if (toast.storeToastShown !== 'SMOKE-VIA-STORE') {
          failed.push(`uiStore.toast(...) не доходит до DOM (.app-toast: «${toast.storeToastShown}») — тосты фич глотаются`);
        }
        if (toast.directError) failed.push(`this.showToast падает: ${toast.directError}`);
        else if (toast.directToastShown !== 'SMOKE-VIA-METHOD') {
          failed.push(`this.showToast(...) не доходит до DOM (.app-toast: «${toast.directToastShown}»)`);
        }
      }
      // Живость UI-состояния (20.10.2026): флаги модалок/поля форм обязаны
      // быть РЕАКТИВНЫМИ. Обычный объект в uiStore → computed кэшируется
      // навсегда → модалка не открывается, а сборка зелёная.
      const modal = s.modal;
      if (!modal || modal.error) {
        failed.push('проверка модалки не выполнилась (нет инстанса)');
      } else {
        if (!modal.clicked) failed.push('кнопка настроек не найдена в DOM — проверка модалки не意义');
        else if (modal.after <= modal.before) {
          failed.push(`модалка НЕ открылась по клику (было ${modal.before}, стало ${modal.after}) — UI-состояние не реактивно (uiStore)`);
        }
        if (modal.form !== 'boot-probe') {
          failed.push(`поле формы не переживает запись («${modal.form}») — computed заморожен (uiStore.formState)`);
        } else if (modal.formBefore === 'boot-probe') {
          failed.push('проверка поля формы некорректна: значение было прочитано только после записи');
        }
      }
      return failed;
    },
  },
  {
    name: 'каналы: 2 канала — загрузка не обрывается на первом',
    query: '?smoke=channels',
    extraExpr: CHANNELS_EXPR,
    check(s, problems) {
      const failed = [];
      for (const p of problems) {
        if (/is not defined|ReferenceError|TypeError|Failed to load channels/.test(p)) failed.push(p);
      }
      const c = s.extra;
      if (!c || !c.hasProxy) {
        failed.push('не достучались до инстанса приложения для проверки каналов');
        return failed;
      }
      if (s.isLoggedIn !== true) failed.push(`авто-вход не дошёл до чатов (isLoggedIn=${s.isLoggedIn})`);
      if (c.channelsLen !== 2) failed.push(`загружено каналов ${c.channelsLen}, ожидалось 2`);
      if (c.posts.chn_smoke_1 !== 1) failed.push(`канал 1: постов ${c.posts.chn_smoke_1}, ожидалось 1`);
      if (c.posts.chn_smoke_2 !== 2) {
        failed.push(`канал 2: постов ${c.posts.chn_smoke_2}, ожидалось 2 — цикл loadChannels оборвался на первом канале`);
      }
      if (c.unread.chn_smoke_1 !== 0) failed.push(`канал 1: непрочитанных ${c.unread.chn_smoke_1}, ожидалось 0`);
      if (c.unread.chn_smoke_2 !== 1) {
        failed.push(`канал 2: непрочитанных ${c.unread.chn_smoke_2}, ожидалось 1 — посты канала 2 не загрузились`);
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
      // Канал тоста проверяем только там, где приложение уже вошло (фаза 2):
      // в фазе входа тост никто не показывает.
      if (phase.query.includes('smoke=autologin')) {
        // Живость UI-состояния: модалка обязана открываться (см. MODAL_EXPR).
        const modalRes = await cmd('Runtime.evaluate', {
          expression: MODAL_EXPR,
          returnByValue: true,
          awaitPromise: true,
        });
        try { state.modal = JSON.parse(modalRes.result?.result?.value || 'null'); } catch { state.modal = null; }
        const toastRes = await cmd('Runtime.evaluate', {
          expression: TOAST_EXPR,
          returnByValue: true,
          awaitPromise: true,
        });
        try { state.toast = JSON.parse(toastRes.result?.result?.value || 'null'); } catch { state.toast = null; }
      }
      if (phase.extraExpr) {
        const exRes = await cmd('Runtime.evaluate', {
          expression: phase.extraExpr,
          returnByValue: true,
          awaitPromise: true,
        });
        try { state.extra = JSON.parse(exRes.result?.result?.value || 'null'); } catch { state.extra = null; }
      }
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
