// Feature module: chat folders (папки чатов). Stage 1 of the App.vue
// decomposition — pure functions receive the component instance as `ctx`
// instead of `this`, so every dependency is explicit and testable in
// isolation. Stage 2 will move the folder-strip template into FoldersBar.vue.
//
// Storage model: kv 'chat-folders' — список имён папок (chatFoldersNames);
// kv 'chat-flags' — per-chat объект {archived, muted, folder} (chatFlags).
// Папки здесь владеют полем folder; archived/muted читаются этим же модулем
// (единый kv-блоб), но изменяются из chat-меню (App.vue, toggleArchive/Mute).

import { db } from '../api.js';
import { accountNamespace } from '../identity.js';
import { foldersStore } from './folders-store.js';

// Состояние фичи — в ./folders/state.js (чистый модуль без импортов: его
// поднимает check-template.cjs для резолва спреда `...foldersState()`).
// Логика папок, использующая это состояние, — здесь.
// J.7: владелец chatFlags/chatFoldersNames — foldersStore (ADR-004).
// folders.js больше не пишет ctx напрямую — читает/пишет через owner,
// App.vue читает через reactive proxy (computed).
export { foldersState } from './folders/state.js';

// Список имён папок для панели — по алфавиту (чистая функция, App.vue
// делегирует из computed). Сортировка на копии: не мутируем реактивный массив.
export function sortedFolderNames(names) {
  return (names || []).slice().sort((a, b) => a.localeCompare(b));
}

// Flag-key of a chat target: group chats by 'group:<id>', DMs by lowercased email.
export function flagKey(target) {
  return foldersStore.flagKey(target);
}

// Flags object of a chat key (always an object, may be empty).
export function chatFlagOf(ctx, key) {
  return foldersStore.flagOf(key);
}

// Load chat flags + folder names from sqlite kv (chat-flags, chat-folders).
// J.7: пишем в owner, не в ctx.
export async function loadChatFlags(ctx) {
  try {
    const raw = await db.kvGet(await accountNamespace(ctx.email), 'chat-flags');
    const flags = raw ? JSON.parse(raw) : {};
    foldersStore.loadFromRaw(flags, foldersStore.state.chatFoldersNames);
  } catch (e) { foldersStore.loadFromRaw({}, foldersStore.state.chatFoldersNames); }
  try {
    const fr = await db.kvGet(await accountNamespace(ctx.email), 'chat-folders');
    const names = fr ? JSON.parse(fr) : [];
    foldersStore.loadFromRaw(foldersStore.state.chatFlags, names);
  } catch (e) { /* блоб пуст — имена остаются */ }
}

// Persist chat flags to sqlite kv (folder/archive/mute of all chats).
export async function saveChatFlags(ctx) {
  try {
    await db.kvSet(await accountNamespace(ctx.email), 'chat-flags',
      JSON.stringify(foldersStore.state.chatFlags));
  } catch (e) { /* kv недоступен — флаги живут в памяти до перезапуска */ }
}

// Assign the chat from the open chat-menu to a folder ('' removes it).
export async function setChatFolder(ctx, name) {
  // Guard: меню могло быть уже закрыто (двойной вызов из шаблона/таймера) —
  // бесшумный no-op вместо падения на target=null.
  if (!ctx.chatMenu || !ctx.chatMenu.target) return;
  const key = foldersStore.flagKey(ctx.chatMenu.target);
  const f = { ...foldersStore.flagOf(key) };
  if (name) f.folder = name.slice(0, 24);
  else delete f.folder;
  foldersStore.setFlag(key, f);
  ctx.closeChatMenu();
  await saveChatFlags(ctx);
}

// Create a folder from the dialog input and assign the chat to it.
export async function createChatFolder(ctx) {
  const name = (ctx.chatFolderNewName || '').trim().slice(0, 24);
  if (!name) return;
  foldersStore.addFolderName(name);
  await db.kvSet(await accountNamespace(ctx.email), 'chat-folders',
    JSON.stringify(foldersStore.state.chatFoldersNames));
  await setChatFolder(ctx, name);
  ctx.folderDialogOpen = false;
  ctx.chatFolderNewName = '';
}
