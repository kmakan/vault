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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use audiopus::coder::{Decoder, Encoder};
use audiopus::{Application, Channels as OpusChannels, SampleRate};
use bytes::Bytes;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample as _;
use tokio::sync::watch;

use rtc::media::Sample;
use rtc::shared::time::SystemInstant;

use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};

/// 20ms frame @ 48kHz mono — the Opus frame size we use end-to-end.
const FRAME_SAMPLES: usize = 960;
const FRAME_DURATION: Duration = Duration::from_millis(20);
/// Max opus frame buffer (120ms @48k mono = 5760 samples).
const DECODE_BUF: usize = 5760;

/// Mic stream for a concrete sample format: device samples → mono f32 →
/// resample → 20ms frames → Opus encode (float) → channel to the writer.
macro_rules! build_mic {
    ($device:expr, $cfg:expr, $device_rate:expr, $ch:expr, $opus_tx:expr, $muted:expr, $fmt:ty) => {{
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
                                let frame: Vec<f32> = buf.drain(..FRAME_SAMPLES).collect();
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
struct ResamplerIn {
    step: f64,
    pos: f64,
}

impl ResamplerIn {
    fn new(from: u32, to: u32) -> Self {
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
struct ResamplerOut {
    step: f64,
    pos: f64,
}

impl ResamplerOut {
    fn new(from: u32, to: u32) -> Self {
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
) {
    let remote_track = tokio::select! {
        t = remote_track_rx.recv() => match t { Some(t) => t, None => return },
        _ = stop_rx.changed() => return,
    };

    // Mic → local track.
    let (opus_tx, opus_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(8);
    let mic_stream = match start_mic_capture(opus_tx, muted.clone()) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[audio] mic capture unavailable: {e}");
            None
        }
    };
    let writer = tokio::spawn(write_opus_loop(
        track.clone(), ssrc, payload_type, opus_rx, stop_rx.clone(),
    ));

    // Remote track → speaker.
    let (pcm_tx, pcm_rx) = channel::<Vec<f32>>();
    let speaker_stream = match start_speaker(pcm_rx) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[audio] speaker unavailable: {e}");
            None
        }
    };
    let reader = tokio::spawn(read_remote_loop(remote_track, pcm_tx, stop_rx));

    // Keep streams alive; the loops exit when the PC is closed.
    let _ = writer.await;
    let _ = reader.await;
    drop(mic_stream);
    drop(speaker_stream);
    eprintln!("[audio] pipeline finished");
}

// ── Mic capture ────────────────────────────────────────────────────────────

fn start_mic_capture(
    opus_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    muted: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device".to_string())?;
    let cfg = device.default_input_config().map_err(|e| e.to_string())?;
    let device_rate = cfg.sample_rate();
    let ch = cfg.channels() as usize;

    let stream_result: Result<cpal::Stream, String> = match cfg.sample_format() {
        cpal::SampleFormat::F32 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, f32),
        cpal::SampleFormat::I16 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, i16),
        cpal::SampleFormat::U16 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, u16),
        cpal::SampleFormat::I32 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, i32),
        cpal::SampleFormat::F64 => build_mic!(device, cfg, device_rate, ch, opus_tx, muted, f64),
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
) {
    loop {
        tokio::select! {
            frame = rx.recv() => {
                let Some(frame) = frame else { break };
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

fn start_speaker(pcm_rx: Receiver<Vec<f32>>) -> Result<cpal::Stream, String> {
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
                        let mut out = vec![0f32; DECODE_BUF];
                        if let Ok(n) = decoder.decode_float(Some(&pkt.payload[..]), &mut out[..], false) {
                            out.truncate(n);
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
