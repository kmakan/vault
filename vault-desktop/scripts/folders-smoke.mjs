// Node-смоук features/folders.js — флаги чатов и папки.
//
// ПОЧЕМУ СМОУКА НЕ БЫЛО. На папки были только смоуки модуля СОСТОЯНИЯ и
// модуля-владельца; оркестрация (loadChatFlags/saveChatFlags/setChatFolder/
// createChatFolder) не проверялась НИКТО. Именно здесь жила поломка: поля
// `folderDialogOpen` и `chatFolderNewName` вообще не были объявлены в data()
// компонента — присваивание из шаблона нереактивно, и диалог «Новая папка…»
// открывался только при СЛЕДУЮЩЕЙ перерисовке.
//
// ADR-005 W2 (партия 14): модуль не читает компонент — состояние меню и формы
// у владельца форм/модалок (uiStore), email у session-store, флаги/папки у
// владельца folders-store.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/folders-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Моки api/identity ─────────────────────────────────────────────────────
const _kv = new Map();
const dbMock = {
  kvGet: async (ns, k) => (_kv.has(k) ? _kv.get(k) : null),
  kvSet: async (ns, k, v) => { _kv.set(k, v); },
};
globalThis.__dbMock = dbMock;
writeFileSync(MOCKS + '/api.js', 'export const db = globalThis.__dbMock; export default { db };');
writeFileSync(MOCKS + '/identity.js', 'export async function accountNamespace(email){ return "ns:" + String(email||"").toLowerCase(); }\n');

prepareModuleCopy(
  ROOT + '/src/features/folders.js',
  MOCKS + '/folders.mjs',
  {
    '../api.js': 'api.js',
    '../identity.js': 'identity.js',
  },
  MOCKS,
);
const F = await import(MOCKS + '/folders.mjs');
const { foldersStore } = await import(ROOT + '/src/features/folders-store.js');
const { uiStore, sessionStore } = await import(ROOT + '/src/features/session-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Стенд ─────────────────────────────────────────────────────────────────
const state = { closedMenus: 0 };
function resetWorld(over = {}) {
  _kv.clear();
  state.closedMenus = 0;
  foldersStore.clearFlags();
  sessionStore.setCurrentEmail('me@x.ru');
  uiStore.setFormField('chatMenu', { show: false, target: null });
  uiStore.setFormField('chatFolderNewName', '');
  uiStore.setModal('folderDialogOpen', false);
  Object.assign(state, over);
}
const deps = {
  closeChatMenu: () => { state.closedMenus++; uiStore.setFormField('chatMenu', { show: false, target: null }); },
};

// ── 1. loadChatFlags: флаги и имена папок из kv → владелец ───────────────
console.log('1. loadChatFlags: флаги и папки грузятся из kv во владельца');
{
  resetWorld();
  _kv.set('chat-flags', JSON.stringify({ 'peer@x.ru': { archived: true } }));
  _kv.set('chat-folders', JSON.stringify(['Работа']));
  await F.loadChatFlags(deps);
  check('флаг archived загружен во владельца',
    foldersStore.flagOf('peer@x.ru').archived === true, foldersStore.state.chatFlags);
  check('имена папок загружены',
    foldersStore.state.chatFoldersNames.length === 1 && foldersStore.state.chatFoldersNames[0] === 'Работа',
    foldersStore.state.chatFoldersNames);
}

// ── 2. loadChatFlags: битый kv → владелец сброшен, без исключения ───────
console.log('2. loadChatFlags: битый kv → сброс без падения');
{
  resetWorld();
  _kv.set('chat-flags', '{ not json');
  let threw = null;
  try { await F.loadChatFlags(deps); } catch (e) { threw = e; }
  check('битый kv не роняет загрузку', threw === null, threw && String(threw));
  check('флаги сброшены', Object.keys(foldersStore.state.chatFlags).length === 0, foldersStore.state.chatFlags);
}

// ── 3. saveChatFlags: состояние владельца → kv ──────────────────────────
console.log('3. saveChatFlags: состояние владельца сохраняется в kv');
{
  resetWorld();
  foldersStore.setFlag('peer@x.ru', { muted: true });
  await F.saveChatFlags(deps);
  const raw = JSON.parse(_kv.get('chat-flags') || '{}');
  check('флаг сохранён в kv', raw['peer@x.ru'] && raw['peer@x.ru'].muted === true, raw);
}

// ── 4. setChatFolder: чат из меню кладётся в папку ──────────────────────
console.log('4. setChatFolder: чат из меню получает папку, меню закрывается');
{
  resetWorld();
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'contact', email: 'peer@x.ru' } });
  await F.setChatFolder(deps, 'Работа');
  check('папка назначена чату', foldersStore.flagOf('peer@x.ru').folder === 'Работа', foldersStore.state.chatFlags);
  check('меню закрыто', state.closedMenus === 1 && uiStore.getFormField('chatMenu').show === false);
  check('флаги сохранены в kv', !!_kv.get('chat-flags'));
}

// ── 5. setChatFolder: пустая папка → чат остаётся без папки ──────────────
console.log('5. setChatFolder: пустое имя → чат без папки');
{
  resetWorld();
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'contact', email: 'peer@x.ru' } });
  foldersStore.setFlag('peer@x.ru', { folder: 'Работа' });
  await F.setChatFolder(deps, '');
  check('папка снята', !foldersStore.flagOf('peer@x.ru').folder, foldersStore.state.chatFlags);
}

// ── 6. setChatFolder: меню закрыто (двойной вызов) → no-op ──────────────
console.log('6. setChatFolder: меню уже закрыто → тихий no-op');
{
  resetWorld();
  uiStore.setFormField('chatMenu', { show: false, target: null });
  let threw = null;
  try { await F.setChatFolder(deps, 'Работа'); } catch (e) { threw = e; }
  check('без target — не падает', threw === null, threw && String(threw));
  check('ничего не назначено', Object.keys(foldersStore.state.chatFlags).length === 0);
}

// ── 7. createChatFolder: имя из формы, чат получает папку, диалог закрыт ─
console.log('7. createChatFolder: папка создана, чат назначен, диалог закрыт');
{
  resetWorld();
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'contact', email: 'peer@x.ru' } });
  uiStore.setFormField('chatFolderNewName', '  Работа  ');
  uiStore.setModal('folderDialogOpen', true);   // диалог открыт (сценарий пользователя)
  await F.createChatFolder(deps);
  check('имя обрезано от пробелов', foldersStore.state.chatFoldersNames.includes('Работа'), foldersStore.state.chatFoldersNames);
  check('чат назначен в новую папку', foldersStore.flagOf('peer@x.ru').folder === 'Работа', foldersStore.state.chatFlags);
  check('диалог закрыт, имя поля очищено',
    uiStore.getModal('folderDialogOpen') === false && uiStore.getFormField('chatFolderNewName') === '',
    { dialog: uiStore.getModal('folderDialogOpen'), name: uiStore.getFormField('chatFolderNewName') });
  check('имена папок сохранены в kv', !!_kv.get('chat-folders'));
}

// ── 8. createChatFolder: пустое имя → no-op ────────────────────────────
console.log('8. createChatFolder: пустое имя → no-op');
{
  resetWorld();
  uiStore.setFormField('chatFolderNewName', '   ');
  await F.createChatFolder(deps);
  check('папка не создана', foldersStore.state.chatFoldersNames.length === 0, foldersStore.state.chatFoldersNames);
  check('диалог не тронут', uiStore.getModal('folderDialogOpen') === false);
}

// ── 9. Имя длиннее 24 обрезается ────────────────────────────────────────
console.log('9. createChatFolder: имя длиннее 24 символов обрезается');
{
  resetWorld();
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'contact', email: 'peer@x.ru' } });
  uiStore.setFormField('chatFolderNewName', 'x'.repeat(40));
  await F.createChatFolder(deps);
  check('имя обрезано до 24', foldersStore.state.chatFoldersNames[0] && foldersStore.state.chatFoldersNames[0].length === 24,
    foldersStore.state.chatFoldersNames);
}

// ── 10. Архив и mute (чат-меню) ────────────────────────────────────────
console.log('10. toggleArchive / toggleMute: флаг переключается и сохраняется');
{
  resetWorld();
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'contact', email: 'peer@x.ru' } });
  const saved = [];
  const deps2 = { ...deps, saveChatFlags: async () => { saved.push(1); } };
  await F.toggleArchive(deps2, { type: 'contact', email: 'peer@x.ru' });
  const key = F.flagKey({ type: 'contact', email: 'peer@x.ru' });
  check('архив: чат помечен архивным', foldersStore.flagOf(key).archived === true, foldersStore.flagOf(key));
  check('архив: флаг сохранён', saved.length === 1, saved.length);
  await F.toggleArchive(deps2, { type: 'contact', email: 'peer@x.ru' });
  // Владелец удаляет пустой флаг (нет ни archived, ни muted, ни folder) — значит
  // «архив снят» = флага нет или archived не true.
  check('архив: повтор снимает', foldersStore.flagOf(key).archived !== true, foldersStore.flagOf(key));
}
{
  resetWorld();
  const saved = [];
  const deps2 = { ...deps, saveChatFlags: async () => { saved.push(1); } };
  await F.toggleMute(deps2, { type: 'contact', email: 'peer@x.ru' });
  const key = F.flagKey({ type: 'contact', email: 'peer@x.ru' });
  check('mute: чат заглушён', foldersStore.flagOf(key).muted === true, foldersStore.flagOf(key));
  check('mute: флаг сохранён', saved.length === 1, saved.length);
  check('mute: архив не тронут', foldersStore.flagOf(key).archived !== true, foldersStore.flagOf(key));
  // Второе переключение: снимает mute (владелец удаляет пустой флаг) и
  // закрывает меню чата.
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'contact', email: 'peer@x.ru' } });
  await F.toggleMute(deps2, { type: 'contact', email: 'peer@x.ru' });
  check('mute: меню чата закрыто', uiStore.getFormField('chatMenu').show === false, uiStore.getFormField('chatMenu'));
  check('mute: повтор снимает', foldersStore.flagOf(key).muted !== true, foldersStore.flagOf(key));
}
{
  resetWorld();
  const saved = [];
  const deps2 = { ...deps, saveChatFlags: async () => { saved.push(1); } };
  await F.toggleArchive(deps2, { type: 'contact', email: 'peer@x.ru' });
  check('архив: меню чата закрыто', uiStore.getFormField('chatMenu').show === false, uiStore.getFormField('chatMenu'));
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
