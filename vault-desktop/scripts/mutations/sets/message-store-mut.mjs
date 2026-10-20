// Набор мутаций: message-store-mut
// Цель: убедиться, что смоук message-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'message-store-mut',
  file: 'src/message-store.js',
  smoke: 'message-store-smoke.mjs',
  mutations: [
    { name: "незакреплённое возвращается как пустой объект (рисуется «закреплено» всегда)",
      pattern: "    return raw ? JSON.parse(raw) : null;",
      replacement: "    return raw ? JSON.parse(raw) : {};" },
    { name: "битый JSON роняет чтение (исключение наружу)",
      pattern: "  } catch (e) {\n    return null;\n  }",
      replacement: "  } catch (e) {\n    throw e;\n  }" },
    { name: "качество медиа по умолчанию — не high",
      pattern: "  try { return (await db.kvGet('anon', 'media-quality')) || 'high'; } catch { return 'high'; }",
      replacement: "  try { return (await db.kvGet('anon', 'media-quality')) || 'low'; } catch { return 'high'; }" },
    { name: "сбой чтения ломает fail-open (исключение наружу)",
      pattern: "  try { return (await db.kvGet('anon', 'media-quality')) || 'high'; } catch { return 'high'; }",
      replacement: "  return (await db.kvGet('anon', 'media-quality')) || 'high';" },
    { name: "TTL не-числом превращается в 0 корректно (а не NaN)",
      pattern: "    return Number(v) || 0;",
      replacement: "    return Number(v);" },
    { name: "TTL читается из чужого ключа",
      pattern: "    const v = await db.kvGet('anon', 'ephemeral:' + chatId);",
      replacement: "    const v = await db.kvGet('anon', 'ephemeral:');" },
  ],
};
