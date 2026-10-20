// Набор мутаций: relay-mut
// Цель: убедиться, что смоук relay-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'relay-mut',
  file: 'src/features/relay.js',
  smoke: 'relay-smoke.mjs',
  mutations: [
    { name: "дубли конвертов релея не фильтруются",
      pattern: "    if (seen.has(uid + '|RELAY')) continue;",
      replacement: "    void 0;" },
    { name: "uid релея не помечается папкой RELAY",
      pattern: "      uid,",
      replacement: "      uid: env.id," },
    { name: "from не нормализуется в нижний регистр",
      pattern: "      from: (env.from || '').toLowerCase(),",
      replacement: "      from: (env.from || '')," },
    { name: "тело не кэшируется",
      pattern: "    mailboxStore.cacheBody('RELAY:' + f.uid, f.body);",
      replacement: "    void 0;" },
    { name: "мост вызывается без ctx вызывающего",
      pattern: "  await mailboxApi.processIncoming(fresh, { notify: true }, ctx);",
      replacement: "  await mailboxApi.processIncoming(fresh, { notify: true }, null);" },
    { name: "письма не сортируются по дате",
      pattern: "  merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));",
      replacement: "  void 0;" },
  ],
};
