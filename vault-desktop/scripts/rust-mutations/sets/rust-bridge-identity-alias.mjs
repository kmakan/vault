// ЗАЧЕМ. Очередь моста `t_61bd5090`, пункт 11: `lib.rs::alias_pairs` — разбор
// kv-словаря `email-aliases` (`{старый: новый}`), и до этого набора ТЕСТА НЕ
// БЫЛО НИ ОДНОГО. Само правило форм адреса измерено в ядре (`rust-identity`),
// но ядро получает словарь из моста: если мост отдаст пустой, перевёрнутый или
// мусорный словарь, ядро честно построит ответ из неверного входа — и тап по
// известному адресу снова откроет попап «Добавить контакт» (живой регресс
// 24.10, X50).
//
// Что измеримо этим набором (всё — через команду `identity_address_variants`,
// значит меряется и проводка: какая строка kv читается и чей аккаунт):
//   * битый JSON и JSON-не-объект → пустой словарь, а не паника и не мусор;
//   * направление пар old→new (переворот рвёт цепочку с двумя сменами);
//   * неряшливое значение (не строка) роняет ТОЛЬКО эту пару, не весь словарь;
//   * ошибку чтения БД подменяем ошибкой, а не пустым словарём (тот же
//     контракт, что у `settings_flag`: соврать «алиасов нет» хуже, чем вернуть
//     ошибку — фронт тогда сохранит показанное состояние);
//   * правило форм адреса не возвращается в мост (мутант «мост считает сам»).
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (не измеримо, а не «забыто»):
//   * ЭКВИВАЛЕНТНЫЕ мутанты ветки «строки в kv нет»: `let Some(s) = raw else
//     { return Vec::new() }` можно переписать в `raw.unwrap_or_default()` или
//     `unwrap_or_else(|| "{}".into())`, и даже в `vec![("".into(), "".into())]`
//     — на результате это НЕ сказывается (пустая пара ядром отбрасывается).
//     Ветка — оптимизация над тем же ответом, а не решение; решать оставляет
//     `rust-identity` в ядре.
//   * ЭКВИВАЛЕНТНЫЙ мутант ветки «JSON не объект» (`None => Vec::new()`):
//     мусор-пара строится из ВСЕЙ строки kv, а она не может совпасть с
//     запрашиваемым адресом, поэтому ядро выдаёт тот же ответ. Убийца этой
//     ветки не мутация, а проба: `alias_dictionary_non_object_json_fails_soft`
//     pin-ит отсутствие паники и отсутствие вариантов (её ловят мутанты разбора).
//   * `alias_pairs` не нормализует ключи и значения: нормализация — обязанность
//     ядра, она измерена в `address_variants_reads_a_dirty_dictionary`.
//
// ИМЕНА ПРОБ (смоук-фильтр `identity_alias_tests` обязан собрать все восемь;
// живость фильтра меряет `npm run gate:rust-smokes`, вердикт даёт весь
// либ-прогон):
//   alias_dictionary_absent_reads_as_no_variants
//   alias_dictionary_broken_json_fails_soft_to_the_bare_address
//   alias_dictionary_non_object_json_fails_soft_to_the_bare_address
//   alias_dictionary_walks_two_hops_to_the_fresh_address
//   alias_dictionary_adds_the_stale_address_of_the_same_peer
//   alias_dictionary_non_string_value_keeps_other_pairs
//   alias_dictionary_is_read_for_this_account_only
//   alias_dictionary_db_error_is_not_replaced_by_empty

export default {
  id: 'rust-bridge-identity-alias',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/lib.rs',
  smoke: 'cargo test -p vault-desktop --lib identity_alias_tests',
  timeoutMs: 900_000,
  mutations: [
    // ── разбор словаря ──
    { name: 'словарь разбирается строго: одна неряшливая пара теряет весь словарь',
      pattern: `    let Ok(value) = serde_json::from_str::<serde_json::Value>(&s) else {
        return Vec::new();
    };
    match value.as_object() {
        Some(map) => map
            .iter()
            .map(|(from, to)| (from.clone(), to.as_str().unwrap_or_default().to_string()))
            .collect(),
        None => Vec::new(),
    }`,
      replacement: `    let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, String>>(&s) else {
        return Vec::new();
    };
    map.into_iter().collect()` },
    { name: 'битый JSON роняет резолв адреса вместо отката к голому адресу',
      pattern: `    let Ok(value) = serde_json::from_str::<serde_json::Value>(&s) else {
        return Vec::new();
    };`,
      replacement: `    let value = serde_json::from_str::<serde_json::Value>(&s).unwrap();` },
    { name: 'старый адрес теряется: обратный ход (строка списка старше ключа) не работает',
      pattern: '            .map(|(from, to)| (from.clone(), to.as_str().unwrap_or_default().to_string()))',
      replacement: '            .map(|(from, to)| (String::new(), to.as_str().unwrap_or_default().to_string()))' },
    { name: 'новый адрес теряется: цепочка old→new никуда не ведёт',
      pattern: '            .map(|(from, to)| (from.clone(), to.as_str().unwrap_or_default().to_string()))',
      replacement: '            .map(|(from, to)| (from.clone(), String::new()))' },
    { name: 'пары перевёрнуты: цепочка читается в обратную сторону',
      pattern: '            .map(|(from, to)| (from.clone(), to.as_str().unwrap_or_default().to_string()))',
      replacement: '            .map(|(from, to)| (to.as_str().unwrap_or_default().to_string(), from.clone()))' },
    // ── проводка команды: чья и какая именно строка kv читается ──
    { name: 'словарь читается от "anon", а не от аккаунта (алиасы чужие)',
      pattern: '        .kv_get(&account, "email-aliases")',
      replacement: '        .kv_get("anon", "email-aliases")' },
    { name: 'словарь читается по другому ключу (устаревшая форма имени)',
      pattern: '        .kv_get(&account, "email-aliases")',
      replacement: '        .kv_get(&account, "email_alias")' },
    { name: 'ошибку чтения БД подменяем пустым словарём (фронт не узнает о поломке)',
      pattern: `        .kv_get(&account, "email-aliases")
        .map_err(|e| e.to_string())?;`,
      replacement: `        .kv_get(&account, "email-aliases")
        .unwrap_or(None);` },
    { name: 'правило форм адреса вернулось в мост: ядро не спрашивается',
      pattern: '    Ok(vault_core::identity::address_variants(&alias_pairs(raw), &address))',
      replacement: '    let _ = raw;\n    Ok(vec![vault_core::identity::normalize(&address)])' },
  ],
};
