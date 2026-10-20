// Node-смоук features/group-avatars.js — самовосстановление аватара группы.
//
// Покрытие фичи, которой до 20.10 не было вообще (нашёл гейт покрытия).
// Проверяем heal-протокол: лечение из письма, ответ на {hav:1}, запрос
// {hav:1}, rate-limit 24ч, защита от петли (отвечаем только с непустым
// аватаром) и догрузку ключа группы.
//
// СМОК СЛОВИЛ БАГ: внутри модуля остались вызовы `groupKeyOf(ctx, ...)`
// (имя из ADR-005 W2) — ReferenceError глотался catch'ем, и heal-запрос/ответ
// молча не работали.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-avatars-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const _kv = new Map();
globalThis.__dbMock = {
  kvGet: async (ns, k) => (_kv.has(k) ? _kv.get(k) : null),
  kvSet: async (ns, k, v) => { _kv.set(k, v); },
};
globalThis.__apiMock = {
  calls: [],
  myGroupKey: { group_key: 'GK_FROM_API' },
  getMyGroupKey: async (id) => { globalThis.__apiMock.calls.push(['getMyGroupKey', id]); return globalThis.__apiMock.myGroupKey; },
  sendGroupMeta: async (id, content) => { globalThis.__apiMock.calls.push(['sendGroupMeta', id, content]); return true; },
};
globalThis.__cryptoMock = {
  encryptCalls: [],
  encryptWithGroupKey: async (plain, key) => { globalThis.__cryptoMock.encryptCalls.push([plain, key]); return 'ENC(' + key + ')' + plain; },
};
writeFileSync(MOCKS + '/api-mock.mjs',
  'const api = globalThis.__apiMock; export const db = globalThis.__dbMock; export default api;\n');
writeFileSync(MOCKS + '/crypto-mock.mjs', 'export default globalThis.__cryptoMock;\n');

prepareModuleCopy(
  ROOT + '/src/features/group-avatars.js',
  MOCKS + '/group-avatars.mjs',
  { '../api.js': 'api-mock.mjs', '../crypto.js': 'crypto-mock.mjs' },
  MOCKS,
);
const G = await import(MOCKS + '/group-avatars.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Стенд ────────────────────────────────────────────────────────────────
const groups = {
  state: { groupKeys: {}, groupAvatars: {} },
  setGroupKey(id, key) { this.state.groupKeys[id] = key; },
  setGroupAvatar(id, av) { this.state.groupAvatars[id] = av; },
};
const deps = { groups, cryptoReady: () => true };
function reset(over = {}) {
  _kv.clear();
  globalThis.__apiMock.calls.length = 0;
  globalThis.__apiMock.myGroupKey = { group_key: 'GK_FROM_API' };
  globalThis.__cryptoMock.encryptCalls.length = 0;
  groups.state.groupKeys = {};
  groups.state.groupAvatars = {};
}
const sent = () => globalThis.__apiMock.calls.filter((c) => c[0] === 'sendGroupMeta');

// 1. healFromMessage: аватар из письма пишется в kv и в owner
console.log('1. healFromMessage: аватар из письма');
{
  reset();
  await G.healFromMessage(deps, 'g1', 'data:image/png;base64,AAA');
  check('аватар в kv', _kv.get('group-avatar:g1') === 'data:image/png;base64,AAA', _kv.get('group-avatar:g1'));
  check('аватар в owner', groups.state.groupAvatars.g1 === 'data:image/png;base64,AAA', groups.state.groupAvatars);
}

// 2. healFromMessage: пустое значение НЕ затирает существующий аватар
console.log('2. healFromMessage: пустое значение игнорируется');
{
  reset();
  _kv.set('group-avatar:g1', 'KEEP');
  await G.healFromMessage(deps, 'g1', '');
  await G.healFromMessage(deps, 'g1', null);
  check('аватар не затёрт', _kv.get('group-avatar:g1') === 'KEEP', _kv.get('group-avatar:g1'));
}

// 3. replyHeal: отвечаем meta{1,avatar} всем, если свой аватар есть
console.log('3. replyHeal: ответ с аватаром');
{
  reset();
  _kv.set('group-avatar:g1', 'MY_AVATAR');
  const ok = await G.replyHeal(deps, 'g1');
  check('ответ отправлен', sent().length === 1, sent());
  check('в ответе meta+аватар', sent()[0] && /"meta":1/.test(sent()[0][2]) && /MY_AVATAR/.test(sent()[0][2]), sent()[0] && sent()[0][2]);
  check('ключ группы догружен', groups.state.groupKeys.g1 === 'GK_FROM_API', groups.state.groupKeys);
  check('отметка «ответили» поставлена', !!_kv.get('avatar-heal-replied:g1'));
  check('успех возвращён (вызывающий помечает письмо обработанным)', ok === true);
}

// 4. replyHeal: своего аватара НЕТ → не отвечаем (защита от петли)
console.log('4. replyHeal: без своего аватара — молчим');
{
  reset();
  const ok = await G.replyHeal(deps, 'g1');
  check('ответа нет', sent().length === 0, sent());
  check('успех не возвращён', ok === undefined || ok === false, ok);
}

// 5. replyHeal: rate-limit 24ч
console.log('5. replyHeal: rate-limit');
{
  reset();
  _kv.set('group-avatar:g1', 'MY_AVATAR');
  _kv.set('avatar-heal-replied:g1', String(Date.now()));   // только что отвечали
  await G.replyHeal(deps, 'g1');
  check('второй ответ подавлен (24ч)', sent().length === 0, sent());
}

// 6. requestHeal: свой аватар пуст → просим {hav:1}
console.log('6. requestHeal: запрос аватара');
{
  reset();
  await G.requestHeal(deps, 'g1');
  check('запрос отправлен', sent().length === 1, sent());
  check('в запросе hav:1', sent()[0] && /"hav":1/.test(sent()[0][2]), sent()[0] && sent()[0][2]);
  check('отметка «просили» поставлена', !!_kv.get('avatar-heal-sent:g1'));
}

// 7. requestHeal: rate-limit 24ч
console.log('7. requestHeal: rate-limit');
{
  reset();
  _kv.set('avatar-heal-sent:g1', String(Date.now()));
  await G.requestHeal(deps, 'g1');
  check('повторный запрос подавлен', sent().length === 0, sent());
}

// 8. Нет ключа группы — запрос/ответ пропускаются
console.log('8. Нет ключа группы — тихий пропуск');
{
  reset();
  globalThis.__apiMock.myGroupKey = null;
  await G.requestHeal(deps, 'g1');
  check('без ключа запрос не уходит', sent().length === 0, sent());
  _kv.set('group-avatar:g1', 'MY_AVATAR');
  const ok = await G.replyHeal(deps, 'g1');
  check('без ключа ответ не уходит', sent().length === 0, sent());
  check('и успеха нет', ok !== true, ok);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
