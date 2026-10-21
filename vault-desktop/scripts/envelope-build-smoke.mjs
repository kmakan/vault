// Node-смоук features/envelope-build.js — данные для wire-конверта.
//
// САМА СБОРКА КОНВЕРТА — В ЯДРЕ (vault::envelope::build). Здесь проверяются
// ДАННЫЕ, потому что ошибка в них тиха: письмо уходит с чужим именем или со
// старым аватаром, и получатель перезаписывает себе профиль.
//
// Правила:
//   * email не отправляется как имя (получатель считает name==email «нет имени»);
//   * аватар берётся АКТУАЛЬНЫЙ из kv (this.profiles в памяти отстаёт);
//   * gavatar — только для группового сообщения;
//   * TTL — в секундах от момента просмотра получателем;
//   * relay-токен — адрес моей очереди (получатель сохранит и сможет слать
//     мгновенные пуши).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/envelope-build-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// Мок api: displayName и kv-профили.
globalThis.__apiMock = {
  displayName: 'Аня',
  kv: {},
  getDisplayName: async () => globalThis.__apiMock.displayName,
  kvGet: async (ns, k) => (globalThis.__apiMock.kv[k] === undefined ? null : globalThis.__apiMock.kv[k]),
};
writeFileSync(MOCKS + '/api.js', `
const m = globalThis.__apiMock;
export const db = { kvGet: m.kvGet };
export const api = { getDisplayName: m.getDisplayName };
export default { ...api, db };
`);
// Мок crypto: публичный ключ и PQ.
globalThis.__cryptoMock = { publicKey: 'PUB', pqEk: 'PQ' };
writeFileSync(MOCKS + '/crypto.js', 'export default globalThis.__cryptoMock;\n');

prepareModuleCopy(
  ROOT + '/src/features/envelope-build.js',
  MOCKS + '/envelope-build.mjs',
  { '../api.js': 'api.js', '../crypto.js': 'crypto.js' },
  MOCKS,
);
const E = await import(MOCKS + '/envelope-build.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const s = {
    email: 'me@x.ru', displayName: 'Аня',
    profiles: {}, activeChatType: 'chat', currentGroup: null,
    built: null, shrunk: [], nextId: 'id-1',
  };
  const deps = {
    s,
    email: () => s.email,
    displayName: () => s.displayName,
    profiles: () => s.profiles,
    activeChatType: () => s.activeChatType,
    currentGroup: () => s.currentGroup,
    newMessageId: () => s.nextId,
    shrinkAvatar: async (a) => { s.shrunk.push(a); return a; },
    buildEnvelope: (payload) => { s.built = payload; return 'ENVELOPE'; },
    ...over,
  };
  return deps;
}

// ── Имя ────────────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await E.buildEnvelope(deps, 'текст');
  check('имя: наше имя уходит в конверт', deps.s.built.name === 'Аня', deps.s.built.name);
}
{
  const deps = makeDeps();
  deps.s.displayName = '';
  globalThis.__apiMock.displayName = '';
  await E.buildEnvelope(deps, 'текст');
  check('имя: без имени — пусто (не почта)', deps.s.built.name === '', deps.s.built.name);
}
{
  const deps = makeDeps();
  deps.s.displayName = 'me@x.ru';   // displayName == наш email
  await E.buildEnvelope(deps, 'текст');
  check('имя: наш email как имя НЕ отправляется (получатель счёл бы «нет имени»)',
    deps.s.built.name === '', deps.s.built.name);
}

// ── Аватар ─────────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  deps.s.profiles = { 'me@x.ru': { avatar: 'OLD' } };
  globalThis.__apiMock.kv['profiles'] = JSON.stringify({ 'me@x.ru': { avatar: 'FRESH' } });
  await E.buildEnvelope(deps, 'текст');
  check('аватар: взят АКТУАЛЬНЫЙ из kv, а не устаревший из памяти',
    deps.s.built.avatar === 'FRESH', deps.s.built.avatar);
}
{
  const deps = makeDeps();
  deps.s.profiles = { 'me@x.ru': { avatar: 'OLD' } };
  globalThis.__apiMock.kv['profiles'] = '{}';
  await E.buildEnvelope(deps, 'текст');
  check('аватар: без записи в kv — берётся из памяти', deps.s.built.avatar === 'OLD', deps.s.built.avatar);
}
{
  const deps = makeDeps();
  deps.s.shrunk.length = 0;
  await E.buildEnvelope(deps, 'текст');
  check('аватар: сжат перед отправкой', deps.s.shrunk.length === 1, deps.s.shrunk);
}

// ── Аватар группы ──────────────────────────────────────────────────────
{
  const deps = makeDeps();
  deps.s.activeChatType = 'group';
  deps.s.currentGroup = { id: 'g1' };
  globalThis.__apiMock.kv['group-avatar:g1'] = 'GAV';
  await E.buildEnvelope(deps, 'текст');
  check('группа: аватар группы приложен', deps.s.built.gavatar === 'GAV', deps.s.built.gavatar);
}
{
  const deps = makeDeps();
  deps.s.activeChatType = 'chat';
  deps.s.currentGroup = null;
  globalThis.__apiMock.kv['group-avatar:g1'] = 'GAV';
  await E.buildEnvelope(deps, 'текст');
  check('1:1: аватар группы НЕ приложен', deps.s.built.gavatar === null, deps.s.built.gavatar);
}

// ── Ключи, TTL, id ─────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await E.buildEnvelope(deps, 'текст', 3600);
  check('ключ: публичный ключ в конверте', deps.s.built.key === 'PUB', deps.s.built.key);
  check('ключ: PQ-ключ в конверте', deps.s.built.pqEk === 'PQ', deps.s.built.pqEk);
  check('ttl: передан в секундах', deps.s.built.ttlSecs === 3600, deps.s.built.ttlSecs);
  check('id: взят из newMessageId', deps.s.built.id === 'id-1', deps.s.built.id);
  check('текст: передан как есть', deps.s.built.text === 'текст', deps.s.built.text);
}
{
  const deps = makeDeps();
  await E.buildEnvelope(deps, 'текст');
  check('ttl: без ttl — 0 (обычное сообщение)', deps.s.built.ttlSecs === 0, deps.s.built.ttlSecs);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
