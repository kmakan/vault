// Набор мутаций: rust-call-record — журнал звонков headless-монитора.
//
// ЗАЧЕМ. Правило «что делать с пришедшим сигналом звонка» жило в
// `src-tauri/src/service_monitor.rs`, а этот модуль целиком под
// `#[cfg(target_os = "android")]`: на хосте его тесты не компилируются, и
// `rust-mutation-gate` (крейт `vault-client`) их не видит. То есть переходы
// ringing → missed, гашение ретрансляций и реплей-фильтр проверялись ТОЛЬКО
// живой приёмкой на телефоне — а это ровно те правила, чья поломка не видна в
// тесте и слышна в 3 часа ночи (звонящий слышит гудки, телефон хозяина молчит;
// или «пропущенный» оживает и звонит снова).
//
// ПРОВЕРЯЕТСЯ ПОВЕДЕНИЕ, А НЕ ФОРМАЛЬНОСТЬ: каждая мутация — конкретная
// поломка, которая уже случалась или случится (вечный рингтон, воскресший
// пропущенный, missed поверх идущего разговора, чужое имя на экране звонка).
export default {
  id: 'rust-call-record',
  file: 'vault-client/src/vault/call_record.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'терминальные сигналы теряют call_end (зависший ringing гудит вечно)',
      pattern: '    if matches!(typ, "call_cancel" | "call_end" | "call_reject") {',
      replacement: '    if matches!(typ, "call_cancel" | "call_reject") {' },
    { name: 'проверка «это звонок» сравнивает тип целиком (call_end больше не сигнал звонка)',
      pattern: '    typ.starts_with("call_")',
      replacement: '    typ == "call_request"' },
    { name: 'терминальные сигналы вообще не обрабатываются (ветка отключена — звонок висит ringing)',
      pattern: '    if matches!(typ, "call_cancel" | "call_end" | "call_reject") {\n        return Incoming::Terminate;\n    }',
      replacement: '    if false {\n        return Incoming::Terminate;\n    }' },
    { name: 'пустой ts считается свежим (перехваченное письмо без ts будит телефон)',
      pattern: '    if env_ts <= 0 || now - env_ts >= fresh_window_ms {',
      replacement: '    if env_ts < 0 || now - env_ts >= fresh_window_ms {' },
    { name: 'граница окна включительна (ровно на пороге сигнал всё ещё «свежий»)',
      pattern: 'if env_ts <= 0 || now - env_ts >= fresh_window_ms {',
      replacement: 'if env_ts <= 0 || now - env_ts > fresh_window_ms {' },
    { name: 'ретрансляция перезапускает рингтон (уведомление обновляется каждые 15 с)',
      pattern: '            Some(RecordState::Ringing) => Incoming::Retransmission,',
      replacement: '            Some(RecordState::Ringing) => Incoming::Ring {\n                caller: if name.is_empty() { email.to_string() } else { name.to_string() },\n            },' },
    { name: 'вместо имени звонящего всегда адрес (подпись «неизвестный» на экране звонка)',
      pattern: '            caller: if name.is_empty() {',
      replacement: '            caller: if false {' },
    { name: 'состояние missed выпало из разбора (поздняя ретрансляция оживляет пропущенный)',
      pattern: '            "missed" => Some(RecordState::Missed),',
      replacement: '            "" => Some(RecordState::Missed),' },
    { name: 'JS-«active» не отображается на accepted (ring-timeout ставит missed поверх разговора)',
      pattern: '        "accept" | "accepted" | "active" => RecordState::Accepted.as_str(),',
      replacement: '        "accept" | "accepted" => RecordState::Accepted.as_str(),' },
    { name: 'неизвестная строка от JS превращается в пустое состояние (запись затирается)',
      pattern: '        other => other,',
      replacement: '        other => "",' },
    { name: 'отклонённый звонок не снимает уведомление (гудок висит в шторке после reject)',
      pattern: '        Some(RecordState::Accepted) | Some(RecordState::Rejected)',
      replacement: '        Some(RecordState::Accepted)' },
    { name: 'ringing тоже снимает уведомление (звонок пропадает, рингтон продолжается)',
      pattern: '        Some(RecordState::Accepted) | Some(RecordState::Rejected)',
      replacement: '        Some(RecordState::Accepted)\n            | Some(RecordState::Rejected)\n            | Some(RecordState::Ringing)' },
    { name: 'TTL-чистка трогает и гудок (ringing истекает по времени — уведомление исчезает до ответа)',
      pattern: '    is_ringing(state) || now - updated_at < tombstone_ms',
      replacement: '    is_ringing(state) && now - updated_at < tombstone_ms' },
    { name: 'ветка «гудок бессмертен» выброшена (через 10 мин журнал пустеет даже под рингтоном)',
      pattern: '    is_ringing(state) || now - updated_at < tombstone_ms',
      replacement: '    now - updated_at < tombstone_ms' },
    { name: 'граница надгробия включительна (запись живёт лишнюю миллисекунду и оживает поздним повтором)',
      pattern: '    is_ringing(state) || now - updated_at < tombstone_ms',
      replacement: '    is_ringing(state) || now - updated_at <= tombstone_ms' },
    { name: '«гудит» стало «любой распознанный статус» (журнал kv не очищается никогда)',
      pattern: '    RecordState::parse(state) == Some(RecordState::Ringing)',
      replacement: '    RecordState::parse(state).is_some()' },
    { name: 'ring-timeout срабатывает ровно на пороге (45-я секунда = «пропущенный» у звонящего, который ещё слышит гудки)',
      pattern: '    is_ringing(state) && now - updated_at > ring_timeout_ms',
      replacement: '    is_ringing(state) && now - updated_at >= ring_timeout_ms' },
    { name: 'таймаут гасит не только ringing (принятый разговор через 45 с объявляется пропущенным)',
      pattern: '    is_ringing(state) && now - updated_at > ring_timeout_ms',
      replacement: '    now - updated_at > ring_timeout_ms' },
    { name: 'знак таймаута перевёрнут (гудок «истёк» сразу, а на 45-й секунде — ещё нет)',
      pattern: '    is_ringing(state) && now - updated_at > ring_timeout_ms',
      replacement: '    is_ringing(state) && now - updated_at < ring_timeout_ms' },
  ],
};
