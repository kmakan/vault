// Набор мутаций: notify-mut
// Цель: убедиться, что смоук notify-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'notify-mut',
  file: 'src/notify.js',
  smoke: 'notify-smoke.mjs',
  mutations: [
    { name: "выключенные пользователем уведомления всё равно отправляются",
      pattern: "  if (!notificationsEnabled()) { console.log('[notify] SKIP: disabled by setting'); return false; }",
      replacement: "  if (false) { console.log('[notify] SKIP: disabled by setting'); return false; }" },
    { name: "без разрешения ОС уведомление отправляется (молчаливый отказ)",
      pattern: "  if (!permissionReady) { console.log('[notify] SKIP: permission not ready'); return false; }",
      replacement: "  if (false) { console.log('[notify] SKIP: permission not ready'); return false; }" },
    { name: "дедуп по id отключён (одно письмо уведомляет дважды)",
      pattern: "  if (id != null && notifiedIds.has(String(id))) { console.log('[notify] SKIP: already notified id=' + id); return false; }",
      replacement: "  if (false) { console.log('[notify] SKIP: already notified id=' + id); return false; }" },
    { name: "окно тишины по чату отключено (спам уведомлениями)",
      pattern: "    if (Date.now() - last < CHAT_WINDOW_MS) {",
      replacement: "    if (false) {" },
    { name: "отправленное письмо не запоминается (дедуп не переживает перезапуск)",
      pattern: "    notifiedIds.add(String(id));",
      replacement: "    void 0;" },
    { name: "заголовок без имени подставляется как пустая строка",
      pattern: "    const opts = { title: title || 'Vault', body: body || '' };",
      replacement: "    const opts = { title: title || '', body: body || '' };" },
    { name: "выключение уведомлений не сохраняется",
      pattern: "    localStorage.setItem(ENABLED_KEY, on ? 'true' : 'false');",
      replacement: "    localStorage.setItem(ENABLED_KEY, 'true');" },
  ],
};
