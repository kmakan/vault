// Набор мутаций: envelope-rule-mut
// Цель: убедиться, что смоук envelope-rule-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'envelope-rule-mut',
  file: 'src/envelope-rule.js',
  smoke: 'envelope-rule-smoke.mjs',
  mutations: [
    { name: "при отказе моста возвращается «null» строкой (письмо уходит неразборчивым)",
      pattern: "    console.error('[envelope] Rust-сборка конверта недоступна:', e && e.message || e);\n    return null;",
      replacement: "    console.error('[envelope] Rust-сборка конверта недоступна:', e && e.message || e);\n    return 'null';" },
    { name: "ttl уходит строкой (ядро не примет значение)",
      pattern: "      ttl_secs: Number(i.ttlSecs) || 0,",
      replacement: "      ttl_secs: i.ttlSecs || 0," },
    { name: "пустой gavatar уходит пустой строкой вместо null (поле «есть» при пустом значении)",
      pattern: "      gavatar: i.gavatar == null || i.gavatar === '' ? null : String(i.gavatar),",
      replacement: "      gavatar: i.gavatar == null ? null : String(i.gavatar)," },
    { name: "pq_ek всегда null (гибридный ключ теряется)",
      pattern: "      pq_ek: i.pqEk == null || i.pqEk === '' ? null : String(i.pqEk),",
      replacement: "      pq_ek: null," },
    { name: "tok всегда null (собеседник не узнает адрес нашей очереди)",
      pattern: "      tok: i.tok == null || i.tok === '' ? null : String(i.tok),",
      replacement: "      tok: null," },
    { name: "текст конверта теряется (пустое письмо)",
      pattern: "      text: String(i.text == null ? '' : i.text),",
      replacement: "      text: ''," },
  ],
};
