//! Camera capture + VP8 frame pipeline for video calls (M3, step 2/3).
//!
//! Пайплайн кадров (реализовано и покрыто тестами):
//!
//! ```text
//! платформенный захват камеры ──VP8 кадр──▶ mpsc (4 кадра)
//!     ──▶ write_video_loop:
//!         crypto::media_encrypt_frame(media_key)   // тот же E2E-слой, что у аудио
//!         Sample { duration = 1/30с }
//!         TrackLocalStaticSample::write_sample    // rtc сам пакетизирует VP8 в RTP
//! ```
//!
//! RTP-таймстамп считает пакетизатор `rtc` (`rtp::packetizer`): стартовое
//! значение случайное, далее `timestamp += (sample.duration.as_secs_f64() *
//! clock_rate) as u32`. VP8 clock = 90 кГц, 30 fps ⇒ **+3000 тиков на кадр**
//! (`FRAME_TS_INCREMENT`); именно `Sample.duration` — единственный вход для
//! таймстампа, `Sample.packet_timestamp` при записи игнорируется.
//!
//! # Что НЕ реализовано (блокер шага 2/3, без выдуманного кода)
//!
//! Захват камеры и VP8-энкодер. Оба упираются в одну вещь: **в webrtc 0.20
//! нет VP8-энкодера**. `rtc` умеет только RTP-пакетизацию/депакетизацию VP8
//! (`RTCRtpCodec::payloader` даёт VP8-пайлоадер); в дереве зависимостей нет
//! ни libvpx/vpx-*, ни openh264, ни rav1e (проверено по Cargo.lock), а ТЗ
//! шага 2 запрещает добавлять крейты. Даже получив кадры камеры, кодировать
//! их в VP8 нечем.
//!
//! Варианты (нужно решение):
//! 1. +1 крейт на энкодер (`vpx-encode` / `libvpx-sys` + свой враппер):
//!    desktop — системный libvpx или vendored-сборка; Android — vendored
//!    libvpx под 4 ABI (долгая сборка, +размер APK).
//! 2. Без крейта, только NDK FFI: `MediaCodec` (`video/x-vp8`,
//!    `-lmediandk`) ~200-300 строк ручного `unsafe` + camera2 NDK
//!    (`libcamera2ndk`, `ACameraManager`/`AImageReader`) ~300 строк +
//!    runtime-пермишен CAMERA через активность (Java/Kotlin — вне 4
//!    разрешённых ТЗ файлов). Не компилируется и не тестируется в этой сессии.
//! 3. Desktop-захват отдельно: WebView `getUserMedia` (AudioRecorder.vue)
//!    кадры в Rust не отдаёт (WebCodecs в WebKitGTK нет, MediaRecorder отдаёт
//!    WebM-чанки, из которых отдельные VP8-кадры не выделить) ⇒ нужен
//!    capture-крейт (nokhwa/v4l) + энкодер из п.1/п.2.
//!
//! Поэтому `capture` ниже — платформенная заглушка (desktop, как разрешено
//! ТЗ) и честная ошибка (Android: команда не делает вид, что камера есть).
//! Контракт для будущего бэкенда: `capture::start` держит нативный ресурс в
//! своём module-level слоте и пушит VP8-кадры в переданный `frames`;
//! `capture::stop` дропает ресурс.

use std::sync::Arc;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::{mpsc, watch};

use rtc::media::Sample;
use rtc::shared::time::SystemInstant;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;

/// Частота клока VP8 в RTP (должна совпадать с `media::vp8_codec()`).
pub const VP8_CLOCK_RATE: u32 = 90_000;
/// Частота кадров захвата.
pub const VIDEO_FPS: u32 = 30;
/// Инкремент RTP-таймстампа на кадр: 90 000 / 30 = 3000.
pub const FRAME_TS_INCREMENT: u32 = VP8_CLOCK_RATE / VIDEO_FPS;

/// Длительность кадра для `Sample.duration` — 1/30 с, округлённая ВВЕРХ
/// (33 333 334 нс). `write_sample` считает инкремент как
/// `(duration.as_secs_f64() * clock_rate) as u32`, поэтому «ровные» 33 333 333
/// нс дали бы 2999 тиков вместо 3000 (truncation), а округление вверх —
/// ровно `FRAME_TS_INCREMENT`.
const FRAME_DURATION: Duration = Duration::from_nanos(
    (1_000_000_000u64 * FRAME_TS_INCREMENT as u64).div_ceil(VP8_CLOCK_RATE as u64),
);

/// Глубина очереди «кадр камеры → RTP-writer». Кадр VP8 = десятки КБ: при
/// отставании writer'а лучше уронить кадр (`try_send` в бэкенде), чем копить
/// задержку; поэтому очередь короткая.
const FRAME_CHANNEL_DEPTH: usize = 4;

/// Один кадр камеры: готовый VP8-битстрим (без RTP-заголовков) — ровно то,
/// что принимает `TrackLocalStaticSample::write_sample` (пакетизацию делает
/// библиотека, режет по MTU сама).
#[derive(Clone, Debug)]
pub struct CameraFrame {
    /// VP8-кадр целиком (keyframe или delta).
    pub data: Vec<u8>,
}

/// Живой дескриптор камеры звонка. Его держит `CallSession`: drop (закрытие
/// звонка / `media_camera_stop`) закрывает канал кадров — `write_video_loop`
/// видит `None` и выходит, — и освобождает платформенный захват.
pub struct CameraHandle {
    call_id: String,
    /// Канал «кадр камеры → RTP-writer». Ключевое поле: закрытие канала
    /// завершает writer-таску звонка (отдельный stop-канал не нужен).
    /// Свою копию Sender получает бэкенд захвата (`capture::start`).
    frames_tx: mpsc::Sender<CameraFrame>,
}

impl CameraHandle {
    /// Звонок, которому принадлежит камера (диагностика/логи).
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
}

impl Drop for CameraHandle {
    fn drop(&mut self) {
        // Поля дропаются после этого тела: Sender закрывается, writer видит
        // None и завершает таску. `is_closed()` — был ли writer уже мёртв
        // (например, звонок закрыт раньше камеры) — только для лога.
        eprintln!(
            "[video] camera handle dropped (call {}, writer_gone={}) — capture stopped, RTP writer ends",
            self.call_id(),
            self.frames_tx.is_closed()
        );
        release_capture(self.call_id());
    }
}

// ---------------------------------------------------------------------------
// Глобальный маркер активного захвата (для `stop_camera()` без call_id)
// ---------------------------------------------------------------------------

/// Звонок, которому принадлежит текущий захват. Захват один на процесс:
/// видеозвонок в приложении 1:1.
static CAPTURING: Mutex<Option<String>> = Mutex::new(None);

/// `Mutex::lock` без паники на отравлении (panic=abort, но привычка полезна).
fn capturing() -> MutexGuard<'static, Option<String>> {
    CAPTURING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Запустить захват камеры для `call_id`; кадры бэкенд кладёт в `frames`
/// (канал RTP-writer'а этого звонка).
///
/// Один захват на процесс: если камера уже работает (другой звонок), она
/// сначала гасится. Ошибка бэкенда возвращается наверх как есть (Android:
/// «не реализовано», см. док модуля) — команда не делает вид, что камера есть.
pub fn start_camera(
    call_id: &str,
    frames: mpsc::Sender<CameraFrame>,
) -> Result<CameraHandle, String> {
    stop_camera();
    capture::start(call_id, frames.clone())?;
    *capturing() = Some(call_id.to_owned());
    eprintln!("[video] camera capture started (call {call_id})");
    Ok(CameraHandle {
        call_id: call_id.to_owned(),
        frames_tx: frames,
    })
}

/// Остановить текущий захват камеры (`media_camera_stop`).
/// Идемпотентно: нет активного захвата — ничего не делаем.
pub fn stop_camera() {
    let active = capturing().take();
    if let Some(call_id) = active {
        capture::stop();
        eprintln!("[video] capture stopped (call {call_id})");
    }
}

/// Drop handle'а не имеет права гасить ЧУЖОЙ захват (другой звонок):
/// освобождаем, только если текущий захват — наш.
fn release_capture(call_id: &str) {
    if capturing().as_deref() == Some(call_id) {
        *capturing() = None;
        capture::stop();
    }
}

// ---------------------------------------------------------------------------
// RTP-writer: кадры камеры → зашифрованный VP8 sample → трек звонка
// ---------------------------------------------------------------------------

/// Запустить видео-путь звонка: writer-таска (кадры → RTP) + захват камеры.
/// Возвращает handle камеры — его держит `CallSession` (drop = стоп).
///
/// `stop_rx` — стоп-сигнал звонка (`CallSession::stop_tx`, тот же, что у
/// аудио-пайплайна), `media_key` — тот же E2E-ключ, что у аудио-пути.
pub fn start_video_for_call(
    call_id: &str,
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    payload_type: u8,
    media_key: Option<[u8; 32]>,
    stop_rx: watch::Receiver<bool>,
) -> Result<CameraHandle, String> {
    let (frames_tx, frames_rx) = mpsc::channel::<CameraFrame>(FRAME_CHANNEL_DEPTH);
    eprintln!(
        "[video] RTP writer started (call {call_id}, ssrc={ssrc}, \
         payload_type={payload_type}, clock={VP8_CLOCK_RATE}Hz, fps={VIDEO_FPS}, \
         ts_step={FRAME_TS_INCREMENT})"
    );
    tauri::async_runtime::spawn(write_video_loop(
        track,
        ssrc,
        payload_type,
        frames_rx,
        stop_rx,
        media_key,
    ));
    start_camera(call_id, frames_tx)
}

/// Async writer: VP8-кадры камеры → E2E-шифрование → RTP-пакеты в трек.
/// Полный аналог `audio::write_opus_loop` (та же схема: select! на кадр и стоп).
pub async fn write_video_loop(
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    payload_type: u8,
    mut rx: mpsc::Receiver<CameraFrame>,
    mut stop_rx: watch::Receiver<bool>,
    media_key: Option<[u8; 32]>,
) {
    let mut frames: u64 = 0;
    loop {
        tokio::select! {
            frame = rx.recv() => {
                // None = источник кадров закрыт (камера остановлена) — выходим.
                let Some(frame) = frame else { break };
                if frame.data.is_empty() {
                    continue;
                }
                // E2E-шифрование медиа: КАК В АУДИО — каждый кадр
                // XChaCha20-Poly1305 поверх DTLS-SRTP (defence in depth).
                let data = match &media_key {
                    Some(k) => match crate::crypto::media_encrypt_frame(k, &frame.data) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!("[video] media encrypt: {e}");
                            continue;
                        }
                    },
                    None => frame.data,
                };
                // duration задаёт RTP-таймстамп: +3000 тиков на кадр (90кГц/30fps).
                let sample = Sample {
                    data: Bytes::from(data),
                    timestamp: SystemInstant::now(),
                    duration: FRAME_DURATION,
                    ..Default::default()
                };
                if let Err(e) = track.write_sample(ssrc, payload_type, &sample, &[]).await {
                    eprintln!("[video] write_sample: {e}");
                    break;
                }
                frames += 1;
                // Раз в 5с (150 кадров @30fps) — видно, что поток живой.
                if frames % (VIDEO_FPS as u64 * 5) == 0 {
                    eprintln!("[video] {frames} frames sent");
                }
            }
            _ = stop_rx.changed() => break,
        }
    }
    eprintln!("[video] RTP writer finished (frames={frames})");
}

// ---------------------------------------------------------------------------
// Платформенный захват камеры
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "android"))]
mod capture {
    use super::{mpsc, CameraFrame};

    /// TODO (блокер, см. док модуля): desktop-захвата нет — нужен capture-крейт
    /// (nokhwa/v4l) И VP8-энкодер, которого в дереве зависимостей нет. Пока
    /// заглушка: возвращает Ok и не отправляет ни одного кадра (разрешено ТЗ
    /// шага 2) — writer звонка просто ждёт кадров и завершится на стопе.
    pub(super) fn start(
        call_id: &str,
        _frames: mpsc::Sender<CameraFrame>,
    ) -> Result<(), String> {
        eprintln!(
            "[video] camera capture STUB (desktop): no capture backend / no VP8 encoder yet \
             — no frames will be sent for call {call_id} (see video.rs TODO)"
        );
        Ok(())
    }

    /// Нативный ресурс не создавали — освобождать нечего.
    pub(super) fn stop() {}
}

#[cfg(target_os = "android")]
mod capture {
    use super::{mpsc, CameraFrame};

    /// Android — основной target, но захват ещё не реализован: camera2 живёт
    /// в Java API, нативный путь — NDK `libcamera2ndk` (`ACameraManager` +
    /// `AImageReader`) ~300 строк ручного FFI, плюс runtime-пермишен CAMERA
    /// через активность (Java/Kotlin вне 4 файлов этого шага); кодировать
    /// кадры нечем (VP8-энкодера в webrtc 0.20 нет, нужен MediaCodec-FFI или
    /// крейт libvpx). Поэтому — честная ошибка, а не тихий no-op: команда
    /// `media_camera_start` сообщит наверх, что камеры нет.
    pub(super) fn start(call_id: &str, _frames: mpsc::Sender<CameraFrame>) -> Result<(), String> {
        let msg = format!(
            "camera capture is not implemented on Android yet (call {call_id}): \
             needs camera2 (NDK/JNI) capture and a VP8 encoder — neither is available \
             in the current dependency set (see video.rs module docs)"
        );
        eprintln!("[video] {msg}");
        Err(msg)
    }

    /// Нативный ресурс не создавали — освобождать нечего.
    pub(super) fn stop() {}
}

// ---------------------------------------------------------------------------
// Tests (шаг 2/3: конвейер кадров; аудио-путь не затронут)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rtc::rtp::packetizer::{new_packetizer, Packetizer};
    use rtc::rtp::sequence::new_random_sequencer;

    fn test_track(ssrc: u32) -> Arc<TrackLocalStaticSample> {
        Arc::new(
            TrackLocalStaticSample::new(crate::media::video_media_track("vtest", ssrc))
                .expect("VP8 track"),
        )
    }

    /// Кадр VP8 идёт с клоком 90 кГц / 30 fps: длительность кадра обязана
    /// давать ровно 3000 тиков — иначе таймстампы «плывут» и пир роняет
    /// синхронизацию (truncation 33 333 333 нс даёт 2999).
    #[test]
    fn frame_duration_produces_exactly_3000_ticks() {
        assert_eq!(VP8_CLOCK_RATE, 90_000);
        assert_eq!(VIDEO_FPS, 30);
        assert_eq!(FRAME_TS_INCREMENT, 3_000);
        assert_eq!(
            (FRAME_DURATION.as_secs_f64() * VP8_CLOCK_RATE as f64) as u32,
            FRAME_TS_INCREMENT,
            "Sample.duration must convert to exactly one ts step"
        );
        // Кодек, который реально уходит в SDP/track (media.rs), — тот же клок.
        let codec = crate::media::vp8_codec();
        assert_eq!(codec.clock_rate, VP8_CLOCK_RATE);
        assert_eq!(
            codec.mime_type,
            rtc::peer_connection::configuration::media_engine::MIME_TYPE_VP8
        );
    }

    /// Таймстамп считает пакетизатор rtc (как в `write_sample`): проверяем
    /// инкремент 3000 на настоящем VP8-пайлоадере, а не на своих формулах.
    #[test]
    fn vp8_packetizer_advances_rtp_timestamp_by_3000_per_frame() {
        let ssrc = 0x0feed_beeu32;
        let codec = crate::media::vp8_codec();
        let payload_type = crate::media::VP8_PAYLOAD_TYPE;
        let mut packetizer = new_packetizer(
            1200,
            payload_type,
            ssrc,
            codec.payloader().expect("VP8 payloader"),
            Box::new(new_random_sequencer()),
            codec.clock_rate,
        );

        // Кадр камеры = сырой VP8-битстрим; содержимое для RTP-уровня не важно.
        let frame = Bytes::from(vec![0x10u8; 1024]);
        let samples = (FRAME_DURATION.as_secs_f64() * codec.clock_rate as f64) as u32;
        assert_eq!(samples, FRAME_TS_INCREMENT);

        let first = packetizer.packetize(&frame, samples).expect("frame 1");
        let second = packetizer.packetize(&frame, samples).expect("frame 2");
        let third = packetizer.packetize(&frame, samples).expect("frame 3");
        for pkts in [&first, &second, &third] {
            assert!(!pkts.is_empty(), "each frame must produce RTP packets");
        }

        let ts = first[0].header.timestamp;
        assert_eq!(
            second[0].header.timestamp,
            ts.wrapping_add(FRAME_TS_INCREMENT),
            "second frame must be +3000 ticks"
        );
        assert_eq!(
            third[0].header.timestamp,
            ts.wrapping_add(2 * FRAME_TS_INCREMENT),
            "third frame must be +6000 ticks"
        );

        for pkt in first.iter().chain(second.iter()).chain(third.iter()) {
            assert_eq!(pkt.header.payload_type, payload_type);
            assert_eq!(pkt.header.ssrc, ssrc);
            assert!(!pkt.payload.is_empty(), "payload must carry the frame");
        }
        // marker — последний пакет кадра (пир по нему определяет конец кадра).
        assert!(first.last().unwrap().header.marker);
        assert!(third.last().unwrap().header.marker);
    }

    /// Кадр камеры шифруется ТЕМ ЖЕ слоем, что Opus-фрейм:
    /// nonce(24) + XChaCha20-Poly1305(ciphertext + tag 16).
    #[test]
    fn camera_frame_uses_the_same_e2e_layer_as_audio() {
        let key = [0x42u8; 32];
        let vp8_frame = vec![0x30u8; 256];
        let enc = crate::crypto::media_encrypt_frame(&key, &vp8_frame).expect("encrypt");
        assert_ne!(enc, vp8_frame);
        assert_eq!(enc.len(), 24 + vp8_frame.len() + 16);
        let dec = crate::crypto::media_decrypt_frame(&key, &enc).expect("decrypt");
        assert_eq!(dec, vp8_frame);

        // Чужой ключ кадр не расшифрует (E2E не зависит от DTLS-SRTP).
        assert!(crate::crypto::media_decrypt_frame(&[0x43u8; 32], &enc).is_err());
    }

    /// Источник кадров закрылся (камера остановлена) — writer обязан выйти,
    /// иначе таска висит на recv() до конца процесса.
    #[tokio::test]
    async fn write_video_loop_exits_when_frame_source_closes() {
        let (tx, rx) = mpsc::channel::<CameraFrame>(FRAME_CHANNEL_DEPTH);
        let (_stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(write_video_loop(
            test_track(0x1111),
            0x1111,
            crate::media::VP8_PAYLOAD_TYPE,
            rx,
            stop_rx,
            None,
        ));
        drop(tx);
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("writer must exit when the camera channel closes")
            .expect("writer task join");
    }

    /// Звонок закрыт (`CallSession::stop_tx.send(true)`) — writer выходит даже
    /// если камера продолжает слать кадры.
    #[tokio::test]
    async fn write_video_loop_exits_on_call_stop() {
        let (tx, rx) = mpsc::channel::<CameraFrame>(FRAME_CHANNEL_DEPTH);
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(write_video_loop(
            test_track(0x2222),
            0x2222,
            crate::media::VP8_PAYLOAD_TYPE,
            rx,
            stop_rx,
            None,
        ));
        // Кадров не шлём (на desktop их и нет) — только стоп звонка.
        stop_tx.send(true).expect("stop signal");
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("writer must exit on call stop")
            .expect("writer task join");
        drop(tx);
    }

    /// Заглушка desktop: старт/стоп идемпотентны, handle помнит звонок.
    /// (На Android `start_camera` намеренно возвращает Err — см. док модуля.)
    #[cfg(not(target_os = "android"))]
    #[test]
    fn camera_stub_start_and_stop_are_idempotent() {
        let (tx, _rx) = mpsc::channel::<CameraFrame>(FRAME_CHANNEL_DEPTH);
        let handle = start_camera("call-stub", tx).expect("desktop stub must start");
        assert_eq!(handle.call_id(), "call-stub");
        drop(handle); // drop = стоп захвата
        stop_camera();
        stop_camera(); // повторный стоп не паникует
    }
}

