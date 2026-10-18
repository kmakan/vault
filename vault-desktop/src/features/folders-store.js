// Модуль-владелец флагов чатов (ADR-004, Этап A12 / J.7).
// chatFlags: per-chat {archived, muted, folder} — читается в шаблонах/
// computed App.vue, пишется folders.js (setChatFolder/createChatFolder)
// и toggleArchive/Mute. chatFoldersNames — список имён папок.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ в App.data:
// folders.js пишет ctx.chatFlags напрямую (setChatFolder: 4 writes,
// loadChatFlags: 1 write) — 2 модуля (folders.js + App.vue toggleArchive/
// toggleMute) мутируют один и тот же объект. Без owners-посредника
// loadChatFlags может перетереть локальные правки, а saveChatFlags
// сохранить усечённую копию. Владелец центрирует: load → state, writes →
// state, persist → state. App.vue читает через reactive proxy.
//
// Чистый модуль без vue (как chat-store, identity-store): reactive()
// наворачивает корень App.vue.
export function createFoldersStore() {
  const state = {
    chatFlags: {},
    chatFoldersNames: [],
  };
  return {
    state,
    loadFromRaw(rawFlags, rawNames) {
      this.state.chatFlags = rawFlags || {};
      this.state.chatFoldersNames = rawNames || [];
    },
    clearFlags() { this.state.chatFlags = {}; this.state.chatFoldersNames = []; },
    flagOf(key) { return this.state.chatFlags[key] || {}; },
    setFlag(key, f) {
      if (!f || (!f.archived && !f.muted && !f.folder)) delete this.state.chatFlags[key];
      else this.state.chatFlags[key] = f;
    },
    renameFolder(oldName, newName) {
      const names = this.state.chatFoldersNames;
      const i = names.indexOf(oldName);
      if (i < 0) return false;
      if (newName && !names.includes(newName)) names[i] = newName;
      return true;
    },
    addFolderName(name) {
      if (name && !this.state.chatFoldersNames.includes(name)) this.state.chatFoldersNames.push(name);
    },
    removeFolderName(name) {
      const i = this.state.chatFoldersNames.indexOf(name);
      if (i >= 0) this.state.chatFoldersNames.splice(i, 1);
    },
    // chat-меню target → ключ флага (group:/channel:/email).
    flagKey(target) {
      if (target.type === 'group') return 'group:' + target.id;
      if (target.type === 'channel') return 'channel:' + target.id;
      return String(target.email || '').toLowerCase();
    },
  };
}
export const foldersStore = createFoldersStore();