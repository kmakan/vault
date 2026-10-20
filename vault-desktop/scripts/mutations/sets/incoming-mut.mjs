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
      pattern: "    return await invoke('vault_classify_incoming', { input: { from, decrypted: plain } });",
      replacement: "    return { kind: 'message' };" },
    { name: "отказ моста классификатора глотается (письмо помечается обработанным)",
      pattern: "    return undefined;",
      replacement: "    return null;" },
    { name: "письмо без расшифровки обрабатывается как обычное",
      pattern: "        const plain = await crypto.decryptVault(body);",
      replacement: "        const plain = body;" },
  ],
};
