// Набор мутаций: bounce-mut
// Цель: убедиться, что смоук bounce-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'bounce-mut',
  file: 'src/features/bounce.js',
  smoke: 'bounce-smoke.mjs',
  mutations: [
    { name: "баунс не распознаётся по почтальону (вызов не отменяется)",
      pattern: "  return DAEMON_RE.test(f) || DSN_SUBJECT_RE.test(s);",
      replacement: "  return DSN_SUBJECT_RE.test(s);" },
    { name: "баунс не распознаётся по теме (письмо-отчёт не отменяет вызов)",
      pattern: "  return DAEMON_RE.test(f) || DSN_SUBJECT_RE.test(s);",
      replacement: "  return DAEMON_RE.test(f);" },
    { name: "адресат не извлекается из Final-Recipient",
      pattern: "  if (final) found.push(final[1]);",
      replacement: "  if (final) { /* пропущено */ }" },
    { name: "адресат не извлекается из X-Failed-Recipients",
      pattern: "    if (list) found.push(...list);",
      replacement: "    if (list) { /* пропущено */ }" },
    { name: "адреса не нормализуются в нижний регистр (сравнение с адресом пира не сойдётся)",
      pattern: "    const v = String(item || '').trim().toLowerCase();",
      replacement: "    const v = String(item || '').trim();" },
    { name: "дубли адресов не убираются (вызов отменяется дважды)",
      pattern: "    if (!v || seen.has(v)) continue;",
      replacement: "    if (!v) continue;" },
    // Тело БЕЗ SMTP-кода и без Status: иначе сработает запасной путь и
    // мутация будет замаскирована (тот же класс, что «два инварианта в одном
    // сценарии»).
    { name: "причина отбоя не берётся из Diagnostic-Code (в логе пусто)",
      pattern: "  if (diag) return squash(diag[1]);",
      replacement: "  if (false) return squash(diag[1]);" },
    { name: "причина отбоя не берётся из SMTP-кода",
      pattern: "  if (smtp) return squash(smtp[0]);",
      replacement: "  if (false) return squash(smtp[0]);" },
  ],
};
