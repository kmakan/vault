// Набор мутаций: incoming-mut
// Цель: убедиться, что смоук incoming-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'incoming-mut',
  file: 'src/features/incoming.js',
  smoke: 'incoming-smoke.mjs',
  mutations: [
    // Упавший мост (undefined) — письмо НЕ должно помечаться обработанным.
    { name: "упавший мост классификатора: письмо помечается обработанным",
      pattern: "      if (cls === undefined) return null;",
      replacement: "      if (false) return null;" },
    // ЕДИНСТВЕННЫЙ источник решения «что это за письмо» — classifyPlain
    // (мост в Rust). Бить надо его: правка одного из вызовов не влияет на
    // другие пути (их несколько).
    { name: "решение «что это за письмо» принимает JS, а не Rust",
      pattern: "    return await invoke('vault_classify_incoming', { input: { from, decrypted: plain, date: date || '' } });",
      replacement: "    return { kind: 'message' };" },
    // Свежесть — решение ядра (поле fresh), фронт не имеет права его подменить.
    { name: "свежесть решает JS, а не ядро (старое/неизвестное письмо будит)",
      pattern: "  const fresh = cls.fresh === true;",
      replacement: "  const fresh = true;" },
    { name: "дата письма не уходит в Rust (свежесть считается без неё)",
      pattern: "{ input: { from, decrypted: plain, date: date || '' } }",
      replacement: "{ input: { from, decrypted: plain } }" },
    { name: "окно свежести снова литерал, а не значение из снапшота",
      pattern: "    const windowSecs = snap ? Number(snap.freshSecs) || 0 : 0;",
      replacement: "    const windowSecs = 900;" },
    { name: "отказ моста классификатора глотается (письмо помечается обработанным)",
      pattern: "    return undefined;",
      replacement: "    return null;" },
    { name: "письмо без расшифровки обрабатывается как обычное",
      pattern: "        const plain = await crypto.decryptVault(body);",
      replacement: "        const plain = body;" },
  ],
};
