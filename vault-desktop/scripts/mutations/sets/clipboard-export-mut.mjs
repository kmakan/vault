// Набор мутаций: clipboard-export-mut
// Цель: убедиться, что смоук clipboard-export-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'clipboard-export-mut',
  file: 'src/features/clipboard-export.js',
  smoke: 'clipboard-export-smoke.mjs',
  mutations: [
    { name: "сбой буфера не показывается (пользователь думает, что скопировано)",
      pattern: "  deps.alert(deps.tr('copy_failed') || 'Не удалось скопировать');",
      replacement: "  void 0;" },
    { name: "успешное копирование не показывается (нет обратной связи)",
      pattern: "    deps.alert(deps.tr('copied') || 'Скопировано');",
      replacement: "    void 0;" },
    { name: "копирование сообщения берёт сырой текст вместо цитаты",
      pattern: "  return copyText(deps, deps.replyBody(msg.content || ''));",
      replacement: "  return copyText(deps, msg.content || '');" },
    { name: "копирование целиком берёт цитату вместо сырого текста",
      pattern: "  return copyText(deps, msg.content || '');",
      replacement: "  return copyText(deps, deps.replyBody(msg.content || ''));" },
    { name: "копирование без сообщения копирует пустоту (в буфере «пусто»)",
      pattern: "  if (!msg) return false;\n  return copyText(deps, deps.replyBody(msg.content || ''));",
      replacement: "  return copyText(deps, deps.replyBody((msg && msg.content) || ''));" },
    { name: "экспорт JSON сохраняет не тот тип файла",
      pattern: "  deps.downloadFile(json, `vault-${deps.activeChat()}-${Date.now()}.json`, 'application/json');",
      replacement: "  deps.downloadFile(json, `vault-${deps.activeChat()}-${Date.now()}.json`, 'text/plain');" },
    { name: "экспорт TXT сохраняет не тот тип файла",
      pattern: "  deps.downloadFile(txt, `vault-${deps.activeChat()}-${Date.now()}.txt`, 'text/plain');",
      replacement: "  deps.downloadFile(txt, `vault-${deps.activeChat()}-${Date.now()}.txt`, 'application/json');" },
    // closeExportMenu() одинаков в exportAsJSON и exportAsTXT: без якоря
    // мутировался только JSON-сайт, TXT-путь оставался неизмеренным.
    { name: "экспорт JSON не закрывает меню (меню остаётся поверх чата)",
      pattern: "  deps.downloadFile(json, `vault-${deps.activeChat()}-${Date.now()}.json`, 'application/json');\n  deps.closeExportMenu();",
      replacement: "  deps.downloadFile(json, `vault-${deps.activeChat()}-${Date.now()}.json`, 'application/json');\n  void 0;" },
    { name: "экспорт TXT не закрывает меню (меню остаётся поверх чата)",
      pattern: "  deps.downloadFile(txt, `vault-${deps.activeChat()}-${Date.now()}.txt`, 'text/plain');\n  deps.closeExportMenu();",
      replacement: "  deps.downloadFile(txt, `vault-${deps.activeChat()}-${Date.now()}.txt`, 'text/plain');\n  void 0;" },
    { name: "экспорт выгружает не тот чат (имя файла не совпадает с чатом)",
      pattern: "  const json = deps.exportChatJSON(deps.messages(), deps.activeChat());",
      replacement: "  const json = deps.exportChatJSON(deps.messages(), 'other');" },
  ],
};
