// Набор мутаций: settings-ui-mut
// Цель: убедиться, что смоук settings-ui-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'settings-ui-mut',
  file: 'src/features/settings-ui.js',
  smoke: 'settings-ui-smoke.mjs',
  mutations: [
    { name: "при выборе провайдера серверы не подставляются (подключение не сработает)",
      pattern: "  deps.setImapServer(p.imap_server);",
      replacement: "  void 0;" },
    { name: "«вручную» не очищает поля (подключимся к чужому серверу)",
      pattern: "    deps.setImapServer('');\n    deps.setImapPort('');",
      replacement: "    void 0;" },
    { name: "выбранная иконка не сохраняется (сбросится при перезапуске)",
      pattern: "  deps.storage().setItem('vault-icon', id);",
      replacement: "  void 0;" },
    { name: "иконка не применяется к нативному окну (в таскбаре старая)",
      pattern: "  api.setAppIcon(id).catch(() => { /* ignore window icon failures */ });",
      replacement: "  void 0;" },
    { name: "эксперимент «звонки» не сохраняется (переживёт перезапуск только в памяти)",
      pattern: "  try { await db.kvSet('anon', 'exp-calls', on ? '1' : '0'); } catch (e) { /* kv недоступен */ }",
      replacement: "  void 0;" },
    { name: "эксперимент всегда выключен (переключатель не работает)",
      pattern: "  deps.setExpCalls(!!on);",
      replacement: "  deps.setExpCalls(false);" },
  ],
};
