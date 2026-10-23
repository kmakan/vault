// Смоук фильтра приглашений (ADR-005 W4, партия 4d).
//
// ЗАЧЕМ. «Этот инвайт уже принят — группа моя?» решался в api.js двумя
// сравнениями адреса (создатель/участник), и ни один смоук этого места не
// касался: invites-smoke подменяет api целиком, а api.js поднимают только
// recovery/body-absence — про другие методы. Ровно тот случай, ради которого
// заведена задача: решение жило при нулевом счётчике долга.
//
// Теперь решение — ответ моста `groups_access`. Здесь проверяется КОНТРАКТ
// пересылки: что уходит в мост (адрес, отпечаток, алиасы), что считается
// «моя группа» (только `is_mine`), и что `null`/отказ моста НЕ теряют попап.
//
// api.js исполняется живой копией из /tmp с замоканными Tauri-импортами —
// как в recovery-session-smoke; сети, файлов пользователя и таймеров нет.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/pending-invites-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// api.js при загрузке создаёт singleton и читает localStorage.
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const calls = [];
globalThis.__invoke = async (cmd, args) => {
  calls.push({ cmd, args });
  if (args.groupId === 'g-bridge-down') throw new Error('мост недоступен');
  const answer = globalThis.__accessByGroup[args.groupId];
  return answer === undefined ? null : answer;
};
writeFileSync(MOCKS + '/core.mjs',
  'export const invoke = (...a) => globalThis.__invoke(...a);\n');
// Крипта в этом смоуке не вызывается: модуль нужен только для загрузки.
writeFileSync(MOCKS + '/crypto.mjs',
  'export default { initFromStorage: async () => {}, fingerprint: async () => "" };\n');
writeFileSync(MOCKS + '/identity.mjs', [
  'export const accountNamespace = async (e) => "fp:" + String(e || "").toLowerCase();',
  'export const ensureAccountNamespace = async () => "ns:me";',
  'export const resetAccountNamespaceCache = () => {};',
  '',
].join('\n'));
writeFileSync(MOCKS + '/recovery-session.mjs',
  'export const isRecoveryPending = () => false;\n'
  + 'export const clearRecoveryPending = () => {};\n');

const apiFile = MOCKS + '/api.mjs';
prepareModuleCopy(ROOT + '/src/api.js', apiFile, {
  '@tauri-apps/api/core': 'core.mjs',
  './crypto.js': 'crypto.mjs',
  './identity.js': 'identity.mjs',
  './features/recovery-session.js': 'recovery-session.mjs',
}, MOCKS);
const { default: api } = await import(apiFile);

// ── Стенд ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ПРОВАЛ: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

const invite = (groupId, uid = '1') => ({
  uid,
  date: '2026-10-20T10:00:00Z',
  parsed: {
    group_id: groupId,
    group_name: 'Группа ' + groupId,
    sender: '',
    created_by: 'owner@x',
  },
});

// Мост отвечает ПО ГРУППЕ: «моя» только g-own; g-foreign — чужая;
// g-absent — локально не сохранена (null); g-bridge-down — отказ.
globalThis.__accessByGroup = {
  'g-own': { is_mine: true },
  'g-foreign': { is_mine: false },
  'g-absent': null,
};

let handshake = [];
api.fetchAllHandshake = async () => ({ groupInvites: handshake });
api.getDeclinedInvites = async () => [];
api.getAcceptedInvites = async () => [];
api.email = 'me@local.example';

const reset = () => { calls.length = 0; };

// ── 1. Своя группа скрыта, остальные показаны ─────────────────────────────
reset();
handshake = [invite('g-own'), invite('g-foreign'), invite('g-absent'), invite('g-bridge-down')];
const identity = () => ({ email: 'me@alias.example', fingerprint: 'FP-ME', aliases: ['old@x.example'] });
let shown = [];
let threw = null;
try { shown = await api.fetchPendingInvites(identity); } catch (e) { threw = e; }
ok('отказ моста не вылетает наружу (попап не теряем)', threw === null);
ok('свой инвайт по уже импортированной группе НЕ показывается',
  !shown.some(i => i.group_id === 'g-own'), shown.map(i => i.group_id));
ok('чужой инвайт показывается', shown.some(i => i.group_id === 'g-foreign'));
ok('группа не сохранена локально (мост ответил null) — инвайт показывается',
  shown.some(i => i.group_id === 'g-absent'));
ok('отказ моста не теряет попап', shown.some(i => i.group_id === 'g-bridge-down'));

// ── 2. В мост уходят адрес, отпечаток и алиасы идентичности ───────────────
const ownCall = calls.find(c => c.args.groupId === 'g-own');
ok('запрос прав идёт командой groups_access', !!ownCall && ownCall.cmd === 'groups_access');
ok('в мост ушёл текущий адрес идентичности, а не поле транспорта',
  ownCall && ownCall.args.email === 'me@alias.example', ownCall && ownCall.args.email);
ok('в мост ушёл отпечаток', ownCall && ownCall.args.fingerprint === 'FP-ME');
ok('в мост ушли алиасы (смена почты участником)',
  ownCall && JSON.stringify(ownCall.args.aliases) === JSON.stringify(['old@x.example']));

// ── 3. Без функции идентичности — адрес сессии, пустые fp/алиасы ───────────
reset();
handshake = [invite('g-own')];
shown = await api.fetchPendingInvites();
ok('без identity адрес берётся у сессии', calls[0] && calls[0].args.email === 'me@local.example');
ok('без identity отпечаток пуст', calls[0] && calls[0].args.fingerprint === '');
ok('без identity алиасов нет', calls[0] && Array.isArray(calls[0].args.aliases) && calls[0].args.aliases.length === 0);
ok('своя группа всё равно скрыта', shown.length === 0, shown);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
