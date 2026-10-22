// ADR-004 J.4 + ADR-005 R3 — мост фоновых циклов (релей/поллинг/IDLE)
// и прикладного уровня.
//
// Раньше мост собирал `deps` второй копией (makeCtx) и передавал её фичам
// ctx-конвенцией — три регрессии «контракт в двух местах» (см. ADR-004 §J.4).
// Теперь мост — ТОНКИЙ ПОРТ: он не собирает deps и не импортирует фичи.
// Прикладной уровень (App.vue) РЕГИСТРИРУЕТ явный узкий набор операций
// (владелец) — и мост только переадресует вызовы. Зависимость объявлена
// явно (список ниже), а не через весь ctx/App.
//
// Если владелец не зарегистрирован — бросаем громко, а не деградируем
// молча (ADR-004 §5 «без ctx → явная ошибка»).

let owner = null;

export function setOwner(o) { owner = o; }

function need() {
  if (!owner) {
    throw new Error('[mailbox-api] владелец не зарегистрирован: App.vue должен вызвать mailboxApi.setOwner(...) в created()');
  }
  return owner;
}

export const mailboxApi = {
  setOwner,

  processIncoming(fetched, opts) {
    return need().processIncoming(fetched, opts);
  },
  loadMessages(email) {
    return need().loadMessages(email);
  },
  loadEmails(silent = false) {
    return need().loadEmails(silent);
  },
  loadGroups() {
    return need().loadGroups();
  },
  loadGroupMessages(groupId, forceRescan = false) {
    return need().loadGroupMessages(groupId, forceRescan);
  },
  loadCursors(accountId) {
    return need().loadCursors(accountId);
  },
  saveCursors(accountId, cursors) {
    return need().saveCursors(accountId, cursors);
  },
  cacheBody(key, body) {
    return need().cacheBody(key, body);
  },
  scrollToBottom(force = false) {
    return need().scrollToBottom(force);
  },
};

export default mailboxApi;
