// Node-смоук features/contacts-store.js — владелец contacts/ignoredUsers (ADR-004 J.5a/J.7).
//
// ЧТО ЗДЕСЬ БЫЛО СЛОМАНО. Первая версия этого смоука подменяла импорт в
// НАСТОЯЩЕМ файле src/features/contacts-load.js, а в finally писала «оригинал»
// обратно. Оригинал читался ДО подмены, поэтому второй запуск (или прерванный
// первый) читал уже подменённый файл как оригинал — и путь на мок
// /tmp/contacts-store-smoke-mocks/api.js остался в исходнике навсегда.
//
// Цена: rolldown разрешил абсолютный путь, вшил мок в продовый бандл
// (`getContacts: async () => []`) — контакты в приложении стали пустыми, а
// сборка и гейты молчали. Поэтому копия модуля делается только через общий
// хелпер (prepareModuleCopy), а запись в src/ из скриптов запрещена гейтом
// scripts/src-integrity-gate.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = '/home/maksim/whisper/vault-desktop';
const MOCKS = '/tmp/contacts-store-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// Моки пишутся в /tmp и подставляются в КОПИИ модулей. Спецификатор в карте
// обязан совпадать с исходником буквально ('../api.js', а не 'api.js').
writeFileSync(MOCKS + '/api.js',
  'export default { getContacts: async () => [], getEmailBody: async () => null, saveCursors: async () => {} };\n');
writeFileSync(MOCKS + '/session-store.js',
  'export const sessionStore = { getCurrentEmail: () => "me@x.ru" };\n');
// contacts-load зовёт мост и crypto — в этом смоуке они не проверяются,
// но копия обязана загружаться: даём нейтральные заглушки (мост «ничего не
// убрал», crypto «ключа нет» — фильтр then падает на прежнюю строку).
writeFileSync(MOCKS + '/core.js',
  'export const invoke = async () => null;\n');
writeFileSync(MOCKS + '/crypto.js',
  'export default { publicKey: "", fingerprint: async () => "" };\n');

// contacts-load копируется, чтобы contacts-store получил его мок-версию:
// сам contacts-load здесь не проверяется (для него есть contacts-load-smoke).
prepareModuleCopy(
  ROOT + '/src/features/contacts-load.js',
  MOCKS + '/contacts-load.js',
  {
    '../api.js': 'api.js',
    '@tauri-apps/api/core': 'core.js',
    '../crypto.js': 'crypto.js',
  },
  MOCKS,
);
prepareModuleCopy(
  ROOT + '/src/features/contacts-store.js',
  MOCKS + '/contacts-store.mjs',
  { './session-store.js': 'session-store.js', './contacts-load.js': 'contacts-load.js' },
  MOCKS,
);

const mod = await import(MOCKS + '/contacts-store.mjs');
const createContactsStore = mod.createContactsStore;
const contactsStore = mod.contactsStore;
let pass = 0, fail = 0;
const ok = (l, c, x) => { if (c) { pass++; console.log('  ' + '✓ ' + l); } else { fail++; console.log('  ' + '✗ ' + l + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')); } };
console.log('contacts-store (singleton):');
contactsStore.reset();
contactsStore.setIgnored({ 'a@x.ru': 1700000000000, 'b@x.ru': 1700000001000 });
ok('setIgnored', Object.keys(contactsStore.state.ignoredUsers).length === 2);
ok('ignoredUsers читается', contactsStore.state.ignoredUsers['a@x.ru'] === 1700000000000);
contactsStore.clearIgnored();
ok('clearIgnored', Object.keys(contactsStore.state.ignoredUsers).length === 0);
contactsStore.setIgnored(null);
ok('setIgnored(null) -> {}', Object.keys(contactsStore.state.ignoredUsers).length === 0);
contactsStore.setLastSeen('c@x.ru', 123);
ok('setLastSeen', contactsStore.getLastSeen('c@x.ru') === 123);
ok('getLastSeen отсутствующего = 0', contactsStore.getLastSeen('nobody@x.ru') === 0);
contactsStore.reset();
ok('reset чистит ignoredUsers', Object.keys(contactsStore.state.ignoredUsers).length === 0);
ok('reset чистит lastSeenMap', Object.keys(contactsStore.state.lastSeenMap).length === 0);
console.log('\ncontacts-store (фабрика createContactsStore):');
const s = createContactsStore();
s.setIgnored({ 'f@x.ru': 1 });
ok('фабрика пишет через тот же API', s.state.ignoredUsers['f@x.ru'] === 1);
s.clearIgnored();
ok('фабрика чистит за собой', Object.keys(s.state.ignoredUsers).length === 0);
console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
