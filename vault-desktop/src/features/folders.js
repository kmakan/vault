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

// Flag-key of a chat target: group chats by 'group:<id>', DMs by lowercased email.
export function flagKey(target) {
  return target.type === 'group' ? 'group:' + target.id : target.email.toLowerCase();
}

// Flags object of a chat key (always an object, may be empty).
export function chatFlagOf(ctx, key) {
  return ctx.chatFlags[key] || {};
}

// Load chat flags + folder names from sqlite kv (chat-flags, chat-folders).
export async function loadChatFlags(ctx) {
  try {
    const raw = await db.kvGet(ctx.email || 'anon', 'chat-flags');
    ctx.chatFlags = raw ? JSON.parse(raw) : {};
  } catch (e) { ctx.chatFlags = {}; }
  try {
    const fr = await db.kvGet(ctx.email || 'anon', 'chat-folders');
    ctx.chatFoldersNames = fr ? JSON.parse(fr) : [];
  } catch (e) { ctx.chatFoldersNames = []; }
}

// Persist chat flags to sqlite kv (folder/archive/mute of all chats).
export async function saveChatFlags(ctx) {
  try {
    await db.kvSet(ctx.email || 'anon', 'chat-flags', JSON.stringify(ctx.chatFlags));
  } catch (e) { /* kv недоступен — флаги живут в памяти до перезапуска */ }
}

// Assign the chat from the open chat-menu to a folder ('' removes it).
export async function setChatFolder(ctx, name) {
  // Guard: меню могло быть уже закрыто (двойной вызов из шаблона/таймера) —
  // бесшумный no-op вместо падения на target=null.
  if (!ctx.chatMenu || !ctx.chatMenu.target) return;
  const key = flagKey(ctx.chatMenu.target);
  const f = { ...(ctx.chatFlags[key] || {}) };
  if (name) f.folder = name.slice(0, 24);
  else delete f.folder;
  if (!f.archived && !f.muted && !f.folder) delete ctx.chatFlags[key];
  else ctx.chatFlags[key] = f;
  ctx.closeChatMenu();
  await saveChatFlags(ctx);
}

// Create a folder from the dialog input and assign the chat to it.
export async function createChatFolder(ctx) {
  const name = (ctx.chatFolderNewName || '').trim().slice(0, 24);
  if (!name) return;
  if (!ctx.chatFoldersNames.includes(name)) {
    ctx.chatFoldersNames = [...ctx.chatFoldersNames, name];
    await db.kvSet(ctx.email || 'anon', 'chat-folders', JSON.stringify(ctx.chatFoldersNames));
  }
  await setChatFolder(ctx, name);
  ctx.folderDialogOpen = false;
  ctx.chatFolderNewName = '';
}
