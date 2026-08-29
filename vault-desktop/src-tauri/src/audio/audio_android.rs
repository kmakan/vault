//! Нативный аудио-путь Android (27.08): Oboe/AAudio вместо cpal — как SimpleX.
//!
//! cpal на Android идёт через JNI (JavaVM/AAudio через Java) — паникует при
//! старте аудио (panic=abort → приложение «сворачивается»). Oboe — чистый
//! C++ через NDK, без JNI: тот же механизм, что у SimpleX (libwebrtc → Oboe).
//!
//! Микрофон: Oboe-колбэк (высокоприоритетный аудио-поток) → 20мс-фреймы →
//! Opus encode → канал на writer (в точности как cpal-макрос build_mic,
//! но без JNI). Динамик: декодированные PCM-чанки → Oboe-колбэк (cpal
//! build_speaker). Формат end-to-end — 48кГц моно f32 (как у Opus).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::mpsc::Receiver;

use audiopus::coder::Encoder;
use audiopus::{Application, Channels as OpusChannels, SampleRate as OpusRate};
// ВАЖНО: НЕ `use oboe::*` — oboe экспортирует свой `Result` (type alias
// `Result<T> = Result<T, Error>`), который затенял бы std::result::Result
// и ломал сигнатуры с `Result<_, String>`.
use oboe::{
    AudioInputCallback, AudioInputStreamSafe, AudioOutputCallback, AudioOutputStreamSafe,
    AudioStream, AudioStreamAsync, AudioStreamBase, AudioStreamBuilder, AudioStreamSafe,
    DataCallbackResult, Error, Input, InputPreset, Mono, Output, PerformanceMode, Usage,
};

use super::{FRAME_SAMPLES, ResamplerIn, ResamplerOut};

/// Oboe-микрофон: тип стрима, который держим до конца звонка (drop = close).
pub(crate) type MicStream = AudioStreamAsync<Input, MicCallback>;
/// Oboe-динамик.
pub(crate) type SpeakerStream = AudioStreamAsync<Output, SpeakerCallback>;

/// Микрофонный колбэк: кадры устройства → 20мс фреймы → Opus → канал.
pub(crate) struct MicCallback {
    opus_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    muted: Arc<AtomicBool>,
    encoder: Encoder,
    buf: Vec<f32>,
    resampler: ResamplerIn,
    frame_cnt: u32,
}

impl AudioInputCallback for MicCallback {
    type FrameType = (f32, Mono);

    fn on_audio_ready(
        &mut self,
        _stream: &mut dyn AudioInputStreamSafe,
        data: &[f32],
    ) -> DataCallbackResult {
        if !self.muted.load(Ordering::Relaxed) {
            for &s in data {
                if self.resampler.push() {
                    self.buf.push(s);
                    if self.buf.len() >= FRAME_SAMPLES {
                        let frame: Vec<f32> = self.buf.drain(..FRAME_SAMPLES).collect();
                        // RMS микрофона (диагностика): реальный уровень захвата.
                        self.frame_cnt += 1;
                        if self.frame_cnt % 20 == 0 {
                            let rms: f32 = (frame.iter().map(|s| s * s).sum::<f32>()
                                / frame.len() as f32)
                                .sqrt();
                            eprintln!("[audio] oboe mic rms={rms:.4}");
                        }
                        let mut out = [0u8; 4000];
                        if let Ok(n) = self.encoder.encode_float(&frame, &mut out) {
                            let _ = self.opus_tx.try_send(out[..n].to_vec());
                        }
                    }
                }
            }
        }
        DataCallbackResult::Continue
    }

    fn on_error_before_close(
        &mut self,
        _stream: &mut dyn AudioInputStreamSafe,
        error: Error,
    ) {
        eprintln!("[audio] oboe mic error: {error}");
    }
}

/// Динамик: PCM-чанки из канала → буфер → Oboe-колбэк.
pub(crate) struct SpeakerCallback {
    pcm_rx: Receiver<Vec<f32>>,
    pending: Vec<f32>,
    resampler: ResamplerOut,
    last: f32,
}

impl AudioOutputCallback for SpeakerCallback {
    type FrameType = (f32, Mono);

    fn on_audio_ready(
        &mut self,
        _stream: &mut dyn AudioOutputStreamSafe,
        data: &mut [f32],
    ) -> DataCallbackResult {
        for out in data.iter_mut() {
            if self.resampler.tick() {
                if self.pending.is_empty() {
                    if let Ok(chunk) = self.pcm_rx.try_recv() {
                        self.pending = chunk;
                    }
                }
                if !self.pending.is_empty() {
                    self.last = self.pending.remove(0);
                }
            }
            *out = self.last;
        }
        DataCallbackResult::Continue
    }

    fn on_error_before_close(
        &mut self,
        _stream: &mut dyn AudioOutputStreamSafe,
        error: Error,
    ) {
        eprintln!("[audio] oboe speaker error: {error}");
    }
}

/// Открыть Oboe-микрофон: 48кГц моно f32, LowLatency, VoiceCommunication.
/// Возвращает стрим — держим до конца звонка, drop = close (остановка).
pub(crate) fn start_mic_capture_oboe(
    opus_tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    muted: Arc<AtomicBool>,
) -> Result<MicStream, String> {
    let mut encoder = Encoder::new(OpusRate::Hz48000, OpusChannels::Mono, Application::Voip)
        .map_err(|e| format!("opus encoder: {e}"))?;
    // Тюнинг Opus (27.08, шум в голосе) — как в desktop build_mic!:
    // 48 кбит/с + FEC + PLC-готовность + Voice + complexity 10.
    encoder.set_bitrate(audiopus::Bitrate::BitsPerSecond(48000)).ok();
    encoder.set_inband_fec(true).ok();
    encoder.set_packet_loss_perc(10).ok();
    encoder.set_complexity(10).ok();
    encoder.set_signal(audiopus::Signal::Voice).ok();
    let cb = MicCallback {
        opus_tx,
        muted,
        encoder,
        buf: Vec::with_capacity(FRAME_SAMPLES * 2),
        resampler: ResamplerIn::new(48000, 48000),
        frame_cnt: 0,
    };
    let mut stream = AudioStreamBuilder::default()
        .set_input()
        .set_mono()
        .set_f32()
        .set_sample_rate(48000)
        .set_performance_mode(PerformanceMode::LowLatency)
        .set_input_preset(InputPreset::VoiceCommunication)
        .set_callback(cb)
        .open_stream()
        .map_err(|e| format!("oboe input open: {e}"))?;
    stream.request_start().map_err(|e| format!("oboe input start: {e}"))?;
    let rate = stream.get_sample_rate();
    let api = stream.get_audio_api();
    eprintln!("[audio] oboe mic open: {rate} Hz, api={api:?}");
    Ok(stream)
}

/// Открыть Oboe-динамик: 48кГц моно f32, LowLatency, VoiceCommunication.
pub(crate) fn start_speaker_oboe(pcm_rx: Receiver<Vec<f32>>) -> Result<SpeakerStream, String> {
    let cb = SpeakerCallback {
        pcm_rx,
        pending: Vec::new(),
        resampler: ResamplerOut::new(48000, 48000),
        last: 0.0,
    };
    let mut stream = AudioStreamBuilder::default()
        .set_output()
        .set_mono()
        .set_f32()
        .set_sample_rate(48000)
        .set_performance_mode(PerformanceMode::LowLatency)
        .set_usage(Usage::VoiceCommunication)
        .set_callback(cb)
        .open_stream()
        .map_err(|e| format!("oboe output open: {e}"))?;
    stream.request_start().map_err(|e| format!("oboe output start: {e}"))?;
    let rate = stream.get_sample_rate();
    eprintln!("[audio] oboe speaker open: {rate} Hz");
    Ok(stream)
}

// ─── Инициализация ndk-context из Kotlin (28.08) ───────────────────────────
// Корень бага «входящий звонок молча не показывается»: tao 0.35 (Tauri 2.11)
// хранит Android-контекст в собственной приватной карте и НЕ инициализирует
// crate ndk-context → ndk_context::android_context() паникует
// ("android context was not initialized") на каждом JNI-пути (logcat Cubot,
// 28.08: panic в tokio-rt-worker сразу после incoming_ringing SET).
// Фикс: MainActivity.kt вызывает nativeInitAndroidContext(this) один раз в
// onCreate; мы делаем GlobalRef (local-ссылка живёт только до возврата из
// JNI!) и отдаём указатели в ndk-context. Дальше весь существующий код
// (showIncomingCall / dismiss / speakerphone) работает без изменений.
// 29.08: CTX_INIT_DONE перенесён в service_monitor::ensure_ndk_context —
// общий флаг для MainActivity И FGS-монитора (двойной
// initialize_android_context = panic=abort смерть процесса).

/// `external fun nativeInitAndroidContext(context: Context)` в MainActivity.
/// # Safety — вызывается из JVM с валидным JNIEnv/jobject (JNI-контракт).
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_MainActivity_nativeInitAndroidContext(
    env: jni::JNIEnv,
    _activity: jni::objects::JObject,
    context: jni::objects::JObject,
) {
    // 29.08: инициализация перенесена в общий ensure_ndk_context (используется
    // и headless-монитором из FGS-процесса — service_monitor.rs). Флаг
    // CTX_INIT_DONE разделяется обоими входами: повторный
    // initialize_android_context паникует, а у нас panic=abort — процесс умер
    // бы при открытии приложения после старта монитора в сервисном процессе.
    let mut env_ref = env;
    let ctx_ref = context;
    let _ = crate::service_monitor_ensure_ctx(&mut env_ref, &ctx_ref);
}

/// Найти класс приложения с нативного потока. ВАЖНО: `env.find_class` на
/// потоке, прикреплённом через attach_current_thread, использует системный
/// classloader и НЕ видит классы APK (ClassNotFoundException). Резолвим
/// через classloader активити — Activity.getClassLoader() (метод Context,
/// НЕ Object.getClass().getClassLoader() — то дало бы BootClassLoader и
/// уронило процесс, logcat Cubot 28.08).
pub(crate) fn find_app_class(
    env: &mut jni::JNIEnv,
    activity: &jni::objects::JObject,
    name: &str,
) -> Result<jni::objects::JClass<'static>, String> {
    // pub(crate) комментарий перенесён к сигнатуре — внутри тела не нужен.
    let loader = env
        .call_method(
            activity,
            "getClassLoader",
            "()Ljava/lang/ClassLoader;",
            &[],
        )
        .map_err(|e| format!("getClassLoader: {e}"))?
        .l()
        .map_err(|e| format!("getClassLoader cast: {e}"))?;
    let jname = env
        .new_string(name)
        .map_err(|e| format!("new_string: {e}"))?;
    let cls = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&jname).into()],
        )
        .map_err(|e| {
            // Pending Java-исключение гасим: иначе оно «всплывёт» на следующем
            // JNI-вызове этого потока и уронит процесс (FATAL EXCEPTION).
            let _ = env.exception_clear();
            format!("loadClass {name}: {e}")
        })?
        .l()
        .map_err(|e| format!("loadClass cast: {e}"))?;
    Ok(unsafe { jni::objects::JClass::from_raw(cls.as_raw()) })
}

/// Динамик вкл/выкл (27.08): AudioManager.setSpeakerphoneOn через JNI.
/// Вызывается из media_set_speaker. Без AAudio-стримов — только маршрутизация
/// вывода (earpiece ↔ speaker). Ошибки логируем, не роняем звонок.
pub(crate) fn set_speakerphone(on: bool) {
    let result = std::panic::catch_unwind(|| {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("JavaVM from_raw: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        // Context.AUDIO_SERVICE = "audio"
        let svc_name = env
            .new_string("audio")
            .map_err(|e| format!("new_string: {e}"))?;
        let am = env
            .call_method(
                &activity,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[(&svc_name).into()],
            )
            .map_err(|e| format!("getSystemService: {e}"))?
            .l()
            .map_err(|e| format!("getSystemService cast: {e}"))?;
        env.call_method(
            &am,
            "setSpeakerphoneOn",
            "(Z)V",
            &[jni::objects::JValue::Bool(on.into())],
        )
        .map_err(|e| format!("setSpeakerphoneOn: {e}"))?;
        Ok::<(), String>(())
    });
    match result {
        Ok(Ok(())) => eprintln!("[audio] speakerphone on={on}"),
        Ok(Err(e)) => eprintln!("[audio] setSpeakerphoneOn failed: {e}"),
        Err(_) => eprintln!("[audio] setSpeakerphoneOn panicked (JNI)"),
    }
}

/// Full-screen уведомление входящего звонка (28.08): вызывает статический
/// VaultForegroundService.showIncomingCall(context, callerName) через JNI.
/// Работает при свёрнутом/заблокированном приложении — звонок поверх
/// локскрина как в обычной звонилке. Desktop — no-op (см. audio.rs).
pub(crate) fn show_incoming_call_notification(caller_name: &str) {
    let name = caller_name.to_owned();
    let result = std::panic::catch_unwind(move || {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("JavaVM from_raw: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let jname = env
            .new_string(&name)
            .map_err(|e| format!("new_string: {e}"))?;
        let cls = find_app_class(&mut env, &activity, "com.vault.vault.VaultForegroundService")
            .map_err(|e| format!("find class: {e}"))?;
        env.call_static_method(
            &cls,
            "showIncomingCall",
            "(Landroid/content/Context;Ljava/lang/String;)V",
            &[(&activity).into(), (&jname).into()],
        )
        .map_err(|e| format!("showIncomingCall: {e}"))?;
        Ok::<(), String>(())
    });
    match result {
        Ok(Ok(())) => eprintln!("[audio] incoming-call notification: {caller_name}"),
        Ok(Err(e)) => eprintln!("[audio] showIncomingCall failed: {e}"),
        Err(_) => eprintln!("[audio] showIncomingCall panicked (JNI)"),
    }
}

/// Убрать уведомление входящего звонка (принят/отклонён/завершён/таймаут).
pub(crate) fn dismiss_incoming_call_notification() {
    let result = std::panic::catch_unwind(|| {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("JavaVM from_raw: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let cls = find_app_class(&mut env, &activity, "com.vault.vault.VaultForegroundService")
            .map_err(|e| format!("find class: {e}"))?;
        env.call_static_method(
            &cls,
            "dismissIncomingCall",
            "(Landroid/content/Context;)V",
            &[(&activity).into()],
        )
        .map_err(|e| format!("dismissIncomingCall: {e}"))?;
        Ok::<(), String>(())
    });
    match result {
        Ok(Ok(())) => eprintln!("[audio] incoming-call notification dismissed"),
        Ok(Err(e)) => eprintln!("[audio] dismissIncomingCall failed: {e}"),
        Err(_) => eprintln!("[audio] dismissIncomingCall panicked (JNI)"),
    }
}
