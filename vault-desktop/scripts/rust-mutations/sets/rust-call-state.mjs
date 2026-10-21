// Набор мутаций: rust-call-state
// Цель: убедиться, что смоук cargo test -p vault-client --lib ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'rust-call-state',
  file: 'vault-client/src/vault/call_state.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: "исходящий звонок разрешён из любого состояния (перебивает живой разговор)",
      pattern: "pub fn can_start_outgoing(state: CallState) -> bool {\n    state == CallState::Idle\n}",
      replacement: "pub fn can_start_outgoing(state: CallState) -> bool {\n    !matches!(state, CallState::Idle)\n}" },
    { name: "дубль запроса не игнорируется (ретрансляция поднимает новый звонок)",
      pattern: "    if same_call {\n        return RequestAction::Ignore;\n    }",
      replacement: "    if false {\n        return RequestAction::Ignore;\n    }" },
    { name: "занято не отвечаем (звонящий ждёт в пустоту)",
      pattern: "            if has_current {\n                RequestAction::Busy\n            } else if state == CallState::Active {",
      replacement: "            if false {\n                RequestAction::Busy\n            } else if state == CallState::Active {" },
    { name: "принятие разрешено из idle (берём звонок, которого нет)",
      pattern: "        CallEvent::Accepted => matches!(\n            current,\n            CallState::IncomingRinging | CallState::OutgoingRinging\n        ),",
      replacement: "        CallEvent::Accepted => true," },
    { name: "поздний таймаут больше не игнорируется (рвёт живой разговор)",
      pattern: "pub fn ignore_stale_ring_timeout(state: CallState) -> bool {\n    state == CallState::Active\n}",
      replacement: "pub fn ignore_stale_ring_timeout(state: CallState) -> bool {\n    false\n}" },
    { name: "тип отбоя всегда call_end (в истории «разговор был» вместо «сорвался»)",
      pattern: "    match state {\n        CallState::Active => \"call_end\",\n        _ => \"call_cancel\",\n    }",
      replacement: "    match state {\n        CallState::Active => \"call_end\",\n        _ => \"call_end\",\n    }" },
  ],
};
