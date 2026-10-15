// Создание группы (ADR-003 Этап 3, партия 7).
//
// Главное здесь — ПОРЯДОК и его цена. Оригинал клал группу в список ДО генерации
// ключа. Если бы применение уехало после генерации, то при сбое
// generateGroupKey группа осталась бы создана на Rust-стороне, но не появилась
// бы в UI: пользователь увидел бы «не удалось создать» про группу, которая
// существует. Это проверяется отдельно и не «примерно».
//
// Второе: рассылка аватара участникам не должна ронять создание. Один
// недоступный участник не должен стоить пользователю группы.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/groups-create-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { order: [], kv: {}, meta: [], failCreate: false, failKey: false, failMeta: false };
globalThis.__state = state;
globalThis.__api = {
  createGroup: async (name, about) => {
    if (state.failCreate) throw new Error('groups_create недоступна');
    state.order.push('createGroup');
    return { id: 'g1', name, about };   // members/blocked НЕ приходят — нормализуются
  },
  sendGroupMeta: async (id, content) => {
    if (state.failMeta) throw new Error('meta-письмо не отправлено');
    state.order.push('sendGroupMeta');
    state.meta.push({ id, content });
  },
};
writeFileSync(MOCKS + '/api.js', `
export default globalThis.__api;
export const db = {
  kvGet: async (a, k) => (globalThis.__state.kv[k] !== undefined ? globalThis.__state.kv[k] : null),
  kvSet: async (a, k, v) => { globalThis.__state.kv[k] = v; globalThis.__state.order.push('kvSet'); },
};
`);
writeFileSync(MOCKS + '/crypto.js', `
export default {
  generateGroupKey: async () => {
    if (globalThis.__state.failKey) throw new Error('generateGroupKey упал');
    globalThis.__state.order.push('generateGroupKey');
    return 'GK1';
  },
  encryptWithGroupKey: async (payload, key) => 'ENC(' + key + '|' + payload + ')',
};
`);

let s = readFileSync(path.join(ROOT, 'src', 'features', 'groups-create.js'), 'utf8');
s = s.split("from '../api.js'").join(`from "${MOCKS}/api.js"`)
     .split("from '../crypto.js'").join(`from "${MOCKS}/crypto.js"`);
writeFileSync(MOCKS + '/groups-create.mjs', s, 'utf8');
const GC = await import(MOCKS + '/groups-create.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { state.order = []; state.kv = {}; state.meta = []; state.failCreate = state.failKey = state.failMeta = false; };

console.log('\nADR-003 Этап 3, партия 7 · создание группы');

// 1. Порядок: применение состояния ДО генерации ключа.
reset();
let r = await GC.createGroup({ name: 'Тест', avatar: '', cryptoReady: true, onCreated: () => state.order.push('onCreated') });
ok('onCreated раньше generateGroupKey',
  state.order.indexOf('onCreated') < state.order.indexOf('generateGroupKey'));
ok('создание группы — самое первое', state.order[0] === 'createGroup');
ok('ключ сгенерирован и возвращён', r.groupKey === 'GK1');

// 2. Сбой генерации ключа: группа УЖЕ применена (это и есть смысл порядка).
reset();
state.failKey = true;
let applied = false, threw = false;
try {
  await GC.createGroup({ name: 'Тест', avatar: '', cryptoReady: true, onCreated: () => { applied = true; } });
} catch (e) { threw = true; }
ok('сбой ключа пробрасывается (его ловит UI)', threw === true);
ok('но группа к этому моменту УЖЕ применена — иначе она существовала бы в Rust молча', applied === true);

// 3. members/blocked нормализуются, если сервер их не вернул.
reset();
r = await GC.createGroup({ name: 'Тест', avatar: '', cryptoReady: false });
ok('members инициализированы, если не пришли', Array.isArray(r.group.members) && r.group.members.length === 0);
ok('blocked инициализирован', Array.isArray(r.group.blocked) && r.group.blocked.length === 0);
ok('без cryptoReady ключ не генерируется', r.groupKey === '');
ok('и sendGroupMeta не вызывается', state.meta.length === 0);

// 4. Аватар сохраняется и рассылается участникам.
reset();
state.kv = {};
r = await GC.createGroup({ name: 'Тест', avatar: 'AV', cryptoReady: true, onCreated: ({ avatar }) => { state.appliedAvatar = avatar; } });
ok('аватар записан в kv_store', state.kv['group-avatar:g1'] === 'AV');
ok('аватар передан в onCreated', state.appliedAvatar === 'AV');
ok('meta-письмо ушло участникам', state.meta.length === 1);
ok('meta несёт аватар и зашифрован ключом группы',
  state.meta[0].content === 'ENC(GK1|{"meta":1,"avatar":"AV"})');

// 5. Сбой рассылки НЕ роняет создание.
reset();
state.failMeta = true;
r = await GC.createGroup({ name: 'Тест', avatar: 'AV', cryptoReady: true });
ok('неудачная рассылка не отменяет создание группы', r.group && r.group.id === 'g1' && r.groupKey === 'GK1');
ok('и аватар в kv остался', state.kv['group-avatar:g1'] === 'AV');

// 6. Сбой создания — наружу.
reset();
state.failCreate = true;
threw = false;
try { await GC.createGroup({ name: 'Тест', avatar: '', cryptoReady: true }); } catch (e) { threw = true; }
ok('сбой groups_create пробрасывается', threw === true);

// 7. Имя обрезается от пробелов.
reset();
r = await GC.createGroup({ name: '  Моя группа  ', avatar: '', cryptoReady: false });
ok('имя обрезано от пробелов', r.group.name === 'Моя группа');

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);