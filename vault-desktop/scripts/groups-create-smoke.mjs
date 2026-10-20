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

// 8. Поток из UI (ADR-005 W3, партия 11): createGroupFlow.
// Проверка имени, применение состояния, сохранение ключа, сброс полей
// диалога и сообщение об ошибке — в модуле; компонент только вызывает.
console.log('\n8. createGroupFlow (поток из UI)');
{
  const calls = [];
  const deps = {
    cryptoReady: true,
    applyCreated: (x) => calls.push(['applyCreated', x.group.id]),
    saveGroupKey: (id, key) => calls.push(['saveGroupKey', id, key]),
    resetDialog: () => calls.push(['resetDialog']),
    onError: (e) => calls.push(['onError', e.message]),
  };
  reset();
  let r = await GC.createGroupFlow(deps, { name: '  Работа  ', avatar: 'AV' });
  ok('поток: группа создана', r && r.id === 'g1');
  ok('поток: состояние применено', calls.some((c) => c[0] === 'applyCreated' && c[1] === 'g1'), calls);
  ok('поток: ключ сохранён', calls.some((c) => c[0] === 'saveGroupKey' && c[2] === 'GK1'), calls);
  ok('поток: поля диалога сброшены', calls.some((c) => c[0] === 'resetDialog'), calls);
  ok('поток: порядок — применение, потом ключ, потом сброс диалога',
    calls.map((c) => c[0]).join(',') === 'applyCreated,saveGroupKey,resetDialog', calls.map((c) => c[0]));

  // Пустое имя — группа не создаётся, диалог не трогается.
  reset();
  calls.length = 0;
  r = await GC.createGroupFlow(deps, { name: '   ', avatar: '' });
  ok('поток: пустое имя → ничего не создано', r === null);
  ok('поток: при пустом имени нет ни одного эффекта', calls.length === 0, calls);

  // Сбой создания — ошибка в onError, состояние НЕ применяется.
  reset();
  state.failCreate = true;
  calls.length = 0;
  r = await GC.createGroupFlow(deps, { name: 'Работа', avatar: '' });
  ok('поток: сбой → onError, а не исключение наружу', r === null && calls.some((c) => c[0] === 'onError'), calls);
  ok('поток: при сбое диалог НЕ сбрасывается (пользователь может повторить)',
    !calls.some((c) => c[0] === 'resetDialog'), calls);

  // Без криптографии ключа нет — и сохранять нечего.
  reset();
  calls.length = 0;
  await GC.createGroupFlow({ ...deps, cryptoReady: false }, { name: 'Работа', avatar: '' });
  ok('поток: без cryptoReady ключ не сохраняется', !calls.some((c) => c[0] === 'saveGroupKey'), calls);
}

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);