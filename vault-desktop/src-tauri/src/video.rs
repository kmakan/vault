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

// Числа VP8-клока — протокол RTP, поэтому живут в ядре (ADR-005 §W4,
// `t_502b6c90`). Реэкспорт сохраняет прежние пути (`crate::video::…`),
// включая константный контекст `FRAME_DURATION` ниже.
pub use vault_client::vault::call_media::{FRAME_TS_INCREMENT, VIDEO_FPS, VP8_CLOCK_RATE};
use vault_client::vault::call_media::frame_duration_nanos;

/// Длительность кадра для `Sample.duration` — 1/30 с, округлённая ВВЕРХ
/// (33 333 334 нс). `write_sample` считает инкремент как
/// `(duration.as_secs_f64() * clock_rate) as u32`, поэтому «ровные» 33 333 333
/// нс дали бы 2999 тиков вместо 3000 (truncation), а округление вверх —
/// ровно `FRAME_TS_INCREMENT`.
///
/// Формула округления — ядровая (`call_media::frame_duration_nanos`), здесь
/// только превращение в `Duration`: два крейта не должны хранить одну
/// протокольную формулу в двух копиях.
const FRAME_DURATION: Duration = Duration::from_nanos(frame_duration_nanos());

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

    /// Принять кадр от внешнего кодера (WebCodecs в WebView): готовый VP8
    /// битстрим кладётся в канал writer'а. Заменяет платформенный захват.
    /// Full — не ошибка звонка (перегрузка), Closed — writer уже мёртв.
    pub fn accept_frame(&self, data: Vec<u8>) -> Result<(), String> {
        match self.frames_tx.try_send(CameraFrame { data }) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                // Канал переполнен (4 кадра) — дропаем кадр, как нативный
                // захват; лучше потерять fps, чем копить задержку.
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err("video writer closed".to_string()),
        }
    }

    /// Sender для нативного capture-бэкенда (Android camera2 и т.д.).
    pub(crate) fn frame_sender(&self) -> mpsc::Sender<CameraFrame> {
        self.frames_tx.clone()
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
    // Нативный захват — best-effort: если платформенный бэкенд не реализован
    // (Android: camera2+MediaCodec через JNI), writer остаётся жить в
    // «WebCodecs-режиме» — кадры приходит от WebView через
    // `media_video_frame` → `CameraHandle::accept_frame`. Канал у writer'а
    // уже есть (frames_tx клонирован), так что отказ захвата не ломает звонок.
    match start_camera(call_id, frames_tx.clone()) {
        Ok(handle) => Ok(handle),
        Err(reason) => {
            eprintln!(
                "[video] native capture unavailable (call {call_id}: {reason}) — \
                 WebCodecs mode (frames via media_video_frame)"
            );
            Ok(CameraHandle {
                call_id: call_id.to_string(),
                frames_tx,
            })
        }
    }
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

#[cfg(target_os = "linux")]
mod capture {
    //! Захват камеры на десктопе: V4L2 (`/dev/video0`) → I420 → VP8 → канал
    //! RTP-writer'а. Живёт в Rust, потому что WebKitGTK не отдаёт кадры
    //! MediaStream в `<video>` (readyState 0 → VideoFrame бросает
    //! InvalidStateError), и JS-путь WebCodecs на десктопе физически
    //! невозможен. Пиксельный формат — YUYV 4:2:2 (камеры UVC отдают его
    //! нативно, без JPEG-декодера в дереве зависимостей).

    use super::{mpsc, CameraFrame};
    use crate::vp8_encoder::Vp8Encoder;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use v4l::buffer::Type;
    use v4l::io::traits::CaptureStream;
    use v4l::prelude::*;
    use v4l::video::Capture;
    use v4l::FourCC;

    /// Формат захвата совпадает с RTP-треком звонка (640x480, 30 fps, VP8).
    const WIDTH: u32 = 640;
    const HEIGHT: u32 = 480;
    const FPS: u32 = 30;
    const BITRATE_KBPS: u32 = 500;
    const KEYFRAME_EVERY: u32 = 5 * FPS; // 5 с — восстановление после потерь
    const DEVICE_INDEX: usize = 0;

    /// Активный захват: флаг остановки + поток. Один на процесс (звонок 1:1).
    struct ActiveCapture {
        stop: Arc<AtomicBool>,
        join: Option<JoinHandle<()>>,
    }

    static ACTIVE: Mutex<Option<ActiveCapture>> = Mutex::new(None);

    fn active() -> std::sync::MutexGuard<'static, Option<ActiveCapture>> {
        ACTIVE.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Открыть камеру и запустить поток захвата. Ошибки открытия/формата —
    /// синхронные: `media_camera_start` обязан вернуть настоящий отказ, а не
    /// «Ok, но кадров нет» (ровно эта тишина и была дефектом заглушки).
    pub(super) fn start(call_id: &str, frames: mpsc::Sender<CameraFrame>) -> Result<(), String> {
        stop();
        let dev = Device::new(DEVICE_INDEX)
            .map_err(|e| format!("camera /dev/video{DEVICE_INDEX}: {e}"))?;
        let mut fmt = dev.format().map_err(|e| format!("camera format: {e}"))?;
        fmt.width = WIDTH;
        fmt.height = HEIGHT;
        fmt.fourcc = FourCC::new(b"YUYV");
        let fmt = dev
            .set_format(&fmt)
            .map_err(|e| format!("camera set_format: {e}"))?;
        if &fmt.fourcc.repr != b"YUYV" {
            return Err(format!(
                "camera format: драйвер отдал '{}', нужен YUYV",
                String::from_utf8_lossy(&fmt.fourcc.repr)
            ));
        }
        let stride = if fmt.stride > 0 {
            fmt.stride as usize
        } else {
            WIDTH as usize * 2
        };
        let stream = MmapStream::with_buffers(&dev, Type::VideoCapture, 4)
            .map_err(|e| format!("camera stream: {e}"))?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        let flag = stop_flag.clone();
        let cid = call_id.to_string();
        let join = thread::Builder::new()
            .name("vault-camera".into())
            .spawn(move || run(cid, stream, stride, frames, flag))
            .map_err(|e| format!("camera thread: {e}"))?;
        *active() = Some(ActiveCapture {
            stop: stop_flag,
            join: Some(join),
        });
        Ok(())
    }

    /// Остановить поток захвата и дождаться его выхода (камера закрывается
    /// вместе с потоком — драйвер освобождается до следующего звонка).
    pub(super) fn stop() {
        let taken = active().take();
        if let Some(mut a) = taken {
            a.stop.store(true, Ordering::Relaxed);
            if let Some(join) = a.join.take() {
                let _ = join.join();
            }
        }
    }

    fn run(
        call_id: String,
        mut stream: MmapStream<'static>,
        stride: usize,
        frames: mpsc::Sender<CameraFrame>,
        stop: Arc<AtomicBool>,
    ) {
        let mut enc = match Vp8Encoder::new(WIDTH, HEIGHT, FPS, BITRATE_KBPS, KEYFRAME_EVERY) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[video] camera encoder failed (call {call_id}): {e}");
                return;
            }
        };
        let w = WIDTH as usize;
        let h = HEIGHT as usize;
        let mut i420: Vec<u8> = Vec::with_capacity(w * h * 3 / 2);
        let mut encoded: u64 = 0;
        while !stop.load(Ordering::Relaxed) && !frames.is_closed() {
            {
                let (buf, _meta) = match stream.next() {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[video] camera read error (call {call_id}): {e}");
                        thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                };
                yuyv_to_i420(buf, w, h, stride, &mut i420);
            }
            let key = encoded % KEYFRAME_EVERY as u64 == 0;
            match enc.encode_i420(&i420, key) {
                Ok(Some(data)) => {
                    encoded += 1;
                    if encoded == 1 || encoded % (FPS as u64 * 5) == 0 {
                        eprintln!(
                            "[video] camera frames={encoded} bytes={} (call {call_id})",
                            data.len()
                        );
                    }
                    // Full — перегрузка writer'а: дропаем кадр (низкая
                    // задержка важнее fps). Closed — writer уже мёртв.
                    if frames.try_send(CameraFrame { data }).is_err() && frames.is_closed() {
                        break;
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("[video] camera encode error (call {call_id}): {e}");
                }
            }
        }
        eprintln!("[video] camera capture finished (call {call_id}, frames={encoded})");
    }

    /// YUYV 4:2:2 → I420 (YUV420p). Раскладка YUYV: [Y0 U Y1 V] на две точки;
    /// для I420 U/V берутся через строку, поэтому фильтр не нужен (усреднение
    /// по 2x2 даёт драйвер/DSP камеры — здесь только переупаковка).
    pub(super) fn yuyv_to_i420(src: &[u8], w: usize, h: usize, stride: usize, dst: &mut Vec<u8>) {
        let y_size = w * h;
        let uv_size = (w / 2) * (h / 2);
        dst.clear();
        dst.resize(y_size + 2 * uv_size, 128);
        for row in 0..h {
            let start = row * stride;
            if start + w * 2 > src.len() {
                return;
            }
            let src_row = &src[start..start + w * 2];
            for col in (0..w).step_by(2) {
                let i = col * 2;
                dst[row * w + col] = src_row[i];
                dst[row * w + col + 1] = src_row[i + 2];
                if row % 2 == 0 {
                    let uv = y_size + (row / 2) * (w / 2) + col / 2;
                    dst[uv] = src_row[i + 1];
                    dst[uv + uv_size] = src_row[i + 3];
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
mod capture {
    use super::{mpsc, CameraFrame};

    /// macOS/Windows: платформенного захвата пока нет — честная ошибка, чтобы
    /// команда не делала вид, что камера работает (тот же принцип, что Android).
    pub(super) fn start(call_id: &str, _frames: mpsc::Sender<CameraFrame>) -> Result<(), String> {
        Err(format!(
            "camera capture is not implemented on this platform yet (call {call_id})"
        ))
    }

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

    /// Очередь кадров короткая НАМЕРЕННО: при отставании writer'а лучше
    /// потерять кадр, чем копить задержку. Отсюда два разных ответа:
    /// переполнение — не ошибка звонка, закрытый writer — ошибка.
    #[test]
    fn frame_queue_holds_four_and_overflow_is_not_a_call_error() {
        let (tx, mut rx) = mpsc::channel::<CameraFrame>(FRAME_CHANNEL_DEPTH);
        let handle = CameraHandle {
            call_id: "queue".to_owned(),
            frames_tx: tx,
        };
        for _ in 0..(FRAME_CHANNEL_DEPTH + 2) {
            handle
                .accept_frame(vec![0x10; 8])
                .expect("перегрузка очереди — не ошибка звонка");
        }
        let mut held = 0usize;
        while rx.try_recv().is_ok() {
            held += 1;
        }
        assert_eq!(held, 4, "в очереди обязано лежать ровно четыре кадра");
        drop(handle);

        let (tx2, rx2) = mpsc::channel::<CameraFrame>(FRAME_CHANNEL_DEPTH);
        drop(rx2);
        let orphan = CameraHandle {
            call_id: "orphan".to_owned(),
            frames_tx: tx2,
        };
        let err = orphan
            .accept_frame(vec![0x10; 8])
            .expect_err("писать в закрытый writer — ошибка, а не «кадр принят»");
        assert!(err.contains("closed"), "текст ошибки: {err}");
    }

    /// Маркер захвата один на процесс, поэтому освобождение обязано быть
    /// адресным: drop чужого handle'а не гасит чужой захват, а `stop_camera`
    /// обязан снять маркер — иначе следующий звонок камеру не получит.
    #[test]
    fn capture_bookkeeping_releases_only_its_own_call() {
        static SERIAL: Mutex<()> = Mutex::new(());
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());

        *capturing() = Some("другой-звонок".to_owned());
        release_capture("наш-звонок");
        assert_eq!(
            capturing().as_deref(),
            Some("другой-звонок"),
            "drop чужого handle'а погасил чужой захват"
        );
        release_capture("другой-звонок");
        assert!(capturing().is_none(), "свой захват обязан быть отпущен");

        *capturing() = Some("звоним".to_owned());
        stop_camera();
        assert!(capturing().is_none(), "stop_camera не освободил маркер");
        stop_camera();
        assert!(capturing().is_none(), "повторный стоп не должен ничего вернуть");
    }

    /// Стоп камеры идемпотентен и не требует железа (раньше тест «стартовал
    /// заглушку»; теперь на Linux старт реально открывает /dev/videoN, поэтому
    /// в тестах камеру не трогаем — иначе CI без камеры краснеет).
    #[test]
    fn stop_camera_is_idempotent() {
        // Тот же процесс-глобалный маркер, что у пробы выше.
        static SERIAL: Mutex<()> = Mutex::new(());
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        stop_camera();
        stop_camera(); // повторный стоп не паникует
    }

    /// Драйвер отдаёт строку с padding'ом (stride больше 2·ширины), а U/V
    /// берутся только из чётных строк и по одной паре на два пикселя. Проба
    /// именно с stride 12 при ширине 4: без неё подстановка `row * w * 2`
    /// (игнор stride) неотличима от правильного кода.
    #[cfg(target_os = "linux")]
    #[test]
    fn yuyv_honors_driver_stride_and_even_rows() {
        let src: Vec<u8> = vec![
            10, 100, 20, 200, 11, 101, 21, 201, 0xFF, 0xFF, 0xFF, 0xFF, 30, 110, 40, 111, 31,
            112, 41, 113, 0xFF, 0xFF, 0xFF, 0xFF,
        ];
        let mut out = Vec::new();
        capture::yuyv_to_i420(&src, 4, 2, 12, &mut out);
        assert_eq!(out.len(), 8 + 2 * 2, "Y(8) + U(2) + V(2)");
        assert_eq!(&out[0..4], &[10, 20, 11, 21], "Y первой строки");
        assert_eq!(
            &out[4..8],
            &[30, 40, 31, 41],
            "вторая строка читается со stride, а не с 2·ширины"
        );
        assert_eq!(&out[8..10], &[100, 101], "U — из чётной строки, по паре пикселей");
        assert_eq!(&out[10..12], &[200, 201], "V — из чётной строки, по паре пикселей");
    }

    /// ЖИВОЙ прогон камеры (не для CI — нужен /dev/video0):
    /// V4L2 YUYV → I420 → VP8. Помечен `#[ignore]`, запуск явно:
    ///   cargo test --lib capture_live -- --ignored --nocapture
    /// Ловит и «камера не открылась», и «кадры не кодируются» — отдельно от
    /// звонка, чтобы не путать отказ захвата с отказом сигнализации.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore]
    async fn capture_live_delivers_vp8_frames() {
        let (tx, mut rx) = mpsc::channel::<CameraFrame>(FRAME_CHANNEL_DEPTH);
        capture::start("live-test", tx).expect("camera must open");
        let mut got = 0usize;
        let mut first_len = 0usize;
        while got < 3 {
            let frame = tokio::time::timeout(Duration::from_secs(10), rx.recv())
                .await
                .expect("кадров нет за 10с")
                .expect("канал захвата закрылся");
            assert!(!frame.data.is_empty(), "пустой VP8-кадр");
            if got == 0 {
                first_len = frame.data.len();
                // VP8 frame_tag: бит 0 = 0 → ключевой кадр.
                assert_eq!(frame.data[0] & 1, 0, "первый кадр обязан быть ключевым");
            }
            got += 1;
        }
        capture::stop();
        eprintln!("[test] live camera: {got} VP8-кадров, первый {first_len} байт");
    }

    /// YUYV → I420: переупаковка без потерь. Кадр 2x2: две пары [Y U Y V].
    /// Проверяем Y обоих пикселей, U/V одной пары и что размер = 3/2 кадра.
    #[cfg(target_os = "linux")]
    #[test]
    fn yuyv_to_i420_packs_planes() {
        // 2x2: строка 0 = Y0=10 U=100 Y1=20 V=200; строка 1 = 30/40, те же U/V.
        let src: Vec<u8> = vec![10, 100, 20, 200, 30, 100, 40, 200];
        let mut out = Vec::new();
        capture::yuyv_to_i420(&src, 2, 2, 4, &mut out);
        assert_eq!(out.len(), 6, "2x2 → Y(4) + U(1) + V(1)");
        assert_eq!(&out[0..4], &[10, 20, 30, 40], "Y-плоскость построчно");
        assert_eq!(out[4], 100, "U берётся из чётной строки");
        assert_eq!(out[5], 200, "V берётся из чётной строки");
    }
}
