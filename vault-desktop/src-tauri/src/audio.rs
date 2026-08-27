//! Audio pipeline for calls (M3, Phase 2.1): cpal capture/playback + audiopus.
//!
//! Mic: cpal input stream (callback thread) → PCM → (buffer 20ms) → Opus
//! encode → `tokio::mpsc` → async writer task → `TrackLocalStaticSample`
//! `write_sample` (library does RTP packetization + sequencing).
//!
//! Speaker: async reader task polls the remote `TrackRemote` → `OnRtpPacket`
//! → Opus decode → `std::sync::mpsc` → cpal output stream (callback plays).
//!
//! Devices are opened with their DEFAULT config; conversion to 48kHz mono
//! (encode side) / from 48kHz mono (play side) happens in the callbacks with
//! a linear resampler when the device rate differs.
//!
//! Platform audio I/O (27.08): desktop — cpal; Android — oboe/AAudio
//! (`audio_android`), т.к. cpal на Android идёт через JNI и паникует при
//! старте (panic=abort → приложение сворачивается). Opus/шифрование/RTP —
//! общие, меняется только захват/воспроизведение.

#[cfg(target_os = "android")]
mod audio_android;

use std::sync::Arc;
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
#[cfg(not(target_os = "android"))]
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use audiopus::coder::Decoder;
#[cfg(not(target_os = "android"))]
use audiopus::coder::Encoder;
use audiopus::{Channels as OpusChannels, SampleRate};
#[cfg(not(target_os = "android"))]
use audiopus::Application;
use bytes::Bytes;
#[cfg(not(target_os = "android"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(not(target_os = "android"))]
use cpal::Sample as _;
use tokio::sync::watch;

use rtc::media::Sample;
use rtc::shared::time::SystemInstant;

use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};

// Desktop (27.08): программный AEC/NS/AGC — WebRTC AudioProcessingModule.
// Убирает акустическую петлю (динамики → микрофон) и клиппинг. Android не
// нужен: там аппаратный AEC через InputPreset::VoiceCommunication (oboe).
#[cfg(not(target_os = "android"))]
use webrtc_audio_processing::Processor;
#[cfg(not(target_os = "android"))]
use webrtc_audio_processing::config::{
    Config as ApmConfig, EchoCanceller, GainController, GainController1, GainControllerMode,
    HighPassFilter, NoiseSuppression, NoiseSuppressionLevel,
};

/// Дескриптор APM для пайплайна. Desktop — WebRTC-процессор (общий для mic и
/// speaker через Arc); Android — `()` (аппаратный AEC, софт не участвует).
#[cfg(not(target_os = "android"))]
pub(crate) type Apm = Option<Arc<Processor>>;
#[cfg(target_os = "android")]
pub(crate) type Apm = ();

/// 10мс-фрейм APM @ 48kHz (WebRTC фиксирован на 10мс). 20мс Opus-фрейм (960)
/// обрабатывается двумя такими кусками.
#[cfg(not(target_os = "android"))]
const APM_FRAME: usize = 480;

/// Создать APM: AEC3 (полный) + шумодав High + AGC (AdaptiveDigital, без
/// аналогового гейта — мы не управляем OS-миксером) + high-pass.
#[cfg(not(target_os = "android"))]
fn create_apm() -> Result<Arc<Processor>, String> {
    let ap = Processor::new(48000).map_err(|e| format!("APM new: {e}"))?;
    let config = ApmConfig {
        echo_canceller: Some(EchoCanceller::Full { stream_delay_ms: None }),
        noise_suppression: Some(NoiseSuppression {
            level: NoiseSuppressionLevel::High,
            analyze_linear_aec_output: false,
        }),
        gain_controller: Some(GainController::GainController1(GainController1 {
            mode: GainControllerMode::AdaptiveDigital,
            target_level_dbfs: 3,
            compression_gain_db: 9,
            enable_limiter: true,
            analog_gain_controller: None,
        })),
        high_pass_filter: Some(HighPassFilter::default()),
        ..Default::default()
    };
    ap.set_config(config);
    Ok(Arc::new(ap))
}

/// Обработать 20мс capture-фрейм (960 сэмплов @48k mono) через APM двумя
/// 10мс-кусками (WebRTC фиксирован на 10мс). No-op без APM.
#[cfg(not(target_os = "android"))]
fn apm_capture(apm: &Apm, frame: &mut [f32]) {
    if let Some(ap) = apm {
        for chunk in frame.chunks_exact_mut(APM_FRAME) {
            let _ = ap.process_capture_frame(std::iter::once(chunk));
        }
    }
}
#[cfg(target_os = "android")]
fn apm_capture(_apm: &Apm, _frame: &mut [f32]) {}

/// Скормить APM reference-сигнал (far-end, то что играет в динамиках) для AEC.
/// 48kHz mono, куски по 10мс. No-op без APM.
#[cfg(not(target_os = "android"))]
fn apm_render(apm: &Apm, frame: &[f32]) {
    if let Some(ap) = apm {
        for chunk in frame.chunks_exact(APM_FRAME) {
            let _ = ap.analyze_render_frame(std::iter::once(chunk));
        }
    }
}
#[cfg(target_os = "android")]
fn apm_render(_apm: &Apm, _frame: &[f32]) {}

/// 20ms frame @ 48kHz mono — the Opus frame size we use end-to-end.
pub(crate) const FRAME_SAMPLES: usize = 960;
const FRAME_DURATION: Duration = Duration::from_millis(20);
/// Max opus frame buffer (120ms @48k mono = 5760 samples).
const DECODE_BUF: usize = 5760;

/// Mic stream for a concrete sample format: device samples → mono f32 →
/// resample → 20ms frames → Opus encode (float) → channel to the writer.
#[cfg(not(target_os = "android"))]
macro_rules! build_mic {
    ($device:expr, $cfg:expr, $device_rate:expr, $ch:expr, $opus_tx:expr, $muted:expr, $apm:expr, $fmt:ty) => {{
        let mut encoder =
            Encoder::new(SampleRate::Hz48000, OpusChannels::Mono, Application::Voip)
                .map_err(|e| e.to_string())?;
        let mut resampler = ResamplerIn::new($device_rate, 48000);
        let mut buf: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES);
        let stream = $device
            .build_input_stream(
                $cfg.clone().into(),
                move |data: &[$fmt], _| {
                    if $muted.load(Ordering::Relaxed) {
                        return;
                    }
                    for chunk in data.chunks($ch) {
                        let avg: f32 =
                            chunk.iter().map(|s| (*s).to_sample::<f32>()).sum::<f32>()
                                / $ch as f32;
                        if resampler.push() {
                            buf.push(avg);
                            if buf.len() >= FRAME_SAMPLES {
                                let mut frame: Vec<f32> = buf.drain(..FRAME_SAMPLES).collect();
                                // AEC/NS/AGC (27.08): обрабатываем capture-фрейм
                                // ДО кодирования — убираем петлю и клиппинг.
                                apm_capture(&$apm, &mut frame);
                                // RMS микрофона (диагностика 23.08): каждые
                                // ~0.4с — реальный уровень захвата. Если mic
                                // тихий (rms < 0.01) — проблема устройства,
                                // а не кодека.
                                static MIC_CNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                                let mc = MIC_CNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                if mc % 20 == 0 {
                                    let mic_rms: f32 = (frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32).sqrt();
                                    eprintln!("[audio] mic rms={mic_rms:.4}");
                                }
                                let mut out = [0u8; 4000];
                                if let Ok(n) = encoder.encode_float(&frame, &mut out) {
                                    let _ = $opus_tx.try_send(out[..n].to_vec());
                                }
                            }
                        }
                    }
                },
                |e| eprintln!("[audio] mic stream error: {e}"),
                None,
            )
            .map_err(|e| e.to_string())?;
        Ok(stream)
    }};
}

/// Speaker stream for a concrete sample format: fills the device buffer from
/// decoded PCM chunks (48kHz mono), resampling to the device rate; silence
/// when no data yet.
#[cfg(not(target_os = "android"))]
macro_rules! build_speaker {
    ($device:expr, $cfg:expr, $device_rate:expr, $ch:expr, $pcm_rx:expr, $fmt:ty) => {{
        let mut pending: Vec<f32> = Vec::new();
        let mut resampler = ResamplerOut::new(48000, $device_rate);
        let mut last: f32 = 0.0;
        let mut slot: usize = 0;
        let stream = $device
            .build_output_stream(
                $cfg.clone().into(),
                move |data: &mut [$fmt], _| {
                    for out in data.iter_mut() {
                        if slot % $ch == 0 && resampler.tick() {
                            if pending.is_empty() {
                                if let Ok(chunk) = $pcm_rx.try_recv() {
                                    pending = chunk;
                                }
                            }
                            if !pending.is_empty() {
                                last = pending.remove(0);
                            }
                        }
                        *out = last.to_sample::<$fmt>();
                        slot += 1;
                    }
                },
                |e| eprintln!("[audio] speaker stream error: {e}"),
                None,
            )
            .map_err(|e| e.to_string())?;
        Ok(stream)
    }};
}

/// Input resampler (device rate → 48kHz): emits the current input sample
/// every `to/from` inputs.
pub(crate) struct ResamplerIn {
    step: f64,
    pos: f64,
}

impl ResamplerIn {
    pub(crate) fn new(from: u32, to: u32) -> Self {
        Self { step: to as f64 / from as f64, pos: 0.0 }
    }
    /// Returns true when this input should be emitted (kept as output).
    fn push(&mut self) -> bool {
        self.pos += self.step;
        if self.pos >= 1.0 {
            self.pos -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Output resampler (48kHz → device rate): tells the callback when an output
/// slot consumes a NEW input sample (otherwise repeats the last one).
pub(crate) struct ResamplerOut {
    step: f64,
    pos: f64,
}

impl ResamplerOut {
    pub(crate) fn new(from: u32, to: u32) -> Self {
        Self { step: from as f64 / to as f64, pos: 1.0 }
    }
    fn tick(&mut self) -> bool {
        self.pos += self.step;
        if self.pos >= 1.0 {
            self.pos -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Run the audio pipeline for a connected call: mic → opus → local track,
/// remote track → opus → speaker. Best-effort: missing mic/speaker only logs.
/// Exits when the PC is closed (`stop_rx`) or the track write/poll fails.
pub async fn run_audio_pipeline(
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    payload_type: u8,
    mut remote_track_rx: webrtc::runtime::Receiver<Arc<dyn TrackRemote>>,
    mut stop_rx: watch::Receiver<bool>,
    muted: Arc<AtomicBool>,
    media_key: Option<[u8; 32]>,
) {
    // ВАЖНО (23.08): rtc вызывает on_track ТОЛЬКО на ПЕРВОМ RTP-пакете пира
    // (rtc-0.20 handler/endpoint.rs: «Fire OnOpen when received the first RTP
    // packet»). Раньше мы ждали remote-трек ДО старта микрофона → обе стороны
    // ждали друг друга и никто не слал RTP: вечный deadlock, звука нет.
    // Теперь микрофон + writer стартуют СРАЗУ (RTP идёт, on_track срабатывает
    // у пира), а remote-трек ждём параллельно в отдельной таске.

    // APM (27.08): общий для mic (capture) и speaker (render/reference).
    // Desktop — WebRTC AEC3+NS+AGC; Android — () (аппаратный AEC).
    #[cfg(not(target_os = "android"))]
    let apm: Apm = match create_apm() {
        Ok(a) => { eprintln!("[audio] APM ready (AEC3+NS+AGC)"); Some(a) }
        Err(e) => { eprintln!("[audio] APM unavailable, raw capture: {e}"); None }
    };
    #[cfg(target_os = "android")]
    let apm: Apm = ();

    // Mic → local track (стартует немедленно).
    let (opus_tx, opus_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let mic_stream = match start_mic_capture(opus_tx, muted.clone(), apm.clone()) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[audio] mic capture unavailable: {e}");
            None
        }
    };
    let writer = tokio::spawn(write_opus_loop(
        track.clone(), ssrc, payload_type, opus_rx, stop_rx.clone(), media_key,
    ));

    // Remote track → speaker (появляется после первого RTP от пира).
    let (pcm_tx, pcm_rx) = channel::<Vec<f32>>();
    let speaker_stream = match start_speaker(pcm_rx) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[audio] speaker unavailable: {e}");
            None
        }
    };
    let reader = tokio::spawn(async move {
        let remote_track = tokio::select! {
            t = remote_track_rx.recv() => match t { Some(t) => t, None => return },
            _ = stop_rx.changed() => return,
        };
        eprintln!("[audio] remote track received — playing");
        read_remote_loop(remote_track, pcm_tx, stop_rx, media_key, apm).await;
    });

    // Keep streams alive; the loops exit when the PC is closed.
    let _ = writer.await;
    let _ = reader.await;
    drop(mic_stream);
    drop(speaker_stream);
    eprintln!("[audio] pipeline finished");
}

// ── Mic capture ────────────────────────────────────────────────────────────

/// Живой дескриптор аудио-устройства: держим до конца звонка, drop = stop.
/// Desktop — cpal::Stream, Android — oboe AudioStreamAsync (drop = close).
enum AudioStreamHandle {
    #[cfg(not(target_os = "android"))]
    Cpal(cpal::Stream),
    #[cfg(target_os = "android")]
    OboeInput(audio_android::MicStream),
    #[cfg(target_os = "android")]
    OboeOutput(audio_android::SpeakerStream),
}

#[cfg(not(target_os = "android"))]
fn start_mic_capture(
    opus_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    muted: Arc<AtomicBool>,
    apm: Apm,
) -> Result<AudioStreamHandle, String> {
    start_mic_capture_cpal(opus_tx, muted, apm).map(AudioStreamHandle::Cpal)
}

#[cfg(target_os = "android")]
fn start_mic_capture(
    opus_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    muted: Arc<AtomicBool>,
    _apm: Apm,
) -> Result<AudioStreamHandle, String> {
    audio_android::start_mic_capture_oboe(opus_tx, muted).map(AudioStreamHandle::OboeInput)
}

#[cfg(not(target_os = "android"))]
fn start_mic_capture_cpal(
    opus_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    muted: Arc<AtomicBool>,
    apm: Apm,
) -> Result<cpal::Stream, String> {
    // panic=abort: cpal может паниковать — ловим (26.08).
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        start_mic_capture_inner(opus_tx, muted, apm)
    })) {
        Ok(r) => r,
        Err(_) => {
            eprintln!("[audio] panic in mic capture — caught");
            Err("panic in mic init".into())
        }
    }
}
#[cfg(not(target_os = "android"))]
fn start_mic_capture_inner(
    opus_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    muted: Arc<AtomicBool>,
    apm: Apm,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    let cfg = device.default_input_config().map_err(|e| e.to_string())?;
    let device_rate = cfg.sample_rate();
    let ch = cfg.channels() as usize;

    let stream_result: Result<cpal::Stream, String> = match cfg.sample_format() {
        cpal::SampleFormat::F32 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, apm, f32),
        cpal::SampleFormat::I16 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, apm, i16),
        cpal::SampleFormat::U16 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, apm, u16),
        cpal::SampleFormat::I32 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, apm, i32),
        cpal::SampleFormat::F64 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, apm, f64),
        other => return Err(format!("unsupported input format {other:?}")),
    };
    let stream = stream_result?;
    stream.play().map_err(|e| e.to_string())?;
    eprintln!("[audio] mic open: {} @ {}Hz", cfg.sample_format(), device_rate);
    Ok(stream)
}

/// Async writer: opus frames → RTP (packetized by the library) → local track.
async fn write_opus_loop(
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    payload_type: u8,
    mut rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    mut stop_rx: watch::Receiver<bool>,
    media_key: Option<[u8; 32]>,
) {
    loop {
        tokio::select! {
            frame = rx.recv() => {
                let Some(frame) = frame else { break };
                // E2E-шифрование медиа (26.08, как SimpleX): каждый Opus-фрейм
                // XChaCha20-Poly1305 поверх DTLS-SRTP — defence in depth.
                let frame = match &media_key {
                    Some(k) => match crate::crypto::media_encrypt_frame(k, &frame) {
                        Ok(f) => f,
                        Err(e) => { eprintln!("[audio] media encrypt: {e}"); continue; }
                    },
                    None => frame,
                };
                let sample = Sample {
                    data: Bytes::from(frame),
                    timestamp: SystemInstant::now(),
                    duration: FRAME_DURATION,
                    ..Default::default()
                };
                if let Err(e) = track.write_sample(ssrc, payload_type, &sample, &[]).await {
                    eprintln!("[audio] write_sample: {e}");
                    break;
                }
            }
            _ = stop_rx.changed() => break,
        }
    }
}

// ── Speaker playback ────────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
fn start_speaker(pcm_rx: Receiver<Vec<f32>>) -> Result<AudioStreamHandle, String> {
    start_speaker_cpal(pcm_rx).map(AudioStreamHandle::Cpal)
}

#[cfg(target_os = "android")]
fn start_speaker(pcm_rx: Receiver<Vec<f32>>) -> Result<AudioStreamHandle, String> {
    audio_android::start_speaker_oboe(pcm_rx).map(AudioStreamHandle::OboeOutput)
}

#[cfg(not(target_os = "android"))]
fn start_speaker_cpal(pcm_rx: Receiver<Vec<f32>>) -> Result<cpal::Stream, String> {
    // panic=abort: cpal может паниковать — ловим (26.08).
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        start_speaker_inner(pcm_rx)
    })) {
        Ok(r) => r,
        Err(_) => {
            eprintln!("[audio] panic in speaker init — caught");
            Err("panic in speaker init".into())
        }
    }
}
#[cfg(not(target_os = "android"))]
fn start_speaker_inner(pcm_rx: Receiver<Vec<f32>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default output device".to_string())?;
    let cfg = device.default_output_config().map_err(|e| e.to_string())?;
    let device_rate = cfg.sample_rate();
    let ch = cfg.channels() as usize;

    let stream_result: Result<cpal::Stream, String> = match cfg.sample_format() {
        cpal::SampleFormat::F32 => build_speaker!(device, cfg, device_rate, ch, pcm_rx, f32),
        cpal::SampleFormat::I16 => build_speaker!(device, cfg, device_rate, ch, pcm_rx, i16),
        cpal::SampleFormat::U16 => build_speaker!(device, cfg, device_rate, ch, pcm_rx, u16),
        cpal::SampleFormat::I32 => build_speaker!(device, cfg, device_rate, ch, pcm_rx, i32),
        cpal::SampleFormat::F64 => build_speaker!(device, cfg, device_rate, ch, pcm_rx, f64),
        other => return Err(format!("unsupported output format {other:?}")),
    };
    let stream = stream_result?;
    stream.play().map_err(|e| e.to_string())?;
    eprintln!("[audio] speaker open: {} @ {}Hz", cfg.sample_format(), device_rate);
    Ok(stream)
}

/// Async reader: remote RTP packets → Opus decode → PCM chunks → speaker.
async fn read_remote_loop(
    track: Arc<dyn TrackRemote>,
    pcm_tx: Sender<Vec<f32>>,
    mut stop_rx: watch::Receiver<bool>,
    media_key: Option<[u8; 32]>,
    apm: Apm,
) {
    let mut decoder = match Decoder::new(SampleRate::Hz48000, OpusChannels::Mono) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[audio] opus decoder: {e}");
            return;
        }
    };
    loop {
        tokio::select! {
            ev = track.poll() => {
                let Some(ev) = ev else { break };
                match ev {
                    TrackRemoteEvent::OnRtpPacket(pkt) => {
                        // E2E-расшифровка медиа (26.08): обратная операция.
                        let payload = match &media_key {
                            Some(k) => match crate::crypto::media_decrypt_frame(k, &pkt.payload) {
                                Ok(p) => p,
                                Err(e) => { eprintln!("[audio] media decrypt: {e}"); continue; }
                            },
                            None => pkt.payload.to_vec(),
                        };
                        let mut out = vec![0f32; DECODE_BUF];
                        if let Ok(n) = decoder.decode_float(Some(&payload[..]), &mut out[..], false) {
                            out.truncate(n);
                            // AEC reference (27.08): скормить APM far-end сигнал
                            // (то, что сейчас играет в динамиках) — без этого
                            // эхоподавление не знает, что вычитать из микрофона.
                            apm_render(&apm, &out);
                            // RMS (диагностика шума 23.08): уровень принятого
                            // аудио — каждые 20-й пакет. Если rms > 0.05, это
                            // реальный звук, не тишина.
                            static PKT_CNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                            let c = PKT_CNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            if c % 20 == 0 && !out.is_empty() {
                                let rms: f32 = (out.iter().map(|s| s * s).sum::<f32>() / out.len() as f32).sqrt();
                                eprintln!("[audio] remote rms={rms:.4}  pkt_bytes={}  decoded={n}", pkt.payload.len());
                            }
                            let _ = pcm_tx.send(out);
                        }
                    }
                    TrackRemoteEvent::OnEnded | TrackRemoteEvent::OnEnding => break,
                    _ => {}
                }
            }
            _ = stop_rx.changed() => break,
        }
    }
}

// ── Звуки звонка (27.08, редизайн): WAV-ассеты вместо осциллятора 440 Гц ─────
// Desktop: проигрываются через cpal (напрямую из Rust, не webview) — не зависят
// от autoplay-политики WebKitGTK, слышны при свёрнутом окне. WAV вшиты в бинарь
// (include_bytes!), ресемплятся под устройство линейной интерполяцией.
// Android (26.08): cpal НЕ используется (AAudio через JNI паникует) — звуки
// играет фронт через HTML5 Audio (public/sounds/*.wav), здесь no-op.
//
// ring_incoming / ring_outgoing — зацикленные (loop=true), останавливаются
// ringtone_stop / sound_stop. connect / end / missed — одноразовые.

#[cfg(not(target_os = "android"))]
static RINGTONE: Mutex<Option<cpal::Stream>> = Mutex::new(None);

#[cfg(not(target_os = "android"))]
const SND_INCOMING: &[u8] = include_bytes!("../sounds/ring_incoming.wav");
#[cfg(not(target_os = "android"))]
const SND_OUTGOING: &[u8] = include_bytes!("../sounds/ring_outgoing.wav");
#[cfg(not(target_os = "android"))]
const SND_CONNECT: &[u8] = include_bytes!("../sounds/ring_connect.wav");
#[cfg(not(target_os = "android"))]
const SND_END: &[u8] = include_bytes!("../sounds/ring_end.wav");
#[cfg(not(target_os = "android"))]
const SND_MISSED: &[u8] = include_bytes!("../sounds/ring_missed.wav");

/// Минимальный парсер WAV: PCM 16-bit mono (наши ассеты генерируются именно
/// так). Возвращает (samples_f32, sample_rate).
#[cfg(not(target_os = "android"))]
fn parse_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut pos = 12usize;
    let (mut rate, mut bits, mut channels) = (0u32, 0u16, 0u16);
    let mut data: Option<&[u8]> = None;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = pos + 8;
        if body + size > bytes.len() {
            break;
        }
        if id == b"fmt " {
            channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap());
            rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
            bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
        } else if id == b"data" {
            data = Some(&bytes[body..body + size]);
        }
        pos = body + size + (size & 1); // чанки выравниваются по 2 байта
    }
    let data = data.ok_or("no data chunk")?;
    if bits != 16 {
        return Err(format!("unsupported bit depth {bits}"));
    }
    let mut samples: Vec<f32> = Vec::with_capacity(data.len() / 2);
    for chunk in data.chunks_exact(2) {
        let v = i16::from_le_bytes([chunk[0], chunk[1]]);
        samples.push(v as f32 / 32768.0);
    }
    // Стерео → моно (наши ассеты моно, но на всякий случай).
    if channels == 2 {
        let mut mono = Vec::with_capacity(samples.len() / 2);
        for pair in samples.chunks_exact(2) {
            mono.push((pair[0] + pair[1]) * 0.5);
        }
        samples = mono;
    } else if channels != 1 {
        return Err(format!("unsupported channel count {channels}"));
    }
    if rate == 0 {
        return Err("bad sample rate".into());
    }
    Ok((samples, rate))
}

/// Линейный ресемпл моно f32 из src_rate в dst_rate.
#[cfg(not(target_os = "android"))]
fn resample(samples: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = src_rate as f64 / dst_rate as f64;
    let out_len = ((samples.len() as f64) / ratio) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 * ratio;
        let idx = src_pos as usize;
        let frac = (src_pos - idx as f64) as f32;
        let a = samples[idx.min(samples.len() - 1)];
        let b = samples[(idx + 1).min(samples.len() - 1)];
        out.push(a + (b - a) * frac);
    }
    out
}

#[cfg(not(target_os = "android"))]
macro_rules! build_sound_stream {
    ($device:expr, $cfg:expr, $fmt:ty, $pcm:expr, $looped:expr) => {{
        let pcm: Arc<Vec<f32>> = Arc::new($pcm);
        let looped = $looped;
        let mut pos: usize = 0;
        let stream = $device
            .build_output_stream(
                $cfg.clone().into(),
                move |data: &mut [$fmt], _| {
                    let n = pcm.len();
                    for out in data.iter_mut() {
                        let v: f32 = if n == 0 {
                            0.0
                        } else if pos < n {
                            let s = pcm[pos];
                            pos += 1;
                            s
                        } else if looped {
                            pos = 1;
                            pcm[0]
                        } else {
                            0.0 // одноразовый: тишина после конца
                        };
                        *out = (v * 0.9).to_sample::<$fmt>();
                    }
                },
                |e| eprintln!("[sound] stream error: {e}"),
                None,
            )
            .map_err(|e| e.to_string())?;
        stream.play().map_err(|e| e.to_string())?; // cpal 0.18: поток НЕ играет без play()
        *RINGTONE.lock().unwrap() = Some(stream);
        Ok(())
    }};
}

/// Общий запуск звука по имени ассета. looped=true — крутить до stop.
#[cfg(not(target_os = "android"))]
pub fn sound_play(name: &str, looped: bool) -> Result<(), String> {
    let bytes: &[u8] = match name {
        "incoming" => SND_INCOMING,
        "outgoing" => SND_OUTGOING,
        "connect" => SND_CONNECT,
        "end" => SND_END,
        "missed" => SND_MISSED,
        other => return Err(format!("unknown sound: {other}")),
    };
    // panic=abort + cpal может паниковать — ловим и возвращаем Err вместо
    // мгновенного убийства процесса (26.08).
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        _sound_play_inner(bytes, looped)
    }));
    match result {
        Ok(r) => r,
        Err(_) => {
            eprintln!("[sound] panic in cpal — caught (panic=abort)");
            Err("panic in audio init".into())
        }
    }
}

#[cfg(not(target_os = "android"))]
fn _sound_play_inner(bytes: &[u8], looped: bool) -> Result<(), String> {
    // Останавливаем предыдущий звук (если играл).
    if let Some(s) = RINGTONE.lock().unwrap().take() {
        drop(s);
    }
    let (samples, rate) = parse_wav(bytes)?;
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "No output device for sound".to_string())?;
    let cfg = device
        .default_output_config()
        .map_err(|e| e.to_string())?;
    let device_rate = cfg.sample_rate();
    let pcm = resample(&samples, rate, device_rate);
    eprintln!(
        "[sound] play {} ({} samples @{} -> {}Hz, looped={})",
        if looped { "loop" } else { "once" },
        pcm.len(),
        rate,
        device_rate,
        looped
    );
    match cfg.sample_format() {
        cpal::SampleFormat::F32 => build_sound_stream!(device, cfg, f32, pcm, looped),
        cpal::SampleFormat::I16 => build_sound_stream!(device, cfg, i16, pcm, looped),
        cpal::SampleFormat::U16 => build_sound_stream!(device, cfg, u16, pcm, looped),
        cpal::SampleFormat::I32 => build_sound_stream!(device, cfg, i32, pcm, looped),
        cpal::SampleFormat::F64 => build_sound_stream!(device, cfg, f64, pcm, looped),
        other => Err(format!("unsupported sample format {other:?}")),
    }
}

#[cfg(not(target_os = "android"))]
pub fn sound_stop() {
    if let Some(s) = RINGTONE.lock().unwrap().take() {
        drop(s);
    }
}

// Совместимость: старый API рингтона = звук incoming (loop).
#[cfg(not(target_os = "android"))]
pub fn ringtone_start() -> Result<(), String> {
    sound_play("incoming", true)
}
#[cfg(not(target_os = "android"))]
pub fn ringtone_stop() {
    sound_stop();
}

// Android: звуки играет фронт через HTML5 Audio (не cpal) — no-op заглушки.
#[cfg(target_os = "android")]
pub fn sound_play(_name: &str, _looped: bool) -> Result<(), String> {
    Ok(())
}
#[cfg(target_os = "android")]
pub fn sound_stop() {}
#[cfg(target_os = "android")]
pub fn ringtone_start() -> Result<(), String> {
    Ok(())
}
#[cfg(target_os = "android")]
pub fn ringtone_stop() {}
