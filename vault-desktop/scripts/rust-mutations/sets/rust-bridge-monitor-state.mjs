// ЗАЧЕМ. Очередь моста `t_61bd5090`, пункт 13: `service_monitor.rs` — 1509
// строк, целиком запертых в `#[cfg(target_os = "android")]`. С хоста он НЕ
// КОМПИЛИРУЕТСЯ, значит ни один тест и ни одна мутация до него не доходила:
// проводка, которая решает «пришли ли уведомления при смахнутом приложении»,
// измерялась только приёмкой на телефоне. С 26.10 состояние монитора живёт в
// `src/monitor_state.rs` (без cfg) и `service_monitor.rs` ему делегирует —
// здесь измеряется именно эта проводка.
//
// Что теперь измеримо:
//   * адреса kv-строк (`notify_seen` / `notify_pending` / `call_state`) — контракт
//     с состоянием, уже лежащим на устройстве: переименование после обновления
//     = «уведомления пришли заново», «отклонённый звонок звонит снова»;
//   * отсечка seen-списка (что уходит старое, а не новое, и повтор не плодится);
//   * порядок pending-очереди и удаление по имени (drain берёт ПЕРВУЮ запись);
//   * пре-фильтры ingest: свежесть по Date, синтетический ключ без Message-ID,
//     нормализация отправителя, сброс попыток, защита от дубля;
//   * машина состояний звонка: guard пустого call_id, TTL-чистка надгробий,
//     «пустое имя не стирает известное», продление updated_at;
//   * распознавание группового приглашения (folding, urlSafe-алфавит, padding,
//     значение kind);
//   * с 26.10 сюда же вынесены правила, которые раньше жили только под
//     cfg(android) и потому не измерялись ничем: вывод публичного ключа для
//     эхо-защиты, отпечаток ключа для лога, маркер «нашего» конверта, ПОРЯДОК
//     перебора ключей при расшифровке, «отправитель не из контактов — не
//     ретраить», лимит попыток, путь к monitor.db и правило текста уведомления
//     (обычное письмо, group-invite, пропущенный звонок, SOS).
//
// ЧТО ПРОБА НАШЛА СРАЗУ. Первый же прогон предъявил живой дефект перенесённого
// кода: перевод алфавита был записан как `replace(['-', '_'], "+/")`, а паттерн
// из символов подставляет ВСЮ строку на каждый совпавший символ (проверено
// rustc: `a-b_c` → `a+/b+/c`). Приглашение, в конверте которого встретился `-`
// или `_`, портится на глазах и не распознаётся — при смахнутом приложении
// пуша нет, письмо молча уходит в Dead. JS-версия правила (`api.js::b64urlDecode`)
// делает два отдельных replace и потому была права: вторая копия одного правила
// разъехалась, и заметил это только тест, которого у этой копии не было.
// Фикстура в пробе САМОПРОВЕРЯЮЩАЯСЯ (содержит urlSafe-символ и не кратна 4) —
// иначе она молча позеленела бы на удобном теле, как было до правки.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (не измеримо с хоста, а не «забыто»):
//   * JNI-обёртки, сам показ уведомления, IMAP-цикл с его pacing (2s/5s/
//     7s/60×200ms), пауза при открытой activity, SMTP-транспорт и логи —
//     всё это остаётся в `service_monitor.rs` под cfg(android); с 26.10 модуль
//     исключён из гейта плотности с этим списком остатка, а не «на всякий
//     случай»: измеряется всё, что работает без JNI;
//   * сами числа окон и предикаты (`SEEN_CAP`, `CALL_TOMBSTONE_MS`,
//     `RING_TIMEOUT_MS`, `date_fresh`, `record_survives`, `normalize`) — измерены
//     в ядре (`vault::timings`, `vault::call_record`, `vault::identity`); здесь
//     мутируется только ПРОВОДКА: что куда передаётся и в каком порядке.
//   * `MAX_TRIES` больше не в этом списке: решение «сдаться на третьей» теперь
//     живёт здесь функцией `retry_effect`, и потребитель (`drain_pending`)
//     лишь спрашивает её — так ветка измеряется, а не проверяется приёмкой.
//
// ИМЕНА ПРОБ (смоук `monitor_state` обязан собрать все тридцать):
//   kv_rows_keep_the_names_written_by_the_older_build
//   seen_roundtrip_reads_back_the_key_it_wrote
//   seen_is_per_account
//   seen_push_does_not_repeat_a_message_id
//   seen_keeps_the_newest_and_drops_the_oldest
//   broken_seen_row_is_empty_list_not_a_crash
//   pending_preserves_order_and_tries
//   remove_pending_drops_only_the_named_message
//   ingest_queues_a_fresh_message_and_counts_no_tries
//   ingest_skips_stale_by_date
//   ingest_makes_a_synthetic_key_when_message_id_missing
//   ingest_stores_sender_in_canonical_form
//   ingest_ignores_seen_and_already_queued
//   call_state_roundtrip_and_tombstone
//   empty_call_id_creates_no_state
//   state_transition_moves_the_clock_of_an_old_record
//   later_update_without_name_keeps_the_known_caller
//   group_invite_is_detected_through_folding_and_urlsafe_alphabet
//   public_key_is_derived_by_the_formula_the_echo_guard_relies_on
//   unreadable_private_key_derives_nothing
//   log_fingerprint_is_sixteen_chars_and_never_panics_on_short_input
//   envelope_marker_is_the_integer_one_and_nothing_else
//   decrypt_order_tries_sender_then_self_then_the_rest_without_the_sender
//   sender_absent_from_contacts_never_retries
//   three_failed_attempts_and_the_letter_is_dropped_for_good
//   monitor_database_is_the_one_file_the_cursor_lives_in
//   group_invite_notice_names_the_sender_and_the_action
//   missed_call_notice_is_one_phrase_for_both_sites
//   notice_for_an_ordinary_message_prefers_the_name_and_never_shows_empty
//   sos_notice_is_marked_up_even_when_the_sender_sent_holes

export default {
  id: 'rust-bridge-monitor-state',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/monitor_state.rs',
  smoke: 'cargo test -p vault-desktop --lib monitor_state',
  timeoutMs: 900_000,
  mutations: [
    // ── адреса kv-строк: состояние, уже лежащее на устройстве ──
    { name: 'seen переезжает на новое имя (после обновления дедуп пуст — письма уведомляются заново)',
      pattern: '    "notify_seen".to_string()',
      replacement: '    "notifySeen".to_string()' },
    { name: 'pending переезжает на новое имя (очередь доставки после обновления пуста)',
      pattern: '    "notify_pending".to_string()',
      replacement: '    "pendingNotify".to_string()' },
    { name: 'таблица звонков переезжает на новое имя (надгробия теряются — звонок звонит снова)',
      pattern: '    "call_state".to_string()',
      replacement: '    "callStates".to_string()' },

    // ── seen-дедуп: отсечка и повтор ──
    { name: 'отсечка seen снимается (список растёт бесконечно)',
      pattern: '    let cut = dedup_cut(list.len(), SEEN_CAP);',
      replacement: '    let cut = 0;' },
    { name: 'отсечка отрезает всё (дедуп ничего не помнит — уведомления дублируются)',
      pattern: '    let cut = dedup_cut(list.len(), SEEN_CAP);',
      replacement: '    let cut = list.len();' },
    { name: 'лимит отсечки завышен (held-размер не совпадает с контрактом ядра)',
      pattern: '    let cut = dedup_cut(list.len(), SEEN_CAP);',
      replacement: '    let cut = dedup_cut(list.len(), SEEN_CAP + 5);' },
    { name: 'новое Message-ID встаёт в начало списка — отсечка съедает его же',
      pattern: '    list.push(mid.to_string());',
      replacement: '    list.insert(0, mid.to_string());' },
    { name: 'повтор Message-ID записывается второй раз (seen раздувается дублями)',
      pattern: `    let mut list: Vec<String> = kv_json(db, account, &seen_key());
    if list.iter().any(|x| x == mid) {
        return;
    }`,
      replacement: `    let mut list: Vec<String> = kv_json(db, account, &seen_key());` },
    { name: 'битая строка kv роняет монитор вместо пустого дедупа',
      pattern: '        .unwrap_or_default()',
      replacement: '        .expect("строка kv обязана быть читаемой")' },

    // ── pending-очередь: порядок и удаление по имени ──
    { name: 'remove_pending удаляет другую запись (по совпадению, а не по имени)',
      pattern: '    let kept: Vec<PendingEntry> = list.into_iter().filter(|e| e.mid != mid).collect();',
      replacement: '    let kept: Vec<PendingEntry> = list.into_iter().filter(|e| e.mid == mid).collect();' },
    { name: 'remove_pending не удаляет ничего (письмо доставлено, но остаётся в очереди)',
      pattern: '    let kept: Vec<PendingEntry> = list.into_iter().filter(|e| e.mid != mid).collect();',
      replacement: '    let kept: Vec<PendingEntry> = list;' },
    { name: 'очередь читается в обратном порядке (drain берёт не то письмо первым)',
      pattern: '    kv_json(db, account, &pending_key())\n}',
      replacement: '    let mut list: Vec<PendingEntry> = kv_json(db, account, &pending_key());\n    list.reverse();\n    list\n}' },

    // ── ingest: пре-фильтры нового письма ──
    { name: 'старьё по дате проходит в очередь (приложение будит уведомлениями за прошлые недели)',
      pattern: '    if !date_fresh(&m.date) {',
      replacement: '    if false {' },
    { name: 'свежее письмо отбрасывается как несвежее (уведомлений нет вовсе)',
      pattern: '    if !date_fresh(&m.date) {',
      replacement: '    if date_fresh(&m.date) {' },
    { name: 'синтетический ключ теряет uid (письма без Message-ID сливаются в одно)',
      pattern: '        format!("{}|{}|{}", m.from, m.folder, m.id)',
      replacement: '        format!("{}|{}", m.from, m.folder)' },
    { name: 'синтетический ключ теряет отправителя (письма разных людей в одной папке сливаются)',
      pattern: '        format!("{}|{}|{}", m.from, m.folder, m.id)',
      replacement: '        format!("{}|{}", m.folder, m.id)' },
    { name: 'отправитель кладётся в очередь как есть (письмо «с пробелом» не находит ключ контакта)',
      pattern: '        from: identity::normalize(&m.from),',
      replacement: '        from: m.from.clone(),' },
    { name: 'новое письмо встаёт в очередь с уже потраченными попытками',
      pattern: '        tries: 0,',
      replacement: '        tries: 1,' },
    { name: 'дубль в очереди не отбрасывается (одно письмо уведомляет дважды)',
      pattern: '    if list.iter().any(|e| e.mid == message_id) {\n        return; // уже в очереди\n    }',
      replacement: '    if false {\n        return;\n    }' },
    { name: 'доставленное письмо не проверяется по seen (уведомление повторяется)',
      pattern: '    if seen_contains(db, account, &message_id) {\n        return;\n    }',
      replacement: '    if false {\n        return;\n    }' },

    // ── машина состояний звонка ──
    { name: 'пустой call_id порождает запись (в таблице висит «звонок без идентификатора»)',
      pattern: '    if call_id.is_empty() {\n        return;\n    }',
      replacement: '    if false {\n        return;\n    }' },
    { name: 'надгробия не чистятся при сохранении (таблица звонков растёт вечно)',
      pattern: '        .filter(|(_, c)| {\n            call_record::record_survives(&c.state, c.updated_at, now, CALL_TOMBSTONE_MS)\n        })',
      replacement: '        .filter(|(_, _)| true)' },
    { name: 'в предикат надгробия время записи передажается вместо now (TTL считается от будущего)',
      pattern: '            call_record::record_survives(&c.state, c.updated_at, now, CALL_TOMBSTONE_MS)',
      replacement: '            call_record::record_survives(&c.state, now, c.updated_at, CALL_TOMBSTONE_MS)' },
    { name: 'в предикат надгробия окно передажается как now (решение живёт вечно)',
      pattern: '            call_record::record_survives(&c.state, c.updated_at, now, CALL_TOMBSTONE_MS)',
      replacement: '            call_record::record_survives(&c.state, c.updated_at, CALL_TOMBSTONE_MS, now)' },
    { name: 'состояние пишется, но время не продлевается (рингтон истекает по старому отметке)',
      pattern: '    entry.updated_at = now_ms();',
      replacement: '' },
    { name: 'пустое имя звонящего затирает известное (пуш «Пропущенный звонок» без имени)',
      pattern: '    if !caller.is_empty() {',
      replacement: '    if true {' },

    // ── распознавание группового приглашения ──
    { name: 'переводы строк письма не вырезаются (фолдинг ломает декод — приглашение молча гибнет)',
      pattern: '    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();',
      replacement: '    let compact: String = body.to_string();' },
    { name: 'urlSafe-алфавит не возвращается к стандартному (base64 не декодируется)',
      pattern: '    let normalized = compact.replace(\'-\', "+").replace(\'_\', "/");',
      replacement: '    let normalized = compact;' },
    { name: 'перевод алфавита подставляет обе буквы на каждый символ (дефект, найденный этой пробой)',
      pattern: '    let normalized = compact.replace(\'-\', "+").replace(\'_\', "/");',
      replacement: '    let normalized = compact.replace([\'-\', \'_\'], "+/");' },
    { name: 'padding не добивается до кратности 4 (декод отваливается на хвосте)',
      pattern: '    let padded_len = normalized.len().div_ceil(4) * 4;',
      replacement: '    let padded_len = normalized.len();' },
    { name: 'приглашением считается любой другой kind (пуш не на то письмо)',
      pattern: '        .map(|v| v.get("kind").and_then(|k| k.as_str()) == Some("group-invite"))',
      replacement: '        .map(|v| v.get("kind").and_then(|k| k.as_str()) == Some("vault-message"))' },
    { name: 'kind не читается вовсе — приглашением становится любое декодируемое тело',
      pattern: '        .map(|v| v.get("kind").and_then(|k| k.as_str()) == Some("group-invite"))',
      replacement: '        .map(|_v| true)' },

    // ── эхо-защита: вывод публичного ключа и отпечаток для лога ──
    { name: 'публичный ключ выводится в верхнем регистре (сравнение с конвертом ломается — ложный пуш «от себя»)',
      pattern: '            .map(|b| format!("{b:02x}"))',
      replacement: '            .map(|b| format!("{b:02X}"))' },
    { name: 'приват не участвует в выводе (все контакты дают один публичный ключ)',
      pattern: '        PublicKey::from(&StaticSecret::from(arr))',
      replacement: '        PublicKey::from(&StaticSecret::from([0u8; 32]))' },
    { name: 'длина привата не проверяется (31 байт молча становится нулевым ключом)',
      pattern: '    let arr = <[u8; 32]>::try_from(bytes.as_slice()).ok()?;',
      replacement: `    let mut arr = [0u8; 32];
    let n = bytes.len().min(32);
    arr[..n].copy_from_slice(&bytes[..n]);` },
    { name: 'приват не проверяется на hex и длину (битый ключ молча выводится нулевым)',
      pattern: '    let bytes = hex::decode(private_key_hex).ok()?;',
      replacement: `    let bytes = private_key_hex
        .chars()
        .take(32)
        .map(|_| 0u8)
        .collect::<Vec<u8>>();` },
    { name: 'отпечаток ключа в логе укорочен (совпадения в диагностике, лог не читается)',
      pattern: '    &hex_key[..16.min(hex_key.len())]',
      replacement: '    &hex_key[..8.min(hex_key.len())]' },
    { name: 'отпечаток режется без проверки длины (короткий ключ — паника в мониторе)',
      pattern: '    &hex_key[..16.min(hex_key.len())]',
      replacement: '    &hex_key[..16]' },

    // ── маркер «нашего» конверта ──
    { name: 'чужой конверт принимается за наш (уведомление по письму не Vault)',
      pattern: '    env.get("vault").and_then(|v| v.as_i64()) == Some(1)',
      replacement: '    env.get("vault").and_then(|v| v.as_i64()).is_some()' },
    { name: 'наш конверт не распознаётся (ни одного уведомления при смахнутом приложении)',
      pattern: '    env.get("vault").and_then(|v| v.as_i64()) == Some(1)',
      replacement: '    env.get("vault").and_then(|v| v.as_i64()) == Some(2)' },

    // ── порядок перебора ключей при расшифровке ──
    { name: 'ключ отправителя не пробуется первым (письмо от контакта не расшифровывается)',
      pattern: `    if let Some(key) = peers.get(from) {
        order.push(Some(key.as_str()));
    }`,
      replacement: `    if let Some(key) = peers.get(from) {
        let _ = key;
    }` },
    { name: 'свой ключ из перебора выпадает (письма себе больше не читаются)',
      pattern: '    order.push(None);',
      replacement: '    if false {\n        order.push(None);\n    }' },
    { name: 'свой ключ пробуется первым, а не после ключа отправителя',
      pattern: '    order.push(None);',
      replacement: '    order.insert(0, None);' },
    { name: 'страховой перебор повторяет ключ отправителя (двойная работа, порядок сбивается)',
      pattern: `        if email == from {
            continue;
        }`,
      replacement: '        if false {\n            continue;\n        }' },
    { name: 'страховой перебор выключен (смена ключа у контакта = письмо навсегда нечитаемо)',
      pattern: '    for (email, key) in peers {',
      replacement: '    for (email, key) in peers.iter().take(0) {' },

    // ── «отправитель не из контактов» ──
    { name: 'неизвестный отправитель считается своим (письмо из spam крутится в ретраях)',
      pattern: '    !peers.contains_key(from)',
      replacement: '    peers.contains_key(from)' },
    { name: 'незнакомым не считается никто (чужие письма ретраятся вместо Dead — батарея)',
      pattern: '    !peers.contains_key(from)',
      replacement: '    false' },

    // ── лимит попыток доставки ──
    { name: 'сдаться предписано на второй попытке (письмо теряется, уведомления нет)',
      pattern: 'pub(crate) const MAX_TRIES: u32 = 3;',
      replacement: 'pub(crate) const MAX_TRIES: u32 = 2;' },
    { name: 'граница «>=» съехала на «>» (четвёртая попытка вместо третьей; очередь греет батарею)',
      pattern: '    if tries >= MAX_TRIES {',
      replacement: '    if tries > MAX_TRIES {' },
    { name: 'ветки политики поменяны местами (первая же неудача — seen, письмо пропало)',
      pattern: `    if tries >= MAX_TRIES {
        RetryEffect::GiveUp
    } else {
        RetryEffect::Again
    }`,
      replacement: `    if tries >= MAX_TRIES {
        RetryEffect::Again
    } else {
        RetryEffect::GiveUp
    }` },

    // ── путь к базе монитора (три места монитора читают одно правило) ──
    { name: 'каталог приложения в пути потерян (монитор открывает другую базу: дедуп пуст)',
      pattern: '        Some(dir) => dir.join("com.vault.vault").join("monitor.db"),',
      replacement: '        Some(dir) => dir.join("monitor.db"),' },
    { name: 'имя файла базы изменено (после обновления курсоры и seen начинаются заново)',
      pattern: '        Some(dir) => dir.join("com.vault.vault").join("monitor.db"),',
      replacement: '        Some(dir) => dir.join("com.vault.vault").join("monitor.sqlite"),' },
    { name: 'фолбэк без data_local игнорирует HOME (на десктопе база в /tmp у всех пользователей)',
      pattern: '        None => std::path::Path::new(home).join("monitor.db"),',
      replacement: '        None => std::path::Path::new("/tmp").join("monitor.db"),' },

    // ── правило «что показать уведомлением» ──
    { name: 'текст приглашения в группу обтекающий (пользователь не понимает, что открыть)',
      pattern: '        text: "приглашение в группу — откройте Vault, чтобы принять".to_string(),',
      replacement: '        text: "новое письмо".to_string(),' },
    { name: 'текст пропущенного звонка потерян (пуш без объяснения, два места разъезжаются)',
      pattern: '        text: "Пропущенный звонок Vault".to_string(),',
      replacement: '        text: "Звонок".to_string(),' },
    { name: 'SOS не помечен в заголовке (тревожный сигнал выглядит обычным письмом)',
      pattern: '            title: format!("🚨 SOS: {who}"),',
      replacement: '            title: who.to_string(),' },
    { name: 'SOS без имени показывает пустое место (так шлёт JS — заголовок был пустым)',
      pattern: '        let who = if name.is_empty() { from } else { name };',
      replacement: '        let who = name;' },
    { name: 'SOS без текста теряет дефолтную фразу (пустое уведомление вместо тревоги)',
      pattern: '            "Телефон не у меня"',
      replacement: '            ""' },
    { name: 'квитанция профиля уведомляет (спам-пуши на каждую рассылку контакта)',
      pattern: '    if typ == "profile" || text.is_empty() {',
      replacement: '    if false {' },
    { name: 'пустое письмо рождает пустое уведомление (раньше — молчание)',
      pattern: '    if typ == "profile" || text.is_empty() {',
      replacement: '    if typ == "profile" { ' },
    { name: 'заголовок обычного письма — всегда адрес, имя контакта игнорируется',
      pattern: `        title: if name.is_empty() {
            from.to_string()
        } else {
            name.to_string()
        },`,
      replacement: '        title: from.to_string(),' },
    { name: 'в уведомлении перепутаны заголовок и текст',
      pattern: '        text: text.to_string(),',
      replacement: '        text: name.to_string(),' },
  ],
};
