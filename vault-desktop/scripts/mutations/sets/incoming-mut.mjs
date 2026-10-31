// Набор мутаций: incoming-mut
// Цель: убедиться, что смоук incoming-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// САЙТЫ (разделка 25.10, переякорь 31.10). Охрана «мост упал — письмо не
// трогаем» написана ОДИНАКОВОЙ строкой в местах роутера: каналы, группы,
// ветка «смена почты»; в 1:1 — та же проверка без комментария. Движок берёт
// ПЕРВОЕ совпадение, поэтому каждый паттерн заякорен следующей строкой —
// иначе набор мерил только одно место, а остальные пути жили без проверки.
// Смысл разницы: без охраны отказ классификатора («мы не знаем, что это»)
// ведёт себя как «не наше» — письмо считается/переименовывается по результату,
// которого не было.

export default {
  id: 'incoming-mut',
  file: 'src/features/incoming.js',
  smoke: 'incoming-smoke.mjs',
  mutations: [
    // Упавший мост (undefined) — письмо НЕ должно помечаться обработанным.
    { name: "упавший мост в 1:1: письмо помечается обработанным",
      pattern: "      if (cls === undefined) return null;\n      fresh = cls ? cls.fresh === true : false;",
      replacement: "      if (false) return null;\n      fresh = cls ? cls.fresh === true : false;" },
    // 31.10: мутация «упавший мост при смене почты» СНЯТА — не из-за дыры в
    // смоуке, а потому что стала ЭКВИВАЛЕНТНОЙ: перебор ключей в ветке убран
    // (один вызов книги), и при cls=undefined снятый guard ничего не наблюдает
    // — env остаётся null, ренейм не запускается, итог ровно прежний
    // «письмо не трогаем». Охрана в коде оставлена как контракт с будущими
    // вставками, но мерить её мутацией больше нечего. Защита «мост упал»
    // по-прежнему меряется в 1:1, канале, группе и на ядре (rust-listen-decrypt).
    { name: "упавший мост в канале: письмо пробуется на группах",
      pattern: "        if (cls === undefined) return null; // мост упал — письмо не трогаем\n        if (!cls || cls.kind !== 'channel') continue;",
      replacement: "        if (false) return null; // мост упал — письмо не трогаем\n        if (!cls || cls.kind !== 'channel') continue;" },
    { name: "упавший мост в группе: проверяется следующая группа",
      pattern: "        if (cls === undefined) return null; // мост упал — письмо не трогаем\n        fresh = cls ? cls.fresh === true : false;",
      replacement: "        if (false) return null; // мост упал — письмо не трогаем\n        fresh = cls ? cls.fresh === true : false;" },
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
      // 31.10: расшифровка переехала в `crypto.decryptLetter` (книга ключей),
      // а plain читается из итога. Мутация подсовывает классификатору сырое
      // тело вместо открытого текста — путь обязан погибнуть на смоуке.
      pattern: "      const plain = opened.plain;",
      replacement: "      const plain = body;" },
  ],
};
