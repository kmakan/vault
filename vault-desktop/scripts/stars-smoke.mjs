// Node-смоук features/stars.js — «звёзды» сообщений.
//
// ADR-005 W3 (`t_b1bdbb99`), партия 7: логика уехала из App.vue. Состояние —
// у владельца форм (uiStore: карта «чат → id сообщений»), персист — в sqlite kv.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/stars-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const _kv = new Map();
globalThis.__dbMock = {
  kvGet: async (ns, k) => (_kv.has(k) ? _kv.get(k) : null),
  kvSet: async (ns, k, v) => { _kv.set(k, v); },
  kvDelete: async (ns, k) => { _kv.delete(k); },
};
writeFileSync(MOCKS + '/api.js', 'export const db = globalThis.__dbMock;\nexport default { db };\n');
writeFileSync(MOCKS + '/identity.js',
  'export const accountNamespace = (e) => "ns:" + String(e || "").toLowerCase();\n');

prepareModuleCopy(
  ROOT + '/src/features/stars.js',
  MOCKS + '/stars.mjs',
  { '../api.js': 'api.js', '../identity.js': 'identity.js' },
  MOCKS,
);
const S = await import(MOCKS + '/stars.mjs');
const { uiStore } = await import(ROOT + '/src/features/session-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Стенд ────────────────────────────────────────────────────────────────
const state = { chatKey: 'peer@x.ru' };
const deps = {
  email: () => 'me@x.ru',
  currentChatKey: () => state.chatKey,
  starredMap: () => uiStore.getFormField('starredMap'),
  setStarredMap: (v) => { uiStore.setFormField('starredMap', v); },
  starredSet: () => new Set(uiStore.getFormField('starredMap')[state.chatKey] || []),
};
function reset() {
  _kv.clear();
  state.chatKey = 'peer@x.ru';
  uiStore.setFormField('starredMap', {});
}

// 1. isStarred
console.log('1. isStarred');
{
  reset();
  uiStore.setFormField('starredMap', { 'peer@x.ru': ['m1', 'm2'] });
  check('отмеченная — true', S.isStarred(deps, { id: 'm1' }) === true);
  check('не отмеченная — false', S.isStarred(deps, { id: 'm9' }) === false);
  check('без id — false', S.isStarred(deps, {}) === false);
  check('null — false', S.isStarred(deps, null) === false);
}

// 2. toggleStar: поставить и снять
console.log('2. toggleStar: поставить/снять');
{
  reset();
  await S.toggleStar(deps, { id: 'm1' });
  check('звезда поставлена', uiStore.getFormField('starredMap')['peer@x.ru'].includes('m1'), uiStore.getFormField('starredMap'));
  check('записано в kv', JSON.parse(_kv.get('starred:peer@x.ru') || '[]').includes('m1'), _kv.get('starred:peer@x.ru'));
  await S.toggleStar(deps, { id: 'm1' });
  check('звезда снята', !(uiStore.getFormField('starredMap')['peer@x.ru'] || []).includes('m1'), uiStore.getFormField('starredMap'));
  check('kv очищен', !_kv.has('starred:peer@x.ru'), _kv.get('starred:peer@x.ru'));
}

// 3. toggleStar: без сообщения / без чата / чат заметок — no-op
console.log('3. toggleStar: no-op');
{
  reset();
  await S.toggleStar(deps, null);
  await S.toggleStar(deps, { id: '' });
  check('без сообщения — карта пуста', Object.keys(uiStore.getFormField('starredMap')).length === 0);
  state.chatKey = '';
  await S.toggleStar(deps, { id: 'm1' });
  check('без чата — no-op', Object.keys(uiStore.getFormField('starredMap')).length === 0);
  state.chatKey = '__notes__';
  await S.toggleStar(deps, { id: 'm1' });
  check('чат заметок — no-op', Object.keys(uiStore.getFormField('starredMap')).length === 0);
}

// 4. toggleStar: карта обновляется НОВЫМ объектом (реактивность)
console.log('4. toggleStar: новый объект карты');
{
  reset();
  uiStore.setFormField('starredMap', { 'peer@x.ru': ['m0'] });
  const before = uiStore.getFormField('starredMap');
  await S.toggleStar(deps, { id: 'm1' });
  const after = uiStore.getFormField('starredMap');
  check('объект карты новый (иначе Vue не увидит)', before !== after);
  check('старая запись не мутирована', before['peer@x.ru'].join(',') === 'm0', before['peer@x.ru']);
}

// 5. loadStarredFor: из kv в карту
console.log('5. loadStarredFor');
{
  reset();
  _kv.set('starred:g2@x.ru', JSON.stringify(['a', 'b']));
  await S.loadStarredFor(deps, 'g2@x.ru');
  check('звёзды загружены', (uiStore.getFormField('starredMap')['g2@x.ru'] || []).join(',') === 'a,b', uiStore.getFormField('starredMap'));
}

// 6. loadStarredFor: пусто/бито/служебный чат
console.log('6. loadStarredFor: крайние случаи');
{
  reset();
  await S.loadStarredFor(deps, '');
  await S.loadStarredFor(deps, '__notes__');
  check('пустой и служебный чат — карта не меняется', Object.keys(uiStore.getFormField('starredMap')).length === 0, uiStore.getFormField('starredMap'));
  _kv.set('starred:bad@x.ru', '{ не json');
  await S.loadStarredFor(deps, 'bad@x.ru');
  check('битый kv — тихо, без исключения', true);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
