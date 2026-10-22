//! Правило протокола: состояние звонка.
//!
//! ADR-005 R1 (эпик W4, `t_821261f7`): «решение о протоколе и формате —
//! в Rust». Машина состояний звонка — это протокол, а не UI: по нему
//! определяется, какой сигнал уходит на провод (`call_end` против
//! `call_cancel`), и по нему же решается, что делать с чужим звонком, когда
//! мы уже говорим.
//!
//! Если это правило живёт в JS, то фронт и ядро считают разное, и при
//! расхождении получается либо «обрыв на живом звонке», либо «пропавший
//! вызов» — оба уже случались (инцидент 12.10.2026: таймаут гудка, пришедший
//! после `call_accept`, рвал живой разговор).
//!
//! Здесь — единственное место, где определены состояния и переходы. JS
//! получает готовые решения через Tauri-мост (`vault_call_*`) и только
//! исполняет их.
//!
//! Формат полей на проводе (`call_request`, `call_accept`, `call_end`,
//! `call_cancel`, `call_reject`) — конвенция, а не реализация: она совпадает
//! с тем, что принимает `vault_client::vault::call::parse_call_signal`.

use std::collections::BTreeMap;
/// Состояние звонка на стороне одного абонента.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallState {
    /// Звонков нет.
    Idle,
    /// Звоним мы, ждём ответа.
    OutgoingRinging,
    /// Звонят нам, мы видим входящий.
    IncomingRinging,
    /// Разговор идёт (медиа соединились).
    Active,
}

impl CallState {
    /// Проводное имя состояния (совпадает со значением в JS-состоянии).
    pub fn as_str(self) -> &'static str {
        match self {
            CallState::Idle => "idle",
            CallState::OutgoingRinging => "outgoing_ringing",
            CallState::IncomingRinging => "incoming_ringing",
            CallState::Active => "active",
        }
    }

    /// Разбор имени состояния (из JS/хранилища).
    pub fn from_str(s: &str) -> Option<CallState> {
        match s {
            "idle" => Some(CallState::Idle),
            "outgoing_ringing" => Some(CallState::OutgoingRinging),
            "incoming_ringing" => Some(CallState::IncomingRinging),
            "active" => Some(CallState::Active),
            _ => None,
        }
    }
}

/// Событие, меняющее состояние звонка.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallEvent {
    /// Пришёл `call_request` (звонят нам).
    RequestReceived,
    /// Звонок принят (`call_accept` или нажатие «ответить»).
    Accepted,
    /// Отбой: разговор закончен, состояние сбрасывается в idle.
    HungUp,
    /// Таймер гудка сработал (звонок не принят вовремя).
    RingTimeout,
    /// Новый звонок вытеснил текущий (тот самый «preempt»).
    Preempted,
    /// Мы начали исходящий звонок (звоним, ждём ответа).
    OutgoingStarted,
}

/// Что делать с пришедшим `call_request` — решение о ЗАНЯТОСТИ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestAction {
    /// Принять: переходим во входящий звонок.
    Accept,
    /// Проигнорировать: это дубль того же звонка.
    Ignore,
    /// Отказать: мы уже говорим с другим (уходим с `call_reject`).
    Busy,
    /// Вытеснить: текущий звонок в гудках, его надо погасить и принять новый.
    Preempt,
}

/// Можно ли начать ИСХОДЯЩИЙ звонок из этого состояния.
///
/// Правило: только из `idle`. Входящий/исходящий в гудках и разговор —
// звонок уже есть, второй начинать нельзя.
pub fn can_start_outgoing(state: CallState) -> bool {
    state == CallState::Idle
}

/// Решение по входящему `call_request`.
///
/// `same_call` — тот же ли `call_id` (повтор запроса от того же звонящего):
/// такой запрос игнорируется (ретрансляция `call_request` каждые 15 секунд —
/// это НОРМА, а не новый звонок).
///
/// Правила (в порядке применения):
///   * тот же звонок → игнорировать (дубль-ретрансляция);
    ///   * идёт разговор (`active`) → звонок занят, мы НЕ вытесняем живой разговор
///     и НЕ отвечаем: запрос просто игнорируется;
///   * идёт гудок (наш или чужой) → вытеснить: погасить старый и принять новый
///     (иначе звонок от нового звонящего невозможно принять, пока висит старый);
///   * свободно → принять.
pub fn incoming_request_action(
    state: CallState,
    same_call: bool,
    has_current: bool,
) -> RequestAction {
    // Тот же звонок — это ретрансляция `call_request` (каждые 15 с), а не новый.
    if same_call {
        return RequestAction::Ignore;
    }
    match state {
        // Свободны — принимаем.
        CallState::Idle => RequestAction::Accept,
        // Заняты: если у нас ЕСТЬ текущий звонок (факт — владелец знает), то
        // это «занято»: отвечаем `call_reject` и помечаем вызов пропущенным.
        // Если текущего звонка нет (состояние зависло, как в старом баге), то
        // отвечать нечем и обрывать нечего — запрос пропускаем.
        CallState::Active | CallState::IncomingRinging | CallState::OutgoingRinging => {
            if has_current {
                RequestAction::Busy
            } else if state == CallState::Active {
                // Живой разговор не рвём.
                RequestAction::Ignore
            } else {
                // Гудки без currentCall: старый вызов надо погасить, иначе
                // новый невозможно принять (зависшая state machine).
                RequestAction::Preempt
            }
        }
    }
}

/// Следующее состояние по событию.
///
/// `None` — состояние не меняется (событие не применимо в текущем состоянии).
///
/// Правила:
///   * `RequestReceived` → `incoming_ringing` (звонок принят к показу);
///   * `Accepted` → `active` (разговор начался);
///   * `HungUp` → `idle` (звонка окончена);
///   * `RingTimeout` → `idle` (не дождались ответа);
///   * `Preempted` → `idle` (старый звонок погашен перед новым).
pub fn next_state(current: CallState, event: CallEvent) -> Option<CallState> {
    match event {
        CallEvent::RequestReceived => Some(CallState::IncomingRinging),
        CallEvent::OutgoingStarted => Some(CallState::OutgoingRinging),
        CallEvent::Accepted => Some(CallState::Active),
        CallEvent::HungUp | CallEvent::RingTimeout | CallEvent::Preempted => Some(CallState::Idle),
    }
    .filter(|next| *next != current || matches!(event, CallEvent::HungUp))
}

/// Правила «можно ли» — одним перечислением, чтобы JS не сравнивал состояния
/// сам и чтобы правила лежали рядом с переходами.
///
/// Каждый вопрос — это ПРАВИЛО протокола (не чтение факта): «можно ли
/// поставить таймер гудка», «можно ли начать исходящий звонок», «можно ли
/// отправить hangup по DataChannel» и т. п. Факты (текущий `call_id`, тот же
/// ли звонок) остаются в JS — там владелец состояния.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallQuestion {
    /// Ставить таймер гудка (только для входящего звонка).
    ArmRingTimer,
    /// Начинать исходящий звонок (только когда звонков нет).
    StartOutgoing,
    /// Принимать входящий звонок (только пока он звонит).
    AcceptIncoming,
    /// Применять `call_accept` от собеседника (только пока мы звоним).
    AcceptOutgoing,
    /// Отменять исходящий звонок (только пока он звонит).
    CancelOutgoing,
    /// Отправлять hangup по DataChannel (только в живом разговоре).
    SendDcHangup,
    /// Разрешать обратный звонок (только когда звонков нет).
    CanCallBack,
    /// Игнорировать «поздний» таймаут гудка (только в живом разговоре).
    IgnoreStaleTimeout,
    /// Применять SDP (только в живом разговоре).
    ApplySdp,
    /// Включать запасной «звонок идёт» (только в живом разговоре).
    MediaFallback,
    /// Идёт ли сейчас разговор (влияет на частоту опроса реле: при звонке —
    /// чаще, чтобы сигнал звонка не ждал полный интервал).
    CallActive,
    /// Звонков нет (состояние «покой»).
    CallIdle,
    /// Идёт входящий звонок (звонит нам собеседник).
    CallIncomingRinging,
    /// Идёт исходящий звонок (мы звоним, ждём ответа).
    CallOutgoingRinging,
}

/// Ответ на правило «можно ли» в текущем состоянии.
pub fn can(state: CallState, question: CallQuestion) -> bool {
    match question {
        // Таймер гудка можно ставить в обоих «звонящих» состояниях.
        //
        // Раньше разрешалось только во входящем, и ИСХОДЯЩИЙ вызов не мог
        // уважать настройку «длительность гудка»: JS ставил жёсткие 300 секунд,
        // и вызов висел пять минут, даже если человек поставил гудок 60с.
        // Ждём мы тут ОТВЕТ собеседника, а значит ждём дольше его гудка —
        // это улаживает JS (настройка + запас на доставку accept).
        CallQuestion::ArmRingTimer => {
            state == CallState::IncomingRinging || state == CallState::OutgoingRinging
        }
        CallQuestion::StartOutgoing => can_start_outgoing(state),
        CallQuestion::AcceptIncoming => state == CallState::IncomingRinging,
        CallQuestion::AcceptOutgoing => state == CallState::OutgoingRinging,
        CallQuestion::CancelOutgoing => state == CallState::OutgoingRinging,
        CallQuestion::SendDcHangup => state == CallState::Active,
        CallQuestion::CanCallBack => can_start_outgoing(state),
        CallQuestion::IgnoreStaleTimeout => ignore_stale_ring_timeout(state),
        CallQuestion::ApplySdp => state == CallState::Active,
        CallQuestion::MediaFallback => state == CallState::Active,
        CallQuestion::CallActive => state == CallState::Active,
        CallQuestion::CallIdle => state == CallState::Idle,
        CallQuestion::CallIncomingRinging => state == CallState::IncomingRinging,
        CallQuestion::CallOutgoingRinging => state == CallState::OutgoingRinging,
    }
}

/// Таблица ответов «можно ли» для КАЖДОГО состояния.
///
/// Зачем целиком: часть решений о состоянии читается в СИНХРОННЫХ местах —
/// в шаблоне компонента и внутри fire-and-forget `hangup`, где `await` внутри
/// сдвинул бы сброс состояния на микротаск (гонка, уже ловившаяся в этом
/// модуле). Ответ зависит только от состояния, а состояний четыре, поэтому
/// JS получает таблицу ОДНИМ вызовом и кэширует её: решение по-прежнему
/// принимает ядро, а синхронные места читают уже принятое решение.
///
/// Кэш не протухает: таблица выводится из кода ядра и не меняется в рантайме.
pub fn can_table() -> BTreeMap<&'static str, BTreeMap<&'static str, bool>> {
    let states = [
        CallState::Idle,
        CallState::OutgoingRinging,
        CallState::IncomingRinging,
        CallState::Active,
    ];
    let questions = [
        CallQuestion::ArmRingTimer,
        CallQuestion::StartOutgoing,
        CallQuestion::AcceptIncoming,
        CallQuestion::AcceptOutgoing,
        CallQuestion::CancelOutgoing,
        CallQuestion::SendDcHangup,
        CallQuestion::CanCallBack,
        CallQuestion::IgnoreStaleTimeout,
        CallQuestion::ApplySdp,
        CallQuestion::MediaFallback,
        CallQuestion::CallActive,
        CallQuestion::CallIdle,
        CallQuestion::CallIncomingRinging,
        CallQuestion::CallOutgoingRinging,
    ];
    let mut table = BTreeMap::new();
    for state in states {
        let row: BTreeMap<&'static str, bool> = questions
            .iter()
            .map(|q| (question_name(*q), can(state, *q)))
            .collect();
        table.insert(state.as_str(), row);
    }
    table
}

/// Проводное имя вопроса (совпадает со строкой в JS).
pub fn question_name(q: CallQuestion) -> &'static str {
    match q {
        CallQuestion::ArmRingTimer => "arm_ring_timer",
        CallQuestion::StartOutgoing => "start_outgoing",
        CallQuestion::AcceptIncoming => "accept_incoming",
        CallQuestion::AcceptOutgoing => "accept_outgoing",
        CallQuestion::CancelOutgoing => "cancel_outgoing",
        CallQuestion::SendDcHangup => "send_dc_hangup",
        CallQuestion::CanCallBack => "can_call_back",
        CallQuestion::IgnoreStaleTimeout => "ignore_stale_timeout",
        CallQuestion::ApplySdp => "apply_sdp",
        CallQuestion::MediaFallback => "media_fallback",
        CallQuestion::CallActive => "call_active",
        CallQuestion::CallIdle => "call_idle",
        CallQuestion::CallIncomingRinging => "call_incoming_ringing",
        CallQuestion::CallOutgoingRinging => "call_outgoing_ringing",
    }
}

/// Применим ли переход в текущем состоянии.
///
/// JS не должен сравнивать состояния сам («а не active ли мы сейчас?») — это
/// тоже решение о протоколе, и оно должно жить рядом с остальными. Здесь
/// таблица применимости:
///
///   * `RequestReceived` — только из `idle` (в гудках новый звонок сначала
///     вытесняет старый, см. `incoming_request_action`);
///   * `Accepted` — из `incoming_ringing` или `outgoing_ringing` (принять можно
///     только звонок, который ещё звонит; из `active` принятие бессмысленно,
///     из `idle` — принять нечего);
///   * `HungUp` — из любого состояния (отбой работает всегда);
///   * `RingTimeout` — из состояния гудков (в `active` таймаут гудка ПРОПУСКАЕТСЯ:
///     иначе он рвёт живой разговор, инцидент 12.10.2026);
///   * `Preempted` — из состояния гудков (гасим именно звонок в гудках).
pub fn can_apply(current: CallState, event: CallEvent) -> bool {
    match event {
        CallEvent::RequestReceived => current == CallState::Idle,
        CallEvent::OutgoingStarted => current == CallState::Idle,
        CallEvent::Accepted => matches!(
            current,
            CallState::IncomingRinging | CallState::OutgoingRinging
        ),
        CallEvent::HungUp => true,
        CallEvent::RingTimeout => !ignore_stale_ring_timeout(current),
        CallEvent::Preempted => matches!(
            current,
            CallState::IncomingRinging | CallState::OutgoingRinging
        ),
    }
}

/// Тип терминального сигнала при отбое.
///
/// ПРАВИЛО ПРОТОКОЛА: разговор идёт → `call_end` (у собеседника трубка легла
/// после разговора); звонок не состоялся (гудки) → `call_cancel` (звонок отменён).
///
/// Ошибка здесь видна собеседнику: `call_end` в его истории — «разговор был»,
/// `call_cancel` — «звонок сорвался». Не путать.
pub fn hangup_signal_kind(state: CallState) -> &'static str {
    match state {
        CallState::Active => "call_end",
        _ => "call_cancel",
    }
}

/// Игнорировать ли «поздний» таймаут гудка.
///
/// ИНЦИДЕНТ (12.10.2026): таймер гудка на телефоне срабатывает через 300
/// секунд, а `call_accept` может дойти по почте через 90–180 секунд (SMTP +
/// Android + доставка + IMAP). Если таймер успел позже, он рвал ЖИВОЙ разговор.
/// Поэтому таймаут при `active` игнорируется.
pub fn ignore_stale_ring_timeout(state: CallState) -> bool {
    state == CallState::Active
}

#[cfg(test)]
mod tests {

    /// Таблица ответов: каждая строка — состояние, каждый столбец — вопрос.
    /// Смысл теста — в СОВПАДЕНИИ с `can`: таблица обязана быть теми же
    /// ответами, иначе JS закэширует не то.
    #[test]
    fn can_table_matches_can_for_every_state() {
        let table = can_table();
        let states = ["idle", "outgoing_ringing", "incoming_ringing", "active"];
        for s in states {
            let st = CallState::from_str(s).expect("состояние разбирается");
            let row = table.get(s).expect("состояние есть в таблице");
            assert_eq!(
                row.get("call_active").copied(),
                Some(can(st, CallQuestion::CallActive)),
                "call_active для {}",
                s
            );
            assert_eq!(
                row.get("call_idle").copied(),
                Some(can(st, CallQuestion::CallIdle)),
                "call_idle для {}",
                s
            );
            assert_eq!(
                row.get("can_call_back").copied(),
                Some(can(st, CallQuestion::CanCallBack)),
                "can_call_back для {}",
                s
            );
            assert_eq!(
                row.get("call_incoming_ringing").copied(),
                Some(can(st, CallQuestion::CallIncomingRinging)),
                "call_incoming_ringing для {}",
                s
            );
            assert_eq!(
                row.get("call_outgoing_ringing").copied(),
                Some(can(st, CallQuestion::CallOutgoingRinging)),
                "call_outgoing_ringing для {}",
                s
            );
        }
    }

    /// Таймер гудка ставится и во входящем, и в исходящем звонке: иначе
    /// исходящий не может уважать настройку «длительность гудка» (регресс
    /// найден на живом стенде 22.10.2026: вызов висел 5 минут при гудке 60с).
    #[test]
    fn arm_ring_timer_allowed_in_both_ringing_states() {
        assert!(can(CallState::IncomingRinging, CallQuestion::ArmRingTimer));
        assert!(can(CallState::OutgoingRinging, CallQuestion::ArmRingTimer));
        // В покое и в активном звонке — нельзя (таймер там бессмыслен).
        assert!(!can(CallState::Idle, CallQuestion::ArmRingTimer));
        assert!(!can(CallState::Active, CallQuestion::ArmRingTimer));
    }

    #[test]
    fn can_table_has_all_states_and_questions() {
        let table = can_table();
        assert_eq!(table.len(), 4, "состояний четыре");
        for (_, row) in table.iter() {
            assert_eq!(row.len(), 14, "вопросов четырнадцать");
            assert!(row.contains_key("arm_ring_timer"));
            assert!(row.contains_key("start_outgoing"));
            assert!(row.contains_key("accept_incoming"));
            assert!(row.contains_key("apply_sdp"));
            assert!(row.contains_key("media_fallback"));
        }
    }

    #[test]
    fn new_state_identity_questions() {
        assert!(can(CallState::Idle, CallQuestion::CallIdle));
        assert!(!can(CallState::Active, CallQuestion::CallIdle));
        assert!(can(
            CallState::IncomingRinging,
            CallQuestion::CallIncomingRinging
        ));
        assert!(!can(
            CallState::OutgoingRinging,
            CallQuestion::CallIncomingRinging
        ));
        assert!(can(
            CallState::OutgoingRinging,
            CallQuestion::CallOutgoingRinging
        ));
        assert!(!can(
            CallState::IncomingRinging,
            CallQuestion::CallOutgoingRinging
        ));
    }

    use super::*;

    #[test]
    fn state_names_roundtrip() {
        for s in [
            CallState::Idle,
            CallState::OutgoingRinging,
            CallState::IncomingRinging,
            CallState::Active,
        ] {
            assert_eq!(CallState::from_str(s.as_str()), Some(s));
        }
        assert_eq!(CallState::from_str("какое-то"), None);
    }

    #[test]
    fn outgoing_call_only_from_idle() {
        assert!(can_start_outgoing(CallState::Idle));
        assert!(!can_start_outgoing(CallState::OutgoingRinging));
        assert!(!can_start_outgoing(CallState::IncomingRinging));
        assert!(!can_start_outgoing(CallState::Active));
    }

    #[test]
    fn duplicate_request_is_ignored() {
        assert_eq!(
            incoming_request_action(CallState::Idle, true, true),
            RequestAction::Ignore
        );
        assert_eq!(
            incoming_request_action(CallState::Active, true, true),
            RequestAction::Ignore
        );
    }

    #[test]
    fn request_during_call_is_busy_when_we_have_a_call() {
        // Идёт разговор, текущий звонок есть → «занято»: отвечаем call_reject
        // и помечаем вызов пропущенным (как в оригинале).
        assert_eq!(
            incoming_request_action(CallState::Active, false, true),
            RequestAction::Busy
        );
    }

    #[test]
    fn request_during_call_without_current_is_ignored() {
        // Живой разговор, но currentCall потерялся (зависшая state machine):
        // отвечать нечем (мы не знаем, кого резать), и обрывать нечего.
        assert_eq!(
            incoming_request_action(CallState::Active, false, false),
            RequestAction::Ignore
        );
    }

    #[test]
    fn request_during_ringing_preempts_without_current() {
        assert_eq!(
            incoming_request_action(CallState::IncomingRinging, false, false),
            RequestAction::Preempt
        );
        assert_eq!(
            incoming_request_action(CallState::OutgoingRinging, false, false),
            RequestAction::Preempt
        );
    }

    #[test]
    fn request_during_ringing_with_current_is_busy() {
        // Есть текущий вызов → «занято», а не вытеснение.
        assert_eq!(
            incoming_request_action(CallState::OutgoingRinging, false, true),
            RequestAction::Busy
        );
    }

    #[test]
    fn request_when_idle_is_accepted() {
        assert_eq!(
            incoming_request_action(CallState::Idle, false, false),
            RequestAction::Accept
        );
    }

    #[test]
    fn transitions() {
        assert_eq!(
            next_state(CallState::Idle, CallEvent::RequestReceived),
            Some(CallState::IncomingRinging)
        );
        assert_eq!(
            next_state(CallState::Idle, CallEvent::OutgoingStarted),
            Some(CallState::OutgoingRinging)
        );
        assert_eq!(
            next_state(CallState::OutgoingRinging, CallEvent::Accepted),
            Some(CallState::Active)
        );
        assert_eq!(
            next_state(CallState::IncomingRinging, CallEvent::Accepted),
            Some(CallState::Active)
        );
        assert_eq!(
            next_state(CallState::Active, CallEvent::HungUp),
            Some(CallState::Idle)
        );
        assert_eq!(
            next_state(CallState::OutgoingRinging, CallEvent::RingTimeout),
            Some(CallState::Idle)
        );
        assert_eq!(
            next_state(CallState::OutgoingRinging, CallEvent::Preempted),
            Some(CallState::Idle)
        );
    }

    #[test]
    fn question_table() {
        // Таймер гудка — в обоих «звонящих» состояниях: исходящий тоже ждёт
        // ответа и должен уважать настройку «длительность гудка».
        assert!(can(CallState::IncomingRinging, CallQuestion::ArmRingTimer));
        assert!(can(CallState::OutgoingRinging, CallQuestion::ArmRingTimer));
        assert!(!can(CallState::Idle, CallQuestion::ArmRingTimer));

        // Исходящий звонок — только из idle.
        assert!(can(CallState::Idle, CallQuestion::StartOutgoing));
        assert!(!can(CallState::Active, CallQuestion::StartOutgoing));

        // Принять входящий — пока он звонит.
        assert!(can(CallState::IncomingRinging, CallQuestion::AcceptIncoming));
        assert!(!can(CallState::Active, CallQuestion::AcceptIncoming));
        assert!(!can(CallState::OutgoingRinging, CallQuestion::AcceptIncoming));

        // Применить accept от собеседника — пока мы звоним.
        assert!(can(CallState::OutgoingRinging, CallQuestion::AcceptOutgoing));
        assert!(!can(CallState::IncomingRinging, CallQuestion::AcceptOutgoing));

        // Отменить исходящий — пока он звонит.
        assert!(can(CallState::OutgoingRinging, CallQuestion::CancelOutgoing));
        assert!(!can(CallState::Active, CallQuestion::CancelOutgoing));

        // Hangup по DC — только в живом разговоре.
        assert!(can(CallState::Active, CallQuestion::SendDcHangup));
        assert!(!can(CallState::OutgoingRinging, CallQuestion::SendDcHangup));

        // Обратный звонок — только когда звонков нет.
        assert!(can(CallState::Idle, CallQuestion::CanCallBack));
        assert!(!can(CallState::Active, CallQuestion::CanCallBack));

        // Поздний таймаут — игнорируем только в разговоре.
        assert!(can(CallState::Active, CallQuestion::IgnoreStaleTimeout));
        assert!(!can(CallState::OutgoingRinging, CallQuestion::IgnoreStaleTimeout));

        // SDP и запасной «звонок идёт» — только в разговоре.
        assert!(can(CallState::Active, CallQuestion::ApplySdp));
        assert!(!can(CallState::Idle, CallQuestion::ApplySdp));
        assert!(can(CallState::Active, CallQuestion::MediaFallback));
        assert!(!can(CallState::Idle, CallQuestion::MediaFallback));

        // Идёт ли разговор — от этого частота опроса реле.
        assert!(can(CallState::Active, CallQuestion::CallActive));
        assert!(!can(CallState::Idle, CallQuestion::CallActive));
        assert!(!can(CallState::OutgoingRinging, CallQuestion::CallActive));
    }

    #[test]
    fn can_apply_table() {
        assert!(can_apply(CallState::Idle, CallEvent::RequestReceived));
        assert!(can_apply(CallState::Idle, CallEvent::OutgoingStarted));
        assert!(!can_apply(CallState::Active, CallEvent::OutgoingStarted));
        assert!(!can_apply(CallState::Active, CallEvent::RequestReceived));
        assert!(!can_apply(CallState::OutgoingRinging, CallEvent::RequestReceived));

        assert!(can_apply(CallState::OutgoingRinging, CallEvent::Accepted));
        assert!(can_apply(CallState::IncomingRinging, CallEvent::Accepted));
        assert!(!can_apply(CallState::Active, CallEvent::Accepted));
        assert!(!can_apply(CallState::Idle, CallEvent::Accepted));

        assert!(can_apply(CallState::Idle, CallEvent::HungUp));
        assert!(can_apply(CallState::Active, CallEvent::HungUp));

        assert!(can_apply(CallState::OutgoingRinging, CallEvent::RingTimeout));
        assert!(!can_apply(CallState::Active, CallEvent::RingTimeout));

        assert!(can_apply(CallState::OutgoingRinging, CallEvent::Preempted));
        assert!(!can_apply(CallState::Idle, CallEvent::Preempted));
    }

    #[test]
    fn hangup_signal_kind_differs() {
        assert_eq!(hangup_signal_kind(CallState::Active), "call_end");
        assert_eq!(hangup_signal_kind(CallState::OutgoingRinging), "call_cancel");
        assert_eq!(hangup_signal_kind(CallState::IncomingRinging), "call_cancel");
        assert_eq!(hangup_signal_kind(CallState::Idle), "call_cancel");
    }

    #[test]
    fn stale_ring_timeout_ignored_only_when_active() {
        assert!(ignore_stale_ring_timeout(CallState::Active));
        assert!(!ignore_stale_ring_timeout(CallState::OutgoingRinging));
        assert!(!ignore_stale_ring_timeout(CallState::IncomingRinging));
        assert!(!ignore_stale_ring_timeout(CallState::Idle));
    }
}
