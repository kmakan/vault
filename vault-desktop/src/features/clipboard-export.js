// Копирование и экспорт переписки — ADR-005 W3.
//
// Логика вынесена из App.vue: «скопировать сообщение» и «выгрузить чат» —
// это операции над данными, а не поведение компонента. Пять входных точек
// (копировать текст, копировать с цитатой, копировать целиком, экспорт в
// JSON, экспорт в TXT) отличаются только источником данных и форматом.
//
// deps (ADR-001 R3):
//   copyTextToClipboard(text) — буфер обмена (features/clipboard.js)
//   alert(msg) / tr(key)      — обратная связь (переводы)
//   replyBody(content)         — текст с цитатой (features/message-format.js)
//   messages / activeChat      — что экспортируем
//   exportChatJSON / exportChatTXT — сборка выгрузки (src/chatExport.js)
//   downloadFile(data, name, mime) — сохранение файла
//   closeExportMenu()          — закрыть меню экспорта

// Скопировать текст в буфер обмена. Возвращает true, если скопировано.
export async function copyText(deps, text) {
  if (await deps.copyTextToClipboard(text)) {
    deps.alert(deps.tr('copied') || 'Скопировано');
    return true;
  }
  deps.alert(deps.tr('copy_failed') || 'Не удалось скопировать');
  return false;
}

// Скопировать сообщение с цитатой (как оно выглядит в чате).
export async function copyMessageText(deps, msg) {
  if (!msg) return false;
  return copyText(deps, deps.replyBody(msg.content || ''));
}

// Скопировать сообщение целиком (без цитаты).
export async function copyMessageAll(deps, msg) {
  if (!msg) return false;
  return copyText(deps, msg.content || '');
}

// Выгрузить чат в JSON.
export function exportAsJSON(deps) {
  const json = deps.exportChatJSON(deps.messages(), deps.activeChat());
  deps.downloadFile(json, `vault-${deps.activeChat()}-${Date.now()}.json`, 'application/json');
  deps.closeExportMenu();
}

// Выгрузить чат в TXT.
export function exportAsTXT(deps) {
  const txt = deps.exportChatTXT(deps.messages(), deps.activeChat());
  deps.downloadFile(txt, `vault-${deps.activeChat()}-${Date.now()}.txt`, 'text/plain');
  deps.closeExportMenu();
}
