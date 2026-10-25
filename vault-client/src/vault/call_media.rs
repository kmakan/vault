//! Числовые параметры медиазвонка — ADR-005 §W4, `t_502b6c90`.
//!
//! Зачем в ядре: таймауты ICE, payload-типы кодеков и параметры VP8-клока —
//! это протокол соединения, а не настройка UI. Ошибка в них выглядит как
//! «звонок не соединяется» или «видео дёргается», и в логе нет ничего внятного.
//! Обёртки над webrtc/cpal остаются в мосту — сюда переносятся только числа
//! и формулы, чтобы у них была одна копия и мутационная проверка.

use serde::Serialize;

/// Сколько ждём сбора ICE-кандидатов, прежде чем отдать SDP.
/// 4с: было 15с — ответ создавался слишком долго, звонок сгорал по таймеру
/// гудка. Host-кандидаты собираются <1с; STUN/srflx за 4с успевают.
pub const ICE_GATHER_TIMEOUT_SECS: u64 = 4;
/// `disconnected` → `failed` в ICE: сколько терпим потерю связи. Дефолт
/// 5с не переживает доставку answer/offer по почте.
pub const ICE_DISCONNECTED_SECS: u64 = 60;
/// `failed` в ICE: сколько ждём восстановления. 60+120 = 180с окна —
/// покрывает задержку почты при таймере звонка 300с.
pub const ICE_FAILED_SECS: u64 = 120;
/// Opus dynamic payload type (both ends are our app).
pub const OPUS_PAYLOAD_TYPE: u8 = 120;
/// VP8 dynamic payload type (video; both ends are our app). 96 — первый
/// динамический PT, отдельный от [`OPUS_PAYLOAD_TYPE`].
pub const VP8_PAYLOAD_TYPE: u8 = 96;
/// Частота клока VP8 в RTP.
pub const VP8_CLOCK_RATE: u32 = 90_000;
/// Частота кадров захвата.
pub const VIDEO_FPS: u32 = 30;
/// Инкремент RTP-таймстампа на кадр: 90 000 / 30 = 3000.
pub const FRAME_TS_INCREMENT: u32 = VP8_CLOCK_RATE / VIDEO_FPS;

/// Длительность кадра в наносекундах — округление ВВЕРХ, иначе 33 333 333 нс
/// дают 2999 тиков вместо 3000 (`write_sample` усекает произведение).
///
/// `const fn`: мосту нужна константа (`Sample.duration` задаётся в const
/// контексте), и формула обязана быть в ОДНОЙ копии — иначе число протокола
/// пришлось бы править в двух крейтах.
pub const fn frame_duration_nanos() -> u64 {
    (1_000_000_000u64 * FRAME_TS_INCREMENT as u64).div_ceil(VP8_CLOCK_RATE as u64)
}

/// Состояние медиазвонка для ростера (M2.8). На провод уходит как есть.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub enum MediaCallState {
    #[default]
    Idle,
    Incoming,
    Outgoing,
    InCall,
    /// Активная групповая сессия (ростер = участники + я).
    Group,
}

/// Есть ли для `call_id` медиасессия → InCall, иначе Idle.
///
/// Решение о состоянии — здесь, а мост только сообщает, известен ли ему
/// `call_id`: иначе «активен ли звонок» считался бы в двух местах.
pub fn media_call_state(known_call: bool) -> MediaCallState {
    if known_call {
        MediaCallState::InCall
    } else {
        MediaCallState::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_numbers_are_pinned() {
        assert_eq!(ICE_GATHER_TIMEOUT_SECS, 4);
        assert_eq!(ICE_DISCONNECTED_SECS, 60);
        assert_eq!(ICE_FAILED_SECS, 120);
        assert_eq!(OPUS_PAYLOAD_TYPE, 120);
        assert_eq!(VP8_PAYLOAD_TYPE, 96);
        assert_ne!(VP8_PAYLOAD_TYPE, OPUS_PAYLOAD_TYPE);
        assert_eq!(VP8_CLOCK_RATE, 90_000);
        assert_eq!(VIDEO_FPS, 30);
        assert_eq!(FRAME_TS_INCREMENT, 3_000);
    }

    #[test]
    fn frame_duration_rounds_up_to_exact_increment() {
        assert_eq!(frame_duration_nanos(), 33_333_334);
        // Проверка того самого дефекта: «ровные» 33 333 333 нс дали бы 2999.
        assert_eq!(
            (frame_duration_nanos() as f64 / 1_000_000_000.0 * VP8_CLOCK_RATE as f64) as u32,
            FRAME_TS_INCREMENT
        );
    }

    #[test]
    fn media_state_depends_only_on_presence() {
        assert_eq!(media_call_state(true), MediaCallState::InCall);
        assert_eq!(media_call_state(false), MediaCallState::Idle);
        assert_eq!(MediaCallState::default(), MediaCallState::Idle);
    }

    #[test]
    fn media_state_names_are_wire_vocabulary() {
        // JS читает эти имена (`calls.js` fallback 'Idle').
        assert_eq!(serde_json::to_string(&MediaCallState::Idle).unwrap(), "\"Idle\"");
        assert_eq!(
            serde_json::to_string(&MediaCallState::InCall).unwrap(),
            "\"InCall\""
        );
    }
}
