// Набор мутаций: rust-call-names — проводные имена состояний/событий/решений.
//
// ЗАЧЕМ. Мост держал таблицы имён СВОИМИ копиями: `vault_call_next_state` и
// `vault_call_can_apply` разбирали имя события одинаковым `match` на шесть
// строк, `vault_call_can` — 14 имён вопроса, хотя ядро уже печатало имена
// (`question_name`). Копия имени = копия протокола: если они расходятся, JS
// присылает понятное ему слово, ядро его не знает и переход МОЛЧА не
// применяется — звонок зависает в старом состоянии без ошибки. Теперь имя
// печатает и читает одно место, и этот набор требует, чтобы расхождение было
// поймано, а не проглочено.
export default {
  id: 'rust-call-names',
  file: 'vault-client/src/vault/call_state.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'событие Accepted печатается не тем именем (JS прочитает его как незнакомое)',
      pattern: '            CallEvent::Accepted => "accepted",',
      replacement: '            CallEvent::Accepted => "accept",' },
    { name: 'имя accepted читается в другое событие (переход применяется не к тому вызову)',
      pattern: '            "accepted" => Some(CallEvent::Accepted),',
      replacement: '            "accepted" => Some(CallEvent::Preempted),' },
    { name: 'событие ring_timeout потеряло имя (таймаут гудка больше не разбирается)',
      pattern: '            CallEvent::RingTimeout => "ring_timeout",',
      replacement: '            CallEvent::RingTimeout => "timeout",' },
    { name: 'имя вопроса прочитано в другой вопрос (таблица «можно ли» врёт фронту)',
      pattern: '            "call_incoming_ringing" => Some(CallQuestion::CallIncomingRinging),',
      replacement: '            "call_incoming_ringing" => Some(CallQuestion::CallOutgoingRinging),' },
    { name: 'два вопроса получили одно имя (в таблице JS они сливаются в один)',
      pattern: '        CallQuestion::SendDcHangup => "send_dc_hangup",',
      replacement: '        CallQuestion::SendDcHangup => "call_active",' },
    { name: 'вопрос call_active читается как call_idle (фронт получает «можно» не про то состояние)',
      pattern: '            "call_active" => Some(CallQuestion::CallActive),',
      replacement: '            "call_active" => Some(CallQuestion::CallIdle),' },
    { name: 'решение «занято» уходит на провод под другим именем (JS не узнает busy)',
      pattern: '            RequestAction::Busy => "busy",',
      replacement: '            RequestAction::Busy => "reject",' },
    // Ниже — дрейф СЛОВАРЯ при неизменных name()/from_name(): round-trip внутри
    // ядра остаётся зелёным, ловит только паритет «ядро ↔ фикстура». Без этих
    // мутаций проверка фикстуры была бы декоративной: неизвестно, заметит ли
    // она переименование на стороне ядра, которое JS не увидит.
    { name: 'словарь событий отдаёт имя на букву иначе (JS шлёт прежнее слово — молчаливый no-op)',
      pattern: '        .map(|e| e.name().to_string())',
      replacement: '        .map(|e| format!("{}x", e.name()))' },
    { name: 'словарь вопросов отдаёт имя на букву иначе (таблица «можно ли» разойдётся с JS)',
      pattern: '        .map(|q| question_name(*q).to_string())',
      replacement: '        .map(|q| format!("{}x", question_name(*q)))' },
  ],
};
