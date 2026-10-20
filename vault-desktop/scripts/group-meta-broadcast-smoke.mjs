// Рассылка meta-писем группы (ADR-003 Этап 3, партия 11).
//
// Тест здесь — страховка от ДВУХ разных дефектов, и оба уже случались.
//
// 1. ПУСТОЙ АВАТАР В ПИСЬМЕ. Получатель применяет «obj.avatar && текущий !==
//    obj.avatar». Пустая строка прошла бы проверку obj.avatar как «аватар
//    отсутствует» и затерела бы у получателя аватар, который у него есть.
//    Правило: непустой аватар кладём, пустой не кладём. Имя НЕ фильтруется —
//    пустое имя это осмысленное «снять имя», а не мусор.
//
// 2. КЛЮЧ ГРУППЫ НЕ ЗАГРУЖЕН. Правило «if (!groupKey) return» было написано
//    в двух методах App.vue, и в одном из них так и осталось: переименование из
//    настроек БЕЗ открытия чата не рассылалось вообще. Имя менялось у себя,
//    участники не узнавали о нём никогда. Теперь догрузка ключа — одно
//    правило, и проверка ниже именно на этот случай: ключа в кэше НЕТ,
//    рассылка обязана состояться.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-meta-broadcast-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = {
  kvAvatars: {},        // groupId → аватар (или '' если записан пустой)
  keyOf: {},            // groupId → group_key, который отдаст getMyGroupKey
  getKeyCalls: [],
  sent: [],             // { groupId, content }
  failSend: false,
  failGetKey: false,
  failEncrypt: false,
};
globalThis.__st = state;

writeFileSync(MOCKS + '/api.js', `
const st = globalThis.__st;
const db = {
  kvGet: async (ns, key) => {
    if (st.failKvGet) throw new Error('kvGet недоступен');
    const gid = String(key).replace(/^group-avatar:/, '');
    return Object.prototype.hasOwnProperty.call(st.kvAvatars, gid) ? st.kvAvatars[gid] : null;
  },
};
const api = {
  getMyGroupKey: async (id) => {
    st.getKeyCalls.push(id);
    if (st.failGetKey) throw new Error('getMyGroupKey недоступен');
    return st.keyOf[id] ? { group_key: st.keyOf[id] } : null;
  },
  sendGroupMeta: async (gid, content) => {
    if (st.failSend) throw new Error('отправка отказала');
    st.sent.push({ groupId: gid, content });
  },
};
export { db };
export default api;
`);

writeFileSync(MOCKS + '/crypto.js', `
const st = globalThis.__st;
const crypto = {
  encryptWithGroupKey: async (payload, key) => {
    if (st.failEncrypt) throw new Error('шифрование отказало');
    return 'ENC[' + key + ']' + payload;
  },
};
export default crypto;
`);

let src = readFileSync(path.join(ROOT, 'src', 'features', 'group-meta-broadcast.js'), 'utf8');
src = src.replace("from '../api.js'", `from "${MOCKS}/api.js"`);
src = src.replace("from '../crypto.js'", `from "${MOCKS}/crypto.js"`);
writeFileSync(MOCKS + '/gmb.mjs', src, 'utf8');
const M = await import(MOCKS + '/gmb.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => {
  state.kvAvatars = {}; state.keyOf = {}; state.getKeyCalls = []; state.failKvGet = false;
  state.sent = []; state.failSend = false; state.failGetKey = false; state.failEncrypt = false;
};
// Разбирает отправленный payload обратно в объект, минуя шифрование.
const payloadOf = (i = 0) => JSON.parse(state.sent[i].content.slice(state.sent[i].content.indexOf(']') + 1));
const broadcast = (fields, groupKeys = {}, cryptoReady = true) =>
  M.broadcastGroupMeta('G1', fields, { groupKeys, cryptoReady });

console.log('\nADR-003 Этап 3, партия 11 · рассылка meta-писем группы');

// ── Правило «пустой аватар не отправляем» ──────────────────────────────
reset();
let f = M.buildRenameMetaFields('Моя группа', null, 1700000000000);
ok('аватара нет → поле avatar отсутствует', !('avatar' in f));
ok('имя и ts на месте', f.name === 'Моя группа' && f.ts === 1700000000000);

f = M.buildRenameMetaFields('Моя группа', '', 1700000000000);
ok('аватар ПУСТОЙ строкой → поле всё равно отсутствует', !('avatar' in f));

f = M.buildRenameMetaFields('Моя группа', 'data:image/jpeg;base64,AAA', 1700000000000);
ok('аватар непустой → поле есть', f.avatar === 'data:image/jpeg;base64,AAA');

f = M.buildRenameMetaFields('', 'AV', 1);
ok('пустое имя НЕ фильтруется — это «снять имя», а не мусор', f.name === '');

// Ключевая проверка правила: пустой аватар должен ДОБИТЬСЯ до получателя
// «у группы аватар отсутствует» и затереть его настоящий аватар.
reset();
state.keyOf.G1 = 'K1';
await broadcast(M.buildRenameMetaFields('Имя', '', 1));
ok('пустой аватар физически отсутствует в письме', !('avatar' in payloadOf()));
ok('meta:1 на месте — письмо узнаваемо получателем', payloadOf().meta === 1);

// ── ДЕФЕКТ 1: ключ не загружен (группу не открывали в чате) ─────────────
reset();
state.keyOf.G1 = 'K-ДОГРУЖЕННЫЙ';
const keys = {};                       // кэш ПУСТ — это и есть условие дефекта
let r = await broadcast({ name: 'Имя' }, keys, true);
ok('при пустом кэше ключ догружается и письмо уходит', r.sent === true);
ok('догружали ровно один раз', state.getKeyCalls.length === 1);
ok('письмо зашифровано догруженным ключом', state.sent[0].content.startsWith('ENC[K-ДОГРУЖЕННЫЙ]'));

r = await broadcast({ name: 'Ещё' }, keys, true);
ok('догруженный ключ кладётся в кэш компонента', keys.G1 === 'K-ДОГРУЖЕННЫЙ');
ok('второй раз ключ НЕ догружается', state.getKeyCalls.length === 1);

// Без готового хранилища догружать нельзя: getMyGroupKey отдаст мусор.
reset();
state.keyOf.G1 = 'K1';
r = await broadcast({ name: 'Имя' }, {}, false);
ok('cryptoReady=false → догружки нет, честный no-group-key',
  r.sent === false && r.reason === 'no-group-key');
ok('и письмо не отправлено', state.sent.length === 0);
ok('getMyGroupKey не вызывался вовсе', state.getKeyCalls.length === 0);

// Ключа нет нигде — молча отправлять нечего, но и исключения быть не должно.
reset();
r = await broadcast({ name: 'Имя' }, {}, true);
ok('ключ недоступен → no-group-key, без исключения',
  r.sent === false && r.reason === 'no-group-key');

// getMyGroupKey отказал — это рабочая ситуация, не повод ронять обработчик.
reset();
state.failGetKey = true;
r = await broadcast({ name: 'Имя' }, {}, true);
ok('отказ догрузки → no-group-key, без исключения',
  r.sent === false && r.reason === 'no-group-key');

// ── Отказ отправки: локальное имя уже применено, ломать нечего ─────────
reset();
state.keyOf.G1 = 'K1';
state.failSend = true;
r = await broadcast({ name: 'Имя' }, { G1: 'K1' }, true);
ok('отправка отказала → send-failed, БЕЗ исключения',
  r.sent === false && r.reason === 'send-failed');
ok('причина сохранена для журнала', !!r.error);

reset();
state.keyOf.G1 = 'K1';
state.failEncrypt = true;
r = await broadcast({ name: 'Имя' }, { G1: 'K1' }, true);
ok('шифрование отказало → тоже send-failed, без исключения',
  r.sent === false && r.reason === 'send-failed');

// ── Аватар идёт без ts: форма письма — контракт с выпущенными клиентами ─
reset();
state.keyOf.G1 = 'K1';
await broadcast({ avatar: 'AV' }, { G1: 'K1' }, true);
ok('аватарка: meta+avatar и БЕЗ ts (форма письма не менялась)',
  JSON.stringify(Object.keys(payloadOf()).sort()) === '["avatar","meta"]');
ok('значение аватара на месте', payloadOf().avatar === 'AV');

// ── loadGroupAvatar читает kv тем же ключом, что и раньше ───────────────
reset();
state.kvAvatars.G1 = 'AV-ИЗ-KV';
ok('аватар читается из group-avatar:<gid>', (await M.loadGroupAvatar('G1')) === 'AV-ИЗ-KV');
reset();
ok('нет аватара → null, не исключение', (await M.loadGroupAvatar('G1')) === null);

// ── Полный сценарий переименования из настроек БЕЗ открытия чата ────────
reset();
state.kvAvatars.G1 = 'AV';
state.keyOf.G1 = 'K1';
const cache = {};
await M.broadcastGroupMeta('G1', M.buildRenameMetaFields('Новое имя', await M.loadGroupAvatar('G1'), 7),
  { groupKeys: cache, cryptoReady: true });
const p = payloadOf();
ok('переименование без чата: имя дошло', p.name === 'Новое имя');
ok('переименование без чата: аватар приложен, получатель обновит профиль',
  p.avatar === 'AV');
ok('и meta:1 на месте', p.meta === 1);

// ── Поток переименования из UI (ADR-005 W3, партия 11) ────────────────
// Локальное имя применяется СРАЗУ и не откатывается при отказе рассылки;
// отсутствие ключа группы — явный warn, а не тихий выход.
console.log('\nПоток переименования (renameGroupFlow)');
{
  const calls = [];
  const deps = {
    applyLocalName: (id, n) => calls.push(['applyLocal', id, n]),
    groupKeys: state.keyOf,
    cryptoReady: true,
    logSent: (id, n) => calls.push(['sent', id, n]),
    logNoKey: (id) => calls.push(['noKey', id]),
    logFailed: (id, e) => calls.push(['failed', id]),
  };
  state.keyOf.G1 = 'K1';
  calls.length = 0;
  let r = await M.renameGroupFlow(deps, { groupId: 'G1', name: 'Новое имя' });
  ok('поток: локальное имя применено', calls.some((c) => c[0] === 'applyLocal' && c[2] === 'Новое имя'), calls);
  ok('поток: рассылка состоялась', r && r.sent === true && calls.some((c) => c[0] === 'sent'), calls);
  ok('поток: локальное имя применено ДО рассылки',
    calls.findIndex((c) => c[0] === 'applyLocal') < calls.findIndex((c) => c[0] === 'sent'), calls.map((c) => c[0]));

  // Без ключа группы — явный warn (не тихий выход): иначе переименование из
  // настроек без открытия чата не рассылалось вообще.
  calls.length = 0;
  // Ключа нет НИ В КЭШЕ, НИ НА ДИСКЕ (мок getMyGroupKey смотрит в state.keyOf)
  // — иначе модуль догрузит его, и сценарий «нет ключа» не состоялся бы.
  state.keyOf = {};
  r = await M.renameGroupFlow({ ...deps, groupKeys: {} }, { groupId: 'G1', name: 'Ещё раз' });
  ok('поток: без ключа — не «отправлено», причина видна', r && r.sent === false && r.reason === 'no-group-key', r);
  ok('поток: без ключа — warn записан', calls.some((c) => c[0] === 'noKey'), calls);

  // Ошибка рассылки — локальное имя остаётся (не откатывается).
  calls.length = 0;
  r = await M.renameGroupFlow({ ...deps, cryptoReady: false }, { groupId: 'G1', name: 'Третий раз' });
  ok('поток: при ошибке локальное имя НЕ откатывается',
    calls.some((c) => c[0] === 'applyLocal' && c[2] === 'Третий раз'), calls);

  // Сбой чтения аватара (kv недоступен) — ошибка ВИДНА (logFailed), а не
  // проглатывается молча: иначе переименование выглядит как «рассылка молчит».
  calls.length = 0;
  state.failKvGet = true;
  r = await M.renameGroupFlow(deps, { groupId: 'G1', name: 'Четвёртый раз' });
  state.failKvGet = false;
  ok('поток: сбой чтения аватара → ошибка залогирована',
    calls.some((c) => c[0] === 'failed'), calls);
  ok('поток: сбой не бросается наружу (переименование не ломает UI)',
    r && r.sent === false, r);
}

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);