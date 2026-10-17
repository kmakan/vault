// Node-смоук features/folders-store.js — владелец флагов чатов (ADR-004 J.7).
// Проверяет: loadFromRaw, flagOf, setFlag (удаление пустых), flagKey,
// addFolderName/renameFolderName/removeFolderName, clearFlags.
// Запуск: node scripts/folders-store-smoke.mjs
import { createFoldersStore, foldersStore } from '../src/features/folders-store.js';

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

console.log('folders-store (singleton):');
foldersStore.clearFlags();
foldersStore.setFlag('a@x.ru', { archived: true });
ok('setFlag+flagOf', JSON.stringify(foldersStore.flagOf('a@x.ru')) === JSON.stringify({ archived: true }));
ok('flagOf отсутствующего — {}', JSON.stringify(foldersStore.flagOf('nobody@x.ru')) === '{}');
// setFlag с пустым объектом — удаляет запись (как toggleArchive при unarchive+unmute).
foldersStore.setFlag('a@x.ru', { archived: false, muted: false });
ok('setFlag пустым → удаляет', foldersStore.flagOf('a@x.ru') === undefined || Object.keys(foldersStore.flagOf('a@x.ru')).length === 0);
// flagKey: group/channel/email.
ok('flagKey group', foldersStore.flagKey({ type: 'group', id: 'g1' }) === 'group:g1');
ok('flagKey channel', foldersStore.flagKey({ type: 'channel', id: 'c1' }) === 'channel:c1');
ok('flagKey email (lower)', foldersStore.flagKey({ email: 'Peer@X.RU' }) === 'peer@x.ru');
// Имена папок.
foldersStore.addFolderName('Work');
foldersStore.addFolderName('Work'); // дедуп
ok('addFolderName дедуп', foldersStore.state.chatFoldersNames.length === 1);
foldersStore.renameFolder('Work', 'Personal');
ok('renameFolderName', foldersStore.state.chatFoldersNames[0] === 'Personal');
foldersStore.removeFolderName('Personal');
ok('removeFolderName', foldersStore.state.chatFoldersNames.length === 0);
// loadFromRaw.
foldersStore.loadFromRaw({ 'b@x.ru': { muted: true } }, ['Inbox']);
ok('loadFromRaw flags', JSON.stringify(foldersStore.flagOf('b@x.ru')) === JSON.stringify({ muted: true }));
ok('loadFromRaw names', foldersStore.state.chatFoldersNames.length === 1);
foldersStore.clearFlags();
ok('clearFlags чистит всё', Object.keys(foldersStore.state.chatFlags).length === 0 && foldersStore.state.chatFoldersNames.length === 0);

console.log('\nfolders-store (фабрика createFoldersStore):');
const s = createFoldersStore();
s.setFlag('f@x.ru', { archived: true });
// Фабрика делит модульные объекты с singleton (общее хранилище модуля) —
// сознательно: владелец один на приложение. Проверяем API, а не изоляцию.
ok('фабрика пишет через тот же API', s.flagOf('f@x.ru').archived === true);
s.setFlag('f@x.ru', {});
ok('фабрика чистит за собой', Object.keys(s.flagOf('f@x.ru')).length === 0);

console.log(`\n=== ИТОГ: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);