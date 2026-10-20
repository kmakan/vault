// Набор мутаций: contacts-load-mut
// Цель: убедиться, что смоук contacts-load-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'contacts-load-mut',
  file: 'src/features/contacts-load.js',
  smoke: 'contacts-load-smoke.mjs',
  mutations: [
    { name: "себя не исключают из списка контактов",
      pattern: "    let list = (all || []).filter(c => c.email !== email);",
      replacement: "    let list = (all || []).filter(() => true);" },
    { name: "контакты без ключа склеиваются в один",
      pattern: "      if (!k) { byKey.set(c.email, { contact: c, added_at: c.added_at || '' }); continue; }",
      replacement: "      if (!k) { byKey.set(k, { contact: c, added_at: c.added_at || '' }); continue; }" },
    { name: "более новый адрес не становится основным",
      pattern: "      if ((c.added_at || '') >= (prev.added_at || '')) {",
      replacement: "      if (true) {" },
    { name: "при ошибке алиасы заменяются пустым объектом",
      pattern: "    return { contacts: [], contactAliases: null };",
      replacement: "    return { contacts: [], contactAliases: {} };" },
  ],
};
