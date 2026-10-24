// Загрузка групп и подписка контактов из участников (ADR-003 Этап 3, партия 5).
//
// Первая партия, где сбор и применение разнесены. Значит главный риск здесь —
// не «работает ли», а «СОВПАДАЕТ ЛИ ПОВЕДЕНИЕ при сбое». Оригинал присваивал
// groups сразу после invoke, аватары и контакты — по ходу цикла. Если бы мы
// вернули null при ошибке, потеряли бы частичный результат: список групп
// исчез бы с экрана. Тест ниже фиксирует именно это — что при сбое на третьей
// группе первые две ДОЛЖНЫ сохраниться.
//
// Плюс правило «участник группы = контакт» с его мотивировкой: удаление контакта
// не должно убирать переписку, поэтому участники добираются в контакты.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/groups-load-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { groups: null, own: null, kv: {}, healed: [] };
globalThis.__state = state;
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'groups_load_own') {
    if (state.own === null) throw new Error('groups_load_own недоступна');
    return state.own;
  }
  return null;
};
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);');
writeFileSync(MOCKS + '/api.js', `
export const db = {
  kvGet: async (acct, key) => {
    // state лежит в области теста, а модуль-мок её не видит — нужен globalThis.
    // Первая версия мока писала state.kv и падала с ReferenceError, который
    // проглатывал catch функции: тест видел «группы не загрузились» вместо
    // «мок сломан». Это ровно проблема ADR-003 §5.2, воспроизведённая на себе.
    const st = globalThis.__state;
    if (st.kvFailOn === key) throw new Error('kv_store недоступен: ' + key);
    return (st.kv[key] !== undefined ? st.kv[key] : null);
  },
};
`);
let s = readFileSync(path.join(ROOT, 'src', 'features', 'groups-load.js'), 'utf8');
s = s.replace("from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`)
     .replace("from '../api.js'", `from "${MOCKS}/api.js"`);
writeFileSync(MOCKS + '/groups-load.mjs', s, 'utf8');
const GL = await import(MOCKS + '/groups-load.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { state.own = []; state.kv = {}; state.healed = []; state.kvFailOn = null; };
const deps = (o = {}) => ({
  email: o.email || 'me@bk.ru',
  fingerprint: o.fingerprint || 'FP-ME',
  aliasesOf: o.aliasesOf || (() => []),
  contacts: o.contacts || [],
  requestGroupAvatarHeal: o.heal || ((id) => { state.healed.push(id); return Promise.resolve(); }),
});

console.log('\nADR-003 Этап 3, партия 5 · загрузка групп');

// 1. Базовый случай: группы, аватары, иконки.
reset();
state.own = [{ id: 'g1', members: [] }];
state.kv = { 'group-avatar:g1': 'AV1', 'group-icon:g1': 'IC1' };
let r = await GL.loadGroups(deps());
ok('группы загружены', r.groups && r.groups.length === 1);
ok('аватар и иконка прочитаны', r.avatars.g1 === 'AV1' && r.icons.g1 === 'IC1');
ok('heal не вызывался, раз аватар есть', state.healed.length === 0);

// 2. Нет аватара → запрошен heal, загрузка списка не заблокирована.
reset();
state.own = [{ id: 'g2', members: [] }];
r = await GL.loadGroups(deps());
ok('без аватара запрошен heal', state.healed.length === 1 && state.healed[0] === 'g2');
ok('отсутствие аватара не ломает загрузку', r.groups && r.groups.length === 1);

// 3. Участники становятся контактами, кроме себя и уже известных.
reset();
state.own = [{ id: 'g3', members: [
  { email: 'me@bk.ru' }, { email: 'a@x' }, { email: 'b@x' },
] }];
r = await GL.loadGroups(deps({ contacts: [{ id: 'k', email: 'a@x' }] }));
ok('себя в контакты не добавляем', !r.newContacts.some(c => c.email === 'me@bk.ru'));
ok('уже известного контакта не дублируем', !r.newContacts.some(c => c.email === 'a@x'));
ok('новый участник добавлен', r.newContacts.length === 1 && r.newContacts[0].email === 'b@x');
ok('форма контакта как ожидает UI',
  r.newContacts[0].id === 'b@x' && r.newContacts[0].name === 'b@x' && r.newContacts[0].online === false);

// 4. Два участника с одним адресом в РАЗНЫХ группах — добавляется один раз.
reset();
state.own = [{ id: 'gA', members: [{ email: 'dup@x' }] }, { id: 'gB', members: [{ email: 'dup@x' }] }];
r = await GL.loadGroups(deps());
ok('один адрес в двух группах → один контакт', r.newContacts.length === 1);

// 5. Алиасы уходят в запрос, смена почты не теряет группы.
reset();
let seenReq = null;
state.own = [];
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'groups_load_own') { seenReq = args; if (state.own === null) throw new Error('x'); return state.own; }
  return null;
};
await GL.loadGroups(deps({ aliasesOf: (e) => ['old@bk.ru', 'older@bk.ru'] }));
ok('алиасы переданы в groups_load_own',
  seenReq && seenReq.aliases.join(',') === 'old@bk.ru,older@bk.ru' && seenReq.email === 'me@bk.ru');

// 6. aliasesOf бросает — фильтр всё равно уходит по email+fp.
seenReq = null;
await GL.loadGroups(deps({ aliasesOf: () => { throw new Error('алиасы недоступны'); } }));
ok('упавший aliasesOf не роняет загрузку (fail-open)', seenReq && seenReq.aliases.length === 0);

// 7. ЧАСТИЧНЫЙ РЕЗУЛЬТАТ: сбой на третьей группе не теряет первые две.
reset();
globalThis.__invoke = async (cmd) => {
  if (cmd === 'groups_load_own') {
    return [{ id: 'g1', members: [] }, { id: 'g2', members: [{ email: 'x@x' }] },
            { id: 'g3', members: [] }, { id: 'g4', members: [] }];
  }
  return null;
};
state.kv = { 'group-avatar:g1': 'AV1', 'group-avatar:g2': 'AV2' };
state.kvFailOn = 'group-avatar:g3';
r = await GL.loadGroups(deps());
ok('groups сохранены несмотря на сбой', r.groups && r.groups.length === 4);
ok('аватары первых двух групп сохранены', r.avatars.g1 === 'AV1' && r.avatars.g2 === 'AV2');
ok('контакт участника второй группы сохранён', r.newContacts.length === 1 && r.newContacts[0].email === 'x@x');
ok('третья и четвёртая группы не обработаны', r.avatars.g3 === undefined);

// 8. groups = null, если invoke не отработал: поле не затирается.
// Тест 7 подменил __invoke на всегда-успешный, поэтому возвращаем отказ явно —
// иначе state.own = null ничего не делает и проверка проходит по инерции.
globalThis.__invoke = async (cmd) => {
  if (cmd === 'groups_load_own') throw new Error('groups_load_own недоступна');
  return null;
};
r = await GL.loadGroups(deps());
ok('при сбое invoke groups = null (поле остаётся прежним)', r.groups === null);
ok('и никаких частичных аватаров', Object.keys(r.avatars).length === 0);

// 9. Кого добивать в контакты, решает ЯДРО — одним вопросом на весь список
// участников. Живые данные X50 (24.10), сессия koanmak@ya.ru:
//   · koanmak@phone — наш же аккаунт (в fingerprint наш публичный ключ);
//   · koanmak@gmail.com — адрес БЕЗ ключа, а тот же ключ 9cadcd4d лежит в
//     peer_keys под vault-msg@ya.ru: пир сменил почту, группы остались со
//     старым адресом. Прежний фронт ставил его второй строкой: та же аватарка
//     дважды и попап «Добавить контакт» вместо чата.
// Мок повторяет правило ядра (свой / известный адрес / та же идентичность —
// прочь) и проверяет форму запроса: все пять аргументов и ОДИН вызов.
reset();
let padReqs = [];
globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'groups_load_own') return state.own;
  if (cmd === 'groups_contacts_to_pad') {
    padReqs.push(args);
    const known = new Set((args.contacts || []).map(([e]) => String(e).toLowerCase()));
    const keys = new Set((args.contacts || []).map(([, k]) => k));
    return (args.members || [])
      .filter(([e, fp]) => fp !== 'OURKEY' && !known.has(String(e).toLowerCase()) && !keys.has(fp))
      .map(([e]) => e);
  }
  return null;
};
state.own = [{ id: 'g9', members: [
  { email: 'koanmak@phone', fingerprint: 'OURKEY' },
  { email: 'koanmak@gmail.com', fingerprint: '9cadcd4d' },
  { email: 'a@b', fingerprint: 'THEIRS' },
] }];
r = await GL.loadGroups(deps({
  email: 'koanmak@ya.ru',
  aliasesOf: () => ['vault-msg@ya.ru'],
  contacts: [{ email: 'vault-msg@ya.ru', public_key: '9cadcd4d' }],
}));
ok('свой по ключу участник не стал контактом', !r.newContacts.some(c => c.email === 'koanmak@phone'));
ok('дубль известной идентичности (адрес без ключа) не добавлен',
  !r.newContacts.some(c => c.email === 'koanmak@gmail.com'));
ok('неизвестный участник добавлен', r.newContacts.length === 1 && r.newContacts[0].email === 'a@b');
ok('ядро спрошено ОДИН раз для всего списка', padReqs.length === 1);
ok('запрос полный: адрес, fp, алиасы, пары участников и контактов',
  padReqs[0].email === 'koanmak@ya.ru' && padReqs[0].fingerprint === 'FP-ME'
  && padReqs[0].aliases.join(',') === 'vault-msg@ya.ru'
  && padReqs[0].members.length === 3 && padReqs[0].members[1].join('|') === 'koanmak@gmail.com|9cadcd4d'
  && padReqs[0].contacts.length === 1 && padReqs[0].contacts[0].join('|') === 'vault-msg@ya.ru|9cadcd4d');

// 10. Fail-open: мост не ответил — поведение прежнее (сравнение адреса),
// список контактов НЕ теряется.
reset();
globalThis.__invoke = async (cmd) => {
  if (cmd === 'groups_load_own') return state.own;
  if (cmd === 'groups_contacts_to_pad') throw new Error('мост недоступен');
  return null;
};
state.own = [{ id: 'g10', members: [{ email: 'c@d', fingerprint: 'OURKEY' }] }];
r = await GL.loadGroups(deps());
ok('при сбое моста участник добавлен как раньше', r.newContacts.length === 1 && r.newContacts[0].email === 'c@d');

// 11. Пустой ответ ядра — это РЕШЕНИЕ (добавлять некого), а не сбой:
// contacts не пополняются, но и не затираются.
reset();
globalThis.__invoke = async (cmd) => (cmd === 'groups_load_own' ? state.own : []);
state.own = [{ id: 'g11', members: [{ email: 'ghost@x', fingerprint: '9cadcd4d' }] }];
r = await GL.loadGroups(deps({ contacts: [{ email: 'real@x', public_key: '9cadcd4d' }] }));
ok('пустой список от ядра не порождает контактов', r.newContacts.length === 0);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);