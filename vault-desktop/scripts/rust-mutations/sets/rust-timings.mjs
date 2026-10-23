// Набор мутаций: rust-timings — окна, пороги и часы фоновой доставки.
//
// ЗАЧЕМ. Эти пять чисел определяли, проснётся ли телефон от перехваченного
// письма и увидит ли пользователь пропущенный, — и жили в мосту
// (`src-tauri/src/monitor_invariants.rs`). `rust-mutation-gate` меряет наборы
// по крейту `vault-client`, поэтому во мосту они были невидимы для проверок:
// любой сдвиг константы или знака в сравнении проверяла только живая приёмка,
// а её цикл — часы, а не секунды. Это ровно тот класс дефектов, из-за которого
// ведётся вынос (ADR-005 §W4): «правильно, но непроверяемо».
//
// Отдельно про константы: тесты окон считают возраст ОТ носителя
// (`FRESH_SECS - 1`), поэтому сдвиг самого числа ими не заметен — его ловит
// только пинning literal'ом (`thresholds_are_the_numbers_their_names_claim`).
export default {
  id: 'rust-timings',
  file: 'vault-client/src/vault/timings.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'окно свежести писем сдвинуто (14 минут вместо 15: письма «на границе» теряются молча)',
      pattern: 'pub const FRESH_SECS: i64 = 15 * 60;',
      replacement: 'pub const FRESH_SECS: i64 = 14 * 60;' },
    { name: 'окно свежести писем расширено вдвое (перехваченное 20-минутной давности письмо будит телефон)',
      pattern: 'pub const FRESH_SECS: i64 = 15 * 60;',
      replacement: 'pub const FRESH_SECS: i64 = 30 * 60;' },
    { name: 'call_request протухает за минуту вместо десяти (живой звонок перестаёт показываться)',
      pattern: 'pub const CALL_STALE_MS: i64 = 10 * 60 * 1000;',
      replacement: 'pub const CALL_STALE_MS: i64 = 60 * 1000;' },
    { name: 'гудок таймаутится за 5 с (missed ставится, пока абонент ещё берёт трубку)',
      pattern: 'pub const RING_TIMEOUT_MS: i64 = 45 * 1000;',
      replacement: 'pub const RING_TIMEOUT_MS: i64 = 5 * 1000;' },
    { name: 'надгробие missed короче ring-timeout (поздняя ретрансляция оживляет пропущенный)',
      pattern: 'pub const CALL_TOMBSTONE_MS: i64 = 10 * 60 * 1000;',
      replacement: 'pub const CALL_TOMBSTONE_MS: i64 = 30 * 1000;' },
    { name: 'лимит дедупа выставлен в ноль (список пустеет каждый тик → уведомления дублируются)',
      pattern: 'pub const SEEN_CAP: usize = 200;',
      replacement: 'pub const SEEN_CAP: usize = 0;' },
    { name: 'граница окна включительна (письмо ровно на пороге считается свежим)',
      pattern: '        Ok(dt) => now_ms / 1000 - dt.timestamp() < FRESH_SECS,',
      replacement: '        Ok(dt) => now_ms / 1000 - dt.timestamp() <= FRESH_SECS,' },
    { name: 'разница часов перевернута (старьё проходит, свежие письма отбрасываются)',
      pattern: '        Ok(dt) => now_ms / 1000 - dt.timestamp() < FRESH_SECS,',
      replacement: '        Ok(dt) => dt.timestamp() - now_ms / 1000 < FRESH_SECS,' },
    { name: 'секунды не отделены от миллисекунд (сравнение ms с ts в секундах = окно из 15 мс)',
      pattern: '        Ok(dt) => now_ms / 1000 - dt.timestamp() < FRESH_SECS,',
      replacement: '        Ok(dt) => now_ms - dt.timestamp() < FRESH_SECS,' },
    { name: 'нераспарсенный Date отбрасывается (монитор глохнет на письмах без Date и на сломанном MTA)',
      pattern: '        Err(_) => true,',
      replacement: '        Err(_) => false,' },
    { name: 'пробелы в заголовке не срезаются (реальный Date с обрамлением перестаёт разбираться)',
      pattern: '    match chrono::DateTime::parse_from_rfc2822(date_header.trim()) {',
      replacement: '    match chrono::DateTime::parse_from_rfc2822(date_header) {' },
    { name: 'обрезка дедупа паникует на коротком списке (первые 200 писем = падение монитора)',
      pattern: '    len.saturating_sub(cap)',
      replacement: '    len - cap' },
    { name: 'обрезка дедупа считает индекс в другую сторону (список растёт вместо усечения)',
      pattern: '    len.saturating_sub(cap)',
      replacement: '    cap.saturating_sub(len)' },
  ],
};
