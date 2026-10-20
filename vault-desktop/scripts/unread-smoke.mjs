// Node-смоук features/unread.js — непрочитанные счётчики и флаг «без звука».
//
// ADR-005 W3 (`t_b1bdbb99`), партия 5: логика уехала из App.vue. Счётчики —
// у владельца чата, флаги mute — у владельца папок (folders-store), персист —
// в sqlite kv (мок).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/unread-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Мок api (kv) ─────────────────────────────────────────────────────────
const _kv = new Map();
globalThis.__dbMock = {
  kvGet: async (ns, k) => (_kv.has(k) ? _kv.get(k) : null),
  kvSet: async (ns, k, v) => { _kv.set(k, v); },
};
writeFileSync(MOCKS + '/api.js', 'export const db = globalThis.__dbMock;\nexport default { db };\n');
// identity-мок: namespace аккаунта
writeFileSync(MOCKS + '/identity.js',
  'export const accountNamespace = (e) => "ns:" + String(e || "").toLowerCase();\n');

prepareModuleCopy(
  ROOT + '/src/features/unread.js',
  MOCKS + '/unread.mjs',
  {
    '../api.js': 'api.js',
    '../identity.js': 'identity.js',
  },
  MOCKS,
);
const U = await import(MOCKS + '/unread.mjs');
const { foldersStore } = await import(ROOT + '/src/features/folders-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Стенд ────────────────────────────────────────────────────────────────
const state = { counts: {}, seen: new Set(), unreadOf: {}, cleared: [] };
const deps = {
  email: () => 'me@x.ru',
  unreadCounts: () => state.counts,
  setUnreadCounts: (v) => { state.counts = v; },
  processedUnreadIds: () => state.seen,
  setProcessedUnreadIds: (v) => { state.seen = v; },
  unreadOf: (k) => state.unreadOf[k] || 0,
  // Настоящий chat-store.clearUnread обнуляет И счётчик, И карту unreadCounts
  // (иначе «сохранённые счётчики» проверяли бы не то).
  clearUnread: (k) => { state.cleared.push(k); state.unreadOf[k] = 0; state.counts[k] = 0; },
};
function reset() {
  _kv.clear();
  state.counts = {};
  state.seen = new Set();
  state.unreadOf = {};
  state.cleared = [];
}

// 1. loadUnreadCounts: счётчики и отметки «обработано» из kv
console.log('1. loadUnreadCounts: счётчики и дедуп-отметки из kv');
{
  reset();
  _kv.set('unread-counts', JSON.stringify({ 'a@x.ru': 3 }));
  _kv.set('unread-seen', JSON.stringify(['m1', 'm2']));
  await U.loadUnreadCounts(deps);
  check('счётчики загружены', state.counts['a@x.ru'] === 3, state.counts);
  check('дедуп-отметки загружены', state.seen.has('m1') && state.seen.has('m2') && state.seen.size === 2, [...state.seen]);
}

// 2. loadUnreadCounts: пустой kv → пустые значения
console.log('2. loadUnreadCounts: пустой kv');
{
  reset();
  await U.loadUnreadCounts(deps);
  check('счётчики пусты', Object.keys(state.counts).length === 0, state.counts);
  check('дедуп-отметки пусты', state.seen.size === 0);
}

// 3. loadUnreadCounts: битый kv → сброс без исключения
console.log('3. loadUnreadCounts: битый kv → сброс');
{
  reset();
  // Перед битым kv значения НЕПУСТЫЕ: иначе «сброс» нечего проверять —
  // (проверка, отложенная от своих данных, в третий раз).
  state.counts = { 'stale@x.ru': 9 };
  state.seen = new Set(['stale-id']);
  _kv.set('unread-counts', '{ не json');
  let threw = null;
  try { await U.loadUnreadCounts(deps); } catch (e) { threw = e; }
  check('битый kv не роняет загрузку', threw === null, threw && String(threw));
  check('счётчики сброшены', Object.keys(state.counts).length === 0, state.counts);
  check('дедуп-отметки сброшены', state.seen.size === 0, [...state.seen]);
}

// 4. saveUnreadCounts / saveUnreadSeen: запись в kv
console.log('4. saveUnreadCounts / saveUnreadSeen');
{
  reset();
  state.counts = { 'b@x.ru': 7 };
  await U.saveUnreadCounts(deps);
  check('счётчики записаны в kv', JSON.parse(_kv.get('unread-counts') || '{}')['b@x.ru'] === 7, _kv.get('unread-counts'));
  state.seen = new Set(['m9']);
  await U.saveUnreadSeen(deps);
  check('дедуп-отметки записаны в kv', JSON.parse(_kv.get('unread-seen') || '[]')[0] === 'm9', _kv.get('unread-seen'));
}

// 5. resetUnread: счётчик > 0 → сброс и сохранение
console.log('5. resetUnread');
{
  reset();
  state.unreadOf['c@x.ru'] = 4;
  state.counts = { 'c@x.ru': 4 };
  await U.resetUnread(deps, 'c@x.ru');
  check('счётчик сброшен', state.cleared[0] === 'c@x.ru', state.cleared);
  check('счётчики сохранены', JSON.parse(_kv.get('unread-counts') || '{}')['c@x.ru'] === 0, _kv.get('unread-counts'));
}

// 6. resetUnread: счётчика нет → ничего не делаем
console.log('6. resetUnread: счётчика нет → no-op');
{
  reset();
  await U.resetUnread(deps, 'd@x.ru');
  check('без счётчика — не сбрасываем и не сохраняем', state.cleared.length === 0 && !_kv.has('unread-counts'), state.cleared);
}

// 7. isMuted: флаг из владельца папок
console.log('7. isMuted: флаг «без звука» у владельца папок');
{
  foldersStore.clearFlags();
  foldersStore.setFlag('peer@x.ru', { muted: true });
  check('мутнутый чат → isMuted true', U.isMuted('peer@x.ru') === true);
  check('обычный чат → isMuted false', U.isMuted('other@x.ru') === false);
  check('регистр нормализуется', U.isMuted('PEER@X.RU') === true);
  check('пустой ключ → false', U.isMuted('') === false);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
