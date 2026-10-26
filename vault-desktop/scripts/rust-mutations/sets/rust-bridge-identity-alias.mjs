// ЗАЧЕМ. Очередь моста `t_61bd5090`, пункт 11, и продолжение ADR-005: словарь
// `email-aliases` (`{старый: новый}`) — разбор kv, ЧТЕНИЕ форм адреса и
// ЗАПИСЬ смены почты. Сами правила живут в ядре (`rust-identity`), но ядро
// получает словарь из моста: если мост отдаст пустой, перевёрнутый или
// мусорный словарь, ядро честно построит ответ из неверного входа — и тап по
// известному адресу снова откроет попап «Добавить контакт» (живой регресс
// 24.10, X50), а старые письма «воскресят» прежний адрес пира.
//
// Что измеримо этим набором (всё — через команды `identity_address_variants`,
// `identity_alias_resolutions`, `identity_alias_remember`, значит меряется и
// проводка: какая строка kv читается, чей аккаунт, куда и что пишется):
//   * битый JSON и JSON-не-объект → пустой словарь, а не паника и не мусор;
//   * направление пар old→new (переворот рвёт цепочку с двумя сменами);
//   * неряшливое значение (не строка) роняет ТОЛЬКО эту пару, не весь словарь;
//   * ошибку чтения БД отдаём ошибкой, а не пустым словарём (тот же контракт,
//     что у `settings_flag`: соврать «алиасов нет» хуже, чем вернуть ошибку, а
//     на записи пустой словарь ещё и затёр бы все прежние смены);
//   * правило форм адреса, разрешённый словарь и правило записи не
//     возвращаются в мост (мутанты «мост считает сам»);
//   * запись идёт в строку ЭТОГО аккаунта, под тем же ключом и в том же
//     направлении, а ответ — уже разрешённые строки нового словаря.
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
//     ядра, она измерена в `rust-identity` (`address_variants`, `resolve_alias`,
//     `alias_pairs_after_remember`).
//   * Ошибку `kv_set` при записи не глотаем (`?`), но отдельной мутации нет:
//     отказ записи на хосте не воспроизвести без порчи файла БД, и проба была
//     бы проверкой SQLite, а не правила. Контракт закреплён кодом (`?`).
//
// ИМЕНА ПРОБ (смоук-фильтр `identity_alias_tests` обязан собрать все
// семнадцать; живость фильтра меряет `npm run gate:rust-smokes`, вердикт даёт
// весь либ-прогон):
//   alias_dictionary_absent_reads_as_no_variants
//   alias_dictionary_broken_json_fails_soft_to_the_bare_address
//   alias_dictionary_non_object_json_fails_soft_to_the_bare_address
//   alias_dictionary_walks_two_hops_to_the_fresh_address
//   alias_dictionary_adds_the_stale_address_of_the_same_peer
//   alias_dictionary_non_string_value_keeps_other_pairs
//   alias_dictionary_is_read_for_this_account_only
//   alias_dictionary_unreadable_value_is_an_error_not_an_empty_dictionary
//   alias_resolutions_absent_read_as_empty
//   alias_resolutions_walk_the_chain_to_the_fresh_address
//   alias_resolutions_are_read_for_this_account_only
//   alias_remember_writes_the_dictionary_and_returns_resolutions
//   alias_remember_drops_the_stale_reverse_entry
//   alias_remember_is_idempotent
//   alias_remember_writes_to_this_account_only
//   alias_remember_repairs_a_broken_dictionary
//   alias_remember_read_error_does_not_wipe_the_dictionary

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
    // ── проводка чтения: чья и какая именно строка kv читается ──
    { name: 'словарь читается от "anon", а не от аккаунта (алиасы чужие)',
      pattern: '        .kv_get(account, "email-aliases")',
      replacement: '        .kv_get("anon", "email-aliases")' },
    { name: 'словарь читается по другому ключу (устаревшая форма имени)',
      pattern: '        .kv_get(account, "email-aliases")',
      replacement: '        .kv_get(account, "email_alias")' },
    { name: 'ошибку чтения БД подменяем пустым словарём (фронт не узнает о поломке)',
      pattern: `        .kv_get(account, "email-aliases")
        .map_err(|e| e.to_string())?;`,
      replacement: `        .kv_get(account, "email-aliases")
        .unwrap_or(None);` },
    // ── правило чтения не вернулось в мост ──
    { name: 'правило форм адреса вернулось в мост: ядро не спрашивается',
      pattern: '    Ok(vault_core::identity::address_variants(&aliases, &address))',
      replacement: '    let _ = aliases;\n    Ok(vec![vault_core::identity::normalize(&address)])' },
    { name: 'разрешённый словарь не спрашивает ядро (кэш фронта пуст — резолва нет)',
      pattern: '    Ok(vault_core::identity::alias_resolutions(&aliases))',
      replacement: '    Ok(Vec::new())' },
    // ── запись смены почты: правило ядра и проводка kv ──
    { name: 'запись не читает прежний словарь (смена одного пира стирает остальные)',
      pattern: `    let aliases = alias_dictionary(&db, &account)?;
    let next = vault_core::identity::alias_pairs_after_remember(&aliases, &old_email, &new_email);`,
      replacement: `    let aliases = Vec::new();
    let next = vault_core::identity::alias_pairs_after_remember(&aliases, &old_email, &new_email);` },
    { name: 'правило записи вернулось в мост: анти-цикл A→B→A и нормализация потеряны',
      pattern: '    let next = vault_core::identity::alias_pairs_after_remember(&aliases, &old_email, &new_email);',
      replacement: '    let next = aliases.clone();' },
    { name: 'словарь пишется в "anon", а не в аккаунт (чужие смены и потеря своих)',
      pattern: '        account,\n        "email-aliases",',
      replacement: '        "anon",\n        "email-aliases",' },
    { name: 'словарь пишется под другим ключом (резолв читает прежнюю строку)',
      pattern: '        account,\n        "email-aliases",',
      replacement: '        account,\n        "email_alias",' },
    { name: 'направление пары перевёрнуто при записи (резолв уводит адрес назад)',
      pattern: '        .map(|(from, to)| (from.clone(), serde_json::Value::String(to.clone())))',
      replacement: '        .map(|(from, to)| (to.clone(), serde_json::Value::String(from.clone())))' },
    { name: 'ответ на запись — прежний словарь (фронт не видит только что записанную смену)',
      pattern: '    Ok(vault_core::identity::alias_resolutions(&next))',
      replacement: '    Ok(vault_core::identity::alias_resolutions(&aliases))' },
    { name: 'запись ничего не пишет (команда отвечает успехом, словарь на диске прежний)',
      pattern: `    db.kv_set(
        account,
        "email-aliases",
        &serde_json::Value::Object(obj).to_string(),
    )
    .map_err(|e| e.to_string())`,
      replacement: `    let _ = obj;
    Ok(())` },
  ],
};
