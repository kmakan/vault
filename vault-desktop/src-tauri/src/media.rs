//! WebRTC media module for audio calls (M3, Phase 2).
//!
//! webrtc-rs 0.20 (sans-I/O `rtc` core + driver architecture):
//! - `PeerConnectionBuilder` + `PeerConnectionEventHandler` trait
//! - `TrackLocalStaticSample` — raw Opus frames are packetized/sequenced by
//!   the library (no manual RTP header handling)
//! - Non-trickle ICE: wait for `RTCIceGatheringState::Complete`, then read
//!   the full local SDP (serialized as JSON `RTCSessionDescription`).
//!
//! Flow (signaling via `call_sdp` envelopes in App.vue):
//! 1. Caller: `start_outgoing` → PC + opus track → offer → full SDP (JSON).
//! 2. Callee: `accept_incoming` → PC + track → set remote offer → answer SDP.
//! 3. Caller: `set_remote` → set remote answer → DTLS-SRTP established.
//! 4. Either: `close` → teardown.
//!
//! Audio capture/playback (cpal + audiopus) is wired in a later iteration;
//! this module establishes and tears down the encrypted media channel.
//!
//! Video (M3, step 1/3): a call started with `with_video` gets a SECOND track
//! on the same PeerConnection — VP8 (`video/VP8`, clock 90000, payload 96,
//! own SSRC); the Opus track/transceiver stays as it is. Audio-only calls
//! register no video codec and create no video track, so the prod audio path
//! is byte-identical to the pre-video build. Camera capture = step 2, UI = step 3.
//!
//! Video (M3, step 2/3): the video track handle is kept in `CallSession`, and
//! `media_camera_start`/`media_camera_stop` wire camera frames into it
//! (`crate::video::start_video_for_call` → `write_video_loop`). Capture itself
//! is a desktop stub / a hard error on Android: webrtc 0.20 has no VP8
//! *encoder* and the ТЗ forbids new crates — see `crate::video` module docs.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{watch, Mutex};
use tokio::time::timeout;

use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceGatheringState, RTCIceServer, RTCPeerConnectionState, RTCSessionDescription,
    SettingEngine,
};
use webrtc::runtime::{channel, Receiver, Sender};

use base64::Engine as _;
use bytes::Bytes;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::media_engine::{
    MediaEngine, MIME_TYPE_OPUS, MIME_TYPE_VP8,
};
use rtc::rtp::codec::vp8::Vp8Packet;
use rtc::rtp::packetizer::Depacketizer;
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};

/// Opus dynamic payload type (both ends are our app; registered in MediaEngine).
const OPUS_PAYLOAD_TYPE: u8 = 120;
/// VP8 dynamic payload type (video; both ends are our app). 96 — первый
/// динамический PT, отдельный от OPUS_PAYLOAD_TYPE.
/// `pub(crate)`: тот же PT передаёт writer кадров камеры (`crate::video`).
pub(crate) const VP8_PAYLOAD_TYPE: u8 = 96;
/// Max time to wait for ICE gathering before giving up (non-trickle).
/// 4с: было 15с — ответ (SDP) создавался слишком долго, звонок
/// успевал сгореть по таймеру гудка. Host-кандидаты собираются <1с;
/// STUN/srflx за 4с успевают, иначе отдаём то, что есть (wait_for_local_sdp
/// на таймауте не падает, а отдаёт частичные кандидаты).
const ICE_GATHER_TIMEOUT: Duration = Duration::from_secs(4);

/// App-wide media manager: one entry per active call.
pub struct CallMediaManager {
    calls: HashMap<String, CallSession>,
    ice_servers: Vec<RTCIceServer>,
}

/// Active call session: PC handle + pipeline control.
struct CallSession {
    pc: Arc<dyn PeerConnection>,
    /// Signal to stop the audio pipeline (watch fires on close).
    stop_tx: watch::Sender<bool>,
    /// Mic mute flag (checked by the capture callback).
    muted: Arc<AtomicBool>,
    /// Динамик вкл/выкл: desktop — смена устройства вывода
    /// Android — speakerphone через JNI (audio_android::set_speakerphone).
    speaker_tx: watch::Sender<bool>,
    /// DataChannel «vault-ctrl».
    /// call_end по email идёт 30-60с — собеседник сидит с трубкой. DC
    /// доставляет «hangup» за миллисекунды после DTLS. None до открытия.
    /// Слот общий: у звонящего в нём его собственный канал, у
    /// принимающего — канал, пришедший через on_data_channel.
    dc: Arc<Mutex<Option<Arc<dyn DataChannel>>>>,
    /// Видео (шаг 2/3): локальный VP8-трек и его SSRC. None — аудио-звонок.
    /// Свою ссылку держим намеренно: у PC-сендера есть своя, но кадры камеры
    /// пишет `media_camera_start`, которому нужен собственный handle.
    video_track: Option<Arc<TrackLocalStaticSample>>,
    video_ssrc: Option<u32>,
    /// E2E-ключ медиа — тот же, что у аудио-пайплайна: кадры камеры
    /// шифруются `media_encrypt_frame` перед SRTP (defence in depth).
    media_key: Option<[u8; 32]>,
    /// Живая камера (шаг 2/3). Drop = стоп захвата + завершение writer-таски.
    camera: Option<crate::video::CameraHandle>,
    /// Видео (шаг 3/3): remote-видео-трек, который on_track кладёт сюда.
    /// Хранится В СЕССИИ в виде слота: кнопку видео можно выключать и
    /// включать сколько угодно раз за звонок — каждый video_start берёт
    /// трек из слота (Arc::clone), а не из израсходованного одноразового
    /// канала (баг: повторное включение видео падало «no video channel»).
    video_slot: Arc<Mutex<Option<Arc<dyn TrackRemote>>>>,
    /// Видео (шаг 3/3): идемпотентность — повторный video_start не запускает
    /// второй reader. None = reader ещё не стартовал (или уже закончился).
    video_reader: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// SDP payload returned to the UI (JSON-encoded RTCSessionDescription).
#[derive(Serialize, Clone)]
pub struct SdpResult {
    pub sdp: String,
    pub call_id: String,
    /// PQ: инкапсуляция против ek принимающего (b64) — фронт кладёт
    /// в call-конверт (sendCallEnvelope), принимающий передаёт в
    /// media_accept_incoming. None = legacy-звонок (нет PQ у одной из сторон).
    #[serde(default)]
    pub kemct: Option<String>,
    /// PQ: ek звонящего (b64) — чтобы принимающий мог сохранить контакт.
    #[serde(default)]
    pub sender_ek: Option<String>,
    /// SSRC локального видео-трека. None — звонок без видео (шаг 1/3:
    /// трек только создаётся и регистрируется, кадры пишет шаг 2).
    #[serde(default)]
    pub video_ssrc: Option<u32>,
}

/// Event handler: forwards webrtc events into channels for the session.
#[derive(Clone)]
struct CallHandler {
    gather_complete_tx: Sender<()>,
    connected_tx: Sender<()>,
    track_tx: Sender<Arc<dyn TrackRemote>>,
    /// M3 видео: remote-видео-трек кладётся в слот сессии — audio-pipeline
    /// по-прежнему получает только аудио (см. фильтр в on_track).
    video_slot: Arc<Mutex<Option<Arc<dyn TrackRemote>>>>,
    /// получает канал, созданный caller'ом, через DCEP-негосиацию).
    dc_tx: Sender<Arc<dyn DataChannel>>,
    /// Состояние соединения: пробрасываем ВСЕ смены состояния в UI.
    /// Корень «экран не закрывается»: когда пир кладёт трубку, а DataChannel
    /// сигнал о завершении это ICE-состояние.
    /// Connected, и UI не узнавал о разрыве.
    state_tx: Sender<RTCPeerConnectionState>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for CallHandler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gather_complete_tx.try_send(());
        }
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if state == RTCPeerConnectionState::Connected {
            let _ = self.connected_tx.try_send(());
        }
        // Пробрасываем каждое состояние в UI — см. state_tx.
        let _ = self.state_tx.try_send(state);
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        // M3 видео: on_track вызывается для КАЖДОГО remote-трека (аудио и
        // видео отдельно — rtc driver.rs:1199). Audio-pipeline ждёт из своего
        // канала ОДИН трек и ведёт его в Opus-декодер: видео туда не должно
        // попасть — маршрутизируем по kind():
        //  - Video → слот сессии для video-reader'а (UI рендерит кадры)
        //  - остальное → audio-pipeline (ровно аудио, как и раньше).
        // Трек хранится в слоте, а не в канале: кнопка видео может
        // выключаться и включаться повторно — повторный video_start
        // берёт трек из слота, а не из израсходованного канала.
        match track.kind().await {
            RtpCodecKind::Video => {
                eprintln!("[media] remote VIDEO track received");
                *self.video_slot.lock().await = Some(track);
            }
            _ => {
                let _ = self.track_tx.try_send(track);
            }
        }
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let _ = self.dc_tx.try_send(dc);
    }
}

// ---------------------------------------------------------------------------
// Codecs / local tracks (audio always; video only in video calls)
// ---------------------------------------------------------------------------

/// Opus (mono, 48 kHz) — must stay identical to the params owned by the prod
/// audio path (audiopus uses `OpusChannels::Mono`, 48 kHz; SDP обязан совпадать).
fn opus_codec() -> RTCRtpCodec {
    RTCRtpCodec {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48000,
        // MONO: энкодер/декодер audiopus используют OpusChannels::Mono
        // (audio.rs) — SDP обязан совпадать, иначе рассинхрон каналов.
        channels: 1,
        sdp_fmtp_line: String::new(),
        rtcp_feedback: vec![],
    }
}

/// VP8 (video, 90 kHz) — regression-free choice: the packetizer ships with
/// webrtc 0.20 on desktop and Android (no extra crate, no C dependencies).
/// `pub(crate)`: `crate::video` сверяет с ним клок для таймстампов кадров.
pub(crate) fn vp8_codec() -> RTCRtpCodec {
    RTCRtpCodec {
        mime_type: MIME_TYPE_VP8.to_owned(),
        clock_rate: 90000,
        channels: 0,
        sdp_fmtp_line: String::new(),
        rtcp_feedback: vec![],
    }
}

/// MediaEngine for one call. Opus регистрируется всегда; VP8 — только когда
/// звонок с видео. `with_video == false` даёт ровно тот же engine, что был до
/// появления видео: аудио-звонок не видит видео-кодека вообще.
fn build_media_engine(with_video: bool) -> Result<MediaEngine, String> {
    let mut media_engine = MediaEngine::default();
    media_engine
        .register_codec(
            RTCRtpCodecParameters {
                rtp_codec: opus_codec(),
                payload_type: OPUS_PAYLOAD_TYPE,
                ..Default::default()
            },
            RtpCodecKind::Audio,
        )
        .map_err(|e| e.to_string())?;

    if with_video {
        media_engine
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: vp8_codec(),
                    payload_type: VP8_PAYLOAD_TYPE,
                    ..Default::default()
                },
                RtpCodecKind::Video,
            )
            .map_err(|e| e.to_string())?;
    }

    Ok(media_engine)
}

/// Descriptor of the local audio track: one encoding, one SSRC.
fn audio_media_track(call_id: &str, ssrc: u32) -> MediaStreamTrack {
    MediaStreamTrack::new(
        format!("vault-audio-{call_id}"),
        format!("vault-audio-{call_id}"),
        "vault-audio".to_owned(),
        RtpCodecKind::Audio,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(ssrc),
                ..Default::default()
            },
            codec: opus_codec(),
            ..Default::default()
        }],
    )
}

/// Descriptor of the local video track (same shape as audio, own SSRC).
/// `pub(crate)`: `crate::video` тестирует writer кадров на этом же дескрипторе.
pub(crate) fn video_media_track(call_id: &str, ssrc: u32) -> MediaStreamTrack {
    MediaStreamTrack::new(
        format!("vault-video-{call_id}"),
        format!("vault-video-{call_id}"),
        "vault-video".to_owned(),
        RtpCodecKind::Video,
        vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters {
                ssrc: Some(ssrc),
                ..Default::default()
            },
            codec: vp8_codec(),
            ..Default::default()
        }],
    )
}

/// Random SSRC, гарантированно отличный от `other` (аудио-SSRC): два трека
/// одного PeerConnection не имеют права делить один SSRC.
fn random_ssrc_excluding(other: u32) -> u32 {
    loop {
        let ssrc = rand::random::<u32>();
        if ssrc != other {
            return ssrc;
        }
    }
}

impl CallMediaManager {
    pub fn new() -> Self {
        // Dev fallback: public STUN (roadmap: dev-only; X2TURN comes in Phase 3).
        // Множество серверов: stun.l.google.com из РФ/с мобильного интернета может
        // быть недоступен (замедление/блокировка) → gathering таймаутил на Android
        // Запросы ко
        // всем серверам идут ПАРАЛЛЕЛЬНО (stun_gatherer.rs), поэтому несколько
        // серверов не замедляют gathering — самый быстрый ответ даёт srflx.
        // sipnet.ru 73, 1und1.de 60.
        // (DNS), stun.yandex.ru и stun.mts.ru (таймаут).
        // STUN для host/srflx. TURN (openrelay.metered.ca) убран
        // отдаёт 400 Bad Request на все allocate → 15с ожидания gathering и
        // шум в логах. Для desktop↔desktop в одной сети host-кандидатов
        // достаточно; TURN вернём, когда поднимем свой (coturn, как у
        let dev_ice = RTCIceServer {
            urls: vec![
                "stun:stun.l.google.com:19302".to_owned(),
                "stun:stun1.l.google.com:19302".to_owned(),
                "stun:stun.sipgate.net:3478".to_owned(),
                "stun:stun.zadarma.com:3478".to_owned(),
                "stun:stun.sipnet.ru:3478".to_owned(),
                "stun:stun.1und1.de:3478".to_owned(),
            ],
            ..Default::default()
        };
        Self {
            calls: HashMap::new(),
            ice_servers: vec![dev_ice],
        }
    }

    /// Replace ICE servers (X2TURN / user settings) — applies to calls
    /// started after this call.
    pub fn set_ice_servers(&mut self, urls: Vec<String>) {
        self.ice_servers = urls
            .into_iter()
            .map(|url| RTCIceServer {
                urls: vec![url],
                ..Default::default()
            })
            .collect();
    }

    /// Build a PeerConnection with an Opus audio track — and, when `with_video`
    /// is set, a SECOND VP8 video track on the same PC (audio untouched).
    ///
    /// Returns the PC, the local audio track (caller writes encoded frames into
    /// it), the video SSRC (`None` — аудио-звонок) and the ICE
    /// gathering-complete receiver.
    async fn build_pc(
        &mut self,
        app: tauri::AppHandle,
        call_id: &str,
        media_key: Option<[u8; 32]>,
        is_caller: bool,
        with_video: bool,
    ) -> Result<
        (
            Arc<dyn PeerConnection>,
            Arc<TrackLocalStaticSample>,
            Option<u32>,
            Receiver<()>,
        ),
        String,
    > {
        // Opus всегда; VP8 — только при with_video (нулевое влияние на аудио).
        let media_engine = build_media_engine(with_video)?;

        let config = RTCConfigurationBuilder::new()
            .with_ice_servers(self.ice_servers.clone())
            .build();

        // ICE-таймауты под email-сигнализацию
        // дефолты disconnected 5с + failed 25с = 30с. Answerer (звонящий)
        // начинает проверки сразу после set_remote(offer), а offerer
        // (принимающий) физически не может отвечать, пока не получит answer
        // по почте — письмо шло 36с. Answerer сгорал в Failed ЗА 6с до
        // этого, а при Failed агент стирает ВСЕ локальные кандидаты
        // (delete_all_candidates) — входящие пинги отбрасывались как
        // "not a valid local candidate", и вторая сторона тоже сгорала.
        // 60с disconnected + 120с failed = 180с окна: покрывает любую
        // задержку почты (caller-таймер звонка 300с).
        let mut setting_engine = SettingEngine::default();
        setting_engine.set_ice_timeouts(
            Some(Duration::from_secs(60)),  // disconnected
            Some(Duration::from_secs(120)), // failed
            None,                           // keepalive (дефолт 2с)
        );

        let (gather_tx, gather_rx) = channel::<()>(1);
        let (connected_tx, connected_rx) = channel::<()>(1);
        // M3 видео: on_track кладёт remote-видео-трек в слот сессии
        // (см. `video_slot` у CallSession). Слот, а не канал: кнопку видео
        // можно выключать и включать повторно — каждый video_start берёт
        // трек из слота, а не из израсходованного одноразового канала.
        let video_slot: Arc<Mutex<Option<Arc<dyn TrackRemote>>>> =
            Arc::new(Mutex::new(None));
        // Аудио: remote-аудио-трек уходит в audio-pipeline (один трек
        // на звонок — пайплайн запускается один раз, канал не нужен).
        let (track_tx, track_rx) = channel::<Arc<dyn TrackRemote>>(1);
        let (dc_tx, mut dc_rx) = channel::<Arc<dyn DataChannel>>(1);
        // Состояние соединения → UI: единственный надёжный сигнал
        let (state_tx, mut state_rx) = channel::<RTCPeerConnectionState>(8);

        let handler = Arc::new(CallHandler {
            gather_complete_tx: gather_tx,
            connected_tx,
            track_tx,
            video_slot: Arc::clone(&video_slot),
            dc_tx,
            state_tx,
        });

        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(config)
                .with_media_engine(media_engine)
                .with_setting_engine(setting_engine)
                .with_handler(handler)
                .with_udp_addrs(vec!["0.0.0.0:0".to_owned()])
                .build()
                .await
                .map_err(|e| e.to_string())?,
        );

        // DataChannel «vault-ctrl» поверх
        // DTLS-SCTP. call_end по email идёт 30-60с — собеседник сидит с
        // трубкой. DC доставляет «hangup» за миллисекунды.
        // обе
        // стороны создавали СВОЙ канал с одинаковым label — SCTP-ассоциация
        // склеивала их в один stream, DCEP-негосиация входящего канала не
        // происходила (ни у кого не срабатывал on_data_channel), и
        // Теперь канал создаёт
        // ТОЛЬКО звонящий (до offer — DCEP попадает в SDP); принимающий
        // получает его через on_data_channel. Слот общий (Arc<Mutex<..>>):
        // слушатель принимающего пишет туда пришедший канал, send_hangup
        // читает — обе стороны шлют по ОДНОМУ каналу (от caller к callee
        // и обратно по тому же stream, SCTP дуплексный).
        let dc_slot: Arc<Mutex<Option<Arc<dyn DataChannel>>>> = Arc::new(Mutex::new(None));
        if is_caller {
            match pc.create_data_channel("vault-ctrl", None).await {
                Ok(dc) => {
                    eprintln!("[media] caller: vault-ctrl created");
                    // Звонящий получает «hangup» от пира на СОБСТВЕННОМ
                    // канале (тот же stream, дуплекс) — polл здесь; у
                    // принимающего поллит dc_rx-слушатель ниже.
                    let appc = app.clone();
                    let cidc = call_id.to_owned();
                    let dcp = Arc::clone(&dc);
                    tauri::async_runtime::spawn(async move {
                        while let Some(ev) = dcp.poll().await {
                            if let DataChannelEvent::OnMessage(msg) = ev {
                                let text = String::from_utf8_lossy(&msg.data);
                                if text.trim() == "hangup" {
                                    eprintln!("[media] DC hangup received from peer");
                                    let _ = appc.emit(
                                        "call-remote-hangup",
                                        serde_json::json!({ "callId": cidc }),
                                    );
                                    break;
                                }
                            }
                        }
                    });
                    *dc_slot.lock().await = Some(dc);
                }
                Err(e) => {
                    eprintln!("[media] create_data_channel failed (hangup fallback = email): {e}");
                }
            }
        }

        // Local Opus track (SSRC random; the library packetizes samples).
        let ssrc = rand::random::<u32>();
        let track = Arc::new(
            TrackLocalStaticSample::new(audio_media_track(call_id, ssrc))
                .map_err(|e| e.to_string())?,
        );

        pc.add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
            .await
            .map_err(|e| e.to_string())?;

        // Video: ВТОРОЙ track на том же PeerConnection (add_track, не замена) —
        // аудио-трансивер выше не трогаем. Аудио-звонок (with_video=false)
        // выходит отсюда как раньше: без кодека, без трека, без m=video.
        // Свою ссылку на трек сохраняем (шаг 2/3): в неё пишет кадры камеры
        // `media_camera_start`; у PC-сендера остаётся её собственная ссылка.
        let mut video_track_for_session: Option<Arc<TrackLocalStaticSample>> = None;
        let video_ssrc = if with_video {
            let video_ssrc = random_ssrc_excluding(ssrc);
            let video_track = Arc::new(
                TrackLocalStaticSample::new(video_media_track(call_id, video_ssrc))
                    .map_err(|e| e.to_string())?,
            );
            pc.add_track(Arc::clone(&video_track) as Arc<dyn TrackLocal>)
                .await
                .map_err(|e| e.to_string())?;
            eprintln!(
                "[media] video track added (ssrc={video_ssrc}, \
                 payload_type={VP8_PAYLOAD_TYPE}); audio ssrc={ssrc}"
            );
            video_track_for_session = Some(video_track);
            Some(video_ssrc)
        } else {
            None
        };

        // Audio pipeline: wait for the connection to establish, then start
        // mic capture / speaker playback (Phase 2.1). Aborted on close.
        let (stop_tx, stop_rx) = watch::channel(false);
        let muted = Arc::new(AtomicBool::new(false));
        let (speaker_tx, speaker_rx) = watch::channel(false);
        {
            let track = track.clone();
            let mut stop_rx = stop_rx.clone();
            let muted = muted.clone();
            let mut connected_rx = connected_rx;
            let cid = call_id.to_owned();
            let app1 = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _ = connected_rx.recv() => {}
                    _ = stop_rx.changed() => return,
                }
                eprintln!("[media] connected — starting audio pipeline");
                // Событие в UI: оверлей показывает «Соединение…» до
                // этого момента, таймер разговора — только после.
                // таймер шёл с момента accept, а SDP шёл по почте до 54с —
                // пользователь видел «минуту тишины» при работающем таймере.
                if let Err(e) =
                    app1.emit("call-media-connected", serde_json::json!({ "callId": cid }))
                {
                    eprintln!("[media] emit call-media-connected failed: {e}");
                }
                crate::audio::run_audio_pipeline(
                    track,
                    ssrc,
                    OPUS_PAYLOAD_TYPE,
                    track_rx,
                    stop_rx,
                    muted,
                    media_key,
                    speaker_rx,
                )
                .await;
            });
        }

        // Слушаем ВХОДЯЩИЙ DataChannel от пира: пир создаёт свой
        // «vault-ctrl», он приходит нам через on_data_channel (dc_rx).
        // ожидания call_end по email (30-60с). Пришедший канал пишем в
        // общий слот — принимающий шлёт свой «hangup» по нему.
        {
            let app2 = app.clone();
            let cid2 = call_id.to_owned();
            let slot2 = Arc::clone(&dc_slot);
            tauri::async_runtime::spawn(async move {
                let dc = match dc_rx.recv().await {
                    Some(dc) => dc,
                    None => return,
                };
                eprintln!("[media] remote data channel received");
                *slot2.lock().await = Some(Arc::clone(&dc));
                while let Some(ev) = dc.poll().await {
                    if let DataChannelEvent::OnMessage(msg) = ev {
                        let text = String::from_utf8_lossy(&msg.data);
                        if text.trim() == "hangup" {
                            eprintln!("[media] DC hangup received from peer");
                            let _ = app2
                                .emit("call-remote-hangup", serde_json::json!({ "callId": cid2 }));
                            break;
                        }
                    }
                }
            });
        }

        // Состояние соединения → UI: пробрасываем ВСЕ смены ICE
        // состояния. Корень «экран не закрывается»: когда пир кладёт трубку,
        // дошёл — единственный сигнал о завершении это ICE-состояние.
        // UI сам решает, что делать (grace-период на Disconnected, hangup
        // на Failed/Closed).
        {
            let app3 = app.clone();
            let cid3 = call_id.to_owned();
            tauri::async_runtime::spawn(async move {
                while let Some(state) = state_rx.recv().await {
                    let s = match state {
                        RTCPeerConnectionState::New => "new",
                        RTCPeerConnectionState::Connecting => "connecting",
                        RTCPeerConnectionState::Connected => "connected",
                        RTCPeerConnectionState::Disconnected => "disconnected",
                        RTCPeerConnectionState::Failed => "failed",
                        RTCPeerConnectionState::Closed => "closed",
                        _ => continue,
                    };
                    eprintln!("[media] connection state -> {s}");
                    let _ = app3.emit(
                        "call-connection-state",
                        serde_json::json!({ "callId": cid3, "state": s }),
                    );
                }
            });
        }

        self.calls.insert(
            call_id.to_owned(),
            CallSession {
                pc: Arc::clone(&pc),
                stop_tx,
                muted,
                speaker_tx,
                dc: Arc::clone(&dc_slot),
                video_track: video_track_for_session,
                video_ssrc,
                media_key,
                camera: None,
                video_slot: Arc::clone(&video_slot),
                video_reader: None,
            },
        );

        Ok((pc, track, video_ssrc, gather_rx))
    }

    /// Wait for non-trickle ICE gathering; return the local SDP as a JSON
    /// string (RTCSessionDescription), or Err on timeout.
    async fn wait_for_local_sdp(
        pc: &Arc<dyn PeerConnection>,
        gather_rx: &mut Receiver<()>,
    ) -> Result<String, String> {
        // На Android gathering НЕ завершается (Complete не приходит)
        // за 15с даже с несколькими STUN — Google STUN недоступен из РФ,
        // российские STUN тоже могут быть нестабильны на мобильном. НО:
        // host-кандидаты собираются почти сразу (локальная сеть), и для
        // desktop↔android в одной Wi-Fi их достаточно. Поэтому: ждём
        // Complete с таймаутом, а на таймауте НЕ падаем — отдаём SDP с тем,
        // что уже есть. Если кандидатов вообще нет — тогда ошибка.
        match timeout(ICE_GATHER_TIMEOUT, gather_rx.recv()).await {
            Ok(_) => {}
            Err(_) => {
                eprintln!(
                    "[media] ICE gathering not Complete in {:.0}s — using partial candidates",
                    ICE_GATHER_TIMEOUT.as_secs_f64()
                );
            }
        }
        let desc = pc
            .local_description()
            .await
            .ok_or_else(|| "no local description".to_string())?;
        let sdp_json = serde_json::to_string(&desc).map_err(|e| e.to_string())?;
        // сколько кандидатов реально в SDP — если 0
        // соединение не поднимется даже с partial-подходом.
        let cand_count = desc.sdp.matches("a=candidate:").count();
        eprintln!(
            "[media] local SDP: candidates={cand_count}, len={}",
            sdp_json.len()
        );
        Ok(sdp_json)
    }

    /// Start an outgoing call: build PC + track(s), create offer, gather ICE,
    /// return the full SDP (JSON). `with_video` adds the second (VP8) track.
    pub async fn start_outgoing(
        &mut self,
        app: tauri::AppHandle,
        call_id: &str,
        media_key: Option<[u8; 32]>,
        with_video: bool,
    ) -> Result<SdpResult, String> {
        let (pc, _track, video_ssrc, mut gather_rx) = self
            .build_pc(app, call_id, media_key, true, with_video)
            .await?;

        let offer = pc.create_offer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(offer)
            .await
            .map_err(|e| e.to_string())?;

        let sdp = Self::wait_for_local_sdp(&pc, &mut gather_rx).await?;

        Ok(SdpResult {
            sdp,
            call_id: call_id.to_owned(),
            kemct: None,
            sender_ek: None,
            video_ssrc,
        })
    }

    /// Accept an incoming call: build PC + track(s), set remote offer, create
    /// answer, gather ICE, return answer SDP (JSON). `with_video` adds the
    /// second (VP8) track.
    pub async fn accept_incoming(
        &mut self,
        app: tauri::AppHandle,
        call_id: &str,
        offer_sdp: &str,
        media_key: Option<[u8; 32]>,
        with_video: bool,
    ) -> Result<SdpResult, String> {
        let (pc, _track, video_ssrc, mut gather_rx) = self
            .build_pc(app, call_id, media_key, false, with_video)
            .await?;

        let offer: RTCSessionDescription =
            serde_json::from_str(offer_sdp).map_err(|e| e.to_string())?;
        pc.set_remote_description(offer)
            .await
            .map_err(|e| e.to_string())?;

        let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(answer)
            .await
            .map_err(|e| e.to_string())?;

        let sdp = Self::wait_for_local_sdp(&pc, &mut gather_rx).await?;

        Ok(SdpResult {
            sdp,
            call_id: call_id.to_owned(),
            kemct: None,
            sender_ek: None,
            video_ssrc,
        })
    }

    /// Set the remote description (answer on the caller side).
    pub async fn set_remote(&mut self, call_id: &str, sdp_json: &str) -> Result<(), String> {
        let session = self
            .calls
            .get(call_id)
            .ok_or_else(|| "call not found".to_string())?;
        let desc: RTCSessionDescription =
            serde_json::from_str(sdp_json).map_err(|e| e.to_string())?;
        session
            .pc
            .set_remote_description(desc)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Mute/unmute the local mic for an active call.
    pub async fn set_muted(&mut self, call_id: &str, muted: bool) -> Result<(), String> {
        let session = self
            .calls
            .get(call_id)
            .ok_or_else(|| "call not found".to_string())?;
        session
            .muted
            .store(muted, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    /// Динамик вкл/выкл: Android — speakerphone через AudioManager
    /// (JNI в audio_android); desktop — no-op (вывод всегда на динамики,
    /// переключение устройств — задача ОС).
    pub async fn set_speaker(&mut self, call_id: &str, on: bool) -> Result<(), String> {
        let session = self
            .calls
            .get(call_id)
            .ok_or_else(|| "call not found".to_string())?;
        let _ = session.speaker_tx.send(on);
        #[cfg(target_os = "android")]
        crate::audio::audio_android::set_speakerphone(on);
        Ok(())
    }

    /// шлёт «hangup» по
    /// DataChannel «vault-ctrl» — собеседник получает за миллисекунды,
    /// не ждёт call_end по email (30-60с). Email-сигнал остаётся как
    /// fallback (фронт шлёт его отдельно). Ok(false) если канала нет
    /// (SDP ещё не обменялись) — тогда работает только email.
    pub async fn send_hangup(&mut self, call_id: &str) -> Result<bool, String> {
        let session = self
            .calls
            .get(call_id)
            .ok_or_else(|| "call not found".to_string())?;
        // Слот общий: у звонящего там свой канал, у принимающего —
        // пришедший от пира (пишется в dc_rx-слушателе).
        let dc = match session.dc.lock().await.clone() {
            Some(dc) => dc,
            None => return Ok(false),
        };
        match dc.send_text("hangup").await {
            Ok(()) => {
                eprintln!("[media] DC hangup sent");
                Ok(true)
            }
            Err(e) => {
                eprintln!("[media] DC hangup send failed (email fallback): {e}");
                Ok(false)
            }
        }
    }

    /// Видео (шаг 2/3): запустить камеру для активного звонка — writer-таска
    /// пишет кадры в локальный VP8-трек этого звонка.
    ///
    /// Ошибки: звонок не найден / аудио-звонок (нет видео-трека) / камера уже
    /// запущена / платформенный бэкенд захвата недоступен (Android, см.
    /// `crate::video`) — ошибка не глотается, команда вернёт её наверх.
    pub fn camera_start(&mut self, call_id: &str) -> Result<(), String> {
        let session = self
            .calls
            .get_mut(call_id)
            .ok_or_else(|| "call not found".to_string())?;
        if session.camera.is_some() {
            return Err("camera already started for this call".to_string());
        }
        let track = session
            .video_track
            .clone()
            .ok_or_else(|| "call has no video track (audio-only call)".to_string())?;
        let video_ssrc = session
            .video_ssrc
            .ok_or_else(|| "call has no video ssrc".to_string())?;
        // Стоп-сигнал звонка — тот же, что у аудио-пайплайна: close() гасит
        // и аудио, и видео (subscribe() до close(), поэтому событие видно).
        let mut stop_rx = session.stop_tx.subscribe();
        let camera = crate::video::start_video_for_call(
            call_id,
            track,
            video_ssrc,
            VP8_PAYLOAD_TYPE,
            session.media_key,
            stop_rx,
        )?;
        session.camera = Some(camera);
        Ok(())
    }

    /// Видео (шаг 3/3): принять закодированный кадр от WebCodecs (WebView) и
    /// положить в writer-таску локального видео-трека — E2E-шифр + RTP.
    /// Заменяет нативный захват камеры на платформах, где его нет (Android:
    /// camera2+MediaCodec JNI нереализован). Вызов до `camera_start` или в
    /// аудио-звонке → ошибка (JS-сторона гасит камеру).
    pub fn video_accept_frame(&mut self, call_id: &str, frame: Vec<u8>) -> Result<(), String> {
        let session = self
            .calls
            .get(call_id)
            .ok_or_else(|| "call not found".to_string())?;
        let camera = session
            .camera
            .as_ref()
            .ok_or_else(|| "camera not started for this call".to_string())?;
        camera.accept_frame(frame)
    }

    /// Видео (шаг 2/3): остановить камеру. `None` — все сессии (шаг 3 UI может
    /// позвать `media_camera_stop()` без call_id). Идемпотентно.
    pub fn camera_stop(&mut self, call_id: Option<&str>) {
        match call_id {
            Some(id) => {
                if let Some(session) = self.calls.get_mut(id) {
                    // Drop CameraHandle: стоп захвата + закрытие канала кадров.
                    session.camera = None;
                }
            }
            None => {
                for session in self.calls.values_mut() {
                    session.camera = None;
                }
            }
        }
        // Страховка на случай, если handle уже потерян: гасим платформенный
        // захват (идемпотентно — нет активного, ничего не делает).
        crate::video::stop_camera();
    }

    /// Видео (шаг 3/3): приём remote-видео. Reader-таска ждёт remote
    /// VP8-трек (on_track кладёт его в слот сессии), дальше для каждого
    /// RTP-пакета: депакетизация VP8 → E2E-расшифровка → кадр в UI
    /// через событие `call-video-frame`.
    ///
    /// Е2Е-шифр: payload RTP шифруется целиком (см. `write_video_loop`),
    /// поэтому депакетизируем ПОСЛЕ расшифровки — обратный порядок
    /// относительно отправки.
    pub fn video_start(&mut self, call_id: &str, app: tauri::AppHandle) -> Result<(), String> {
        let session = self
            .calls
            .get_mut(call_id)
            .ok_or_else(|| "call not found".to_string())?;
        if session.video_reader.is_some() {
            return Err("video reader already started for this call".to_string());
        }
        let video_slot = Arc::clone(&session.video_slot);
        let mut stop_rx = session.stop_tx.subscribe();
        let media_key = session.media_key;
        let cid = call_id.to_owned();
        let reader = tauri::async_runtime::spawn(async move {
            // Ждём remote-видео-трек: on_track срабатывает на ПЕРВОМ
            // RTP-пакете пира (rtc endpoint.go), поэтому трек приходит
            // только когда собеседник реально шлёт видео.
            //
            // Трек лежит в слоте сессии (video_slot), а не в одноразовом
            // канале: кнопку видео можно дёргать сколько угодно раз за
            // звонок — каждый video_start заново клонирует Arc того же
            // трека, не изымая его (фикс "call has no video channel").
            let track = loop {
                if let Some(t) = video_slot.lock().await.as_ref() {
                    break Arc::clone(t);
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                    _ = stop_rx.changed() => return,
                }
            };
            eprintln!("[video] remote track received — decoding frames to UI");
            let mut depacketizer = Vp8Packet::default();
            loop {
                tokio::select! {
                    ev = track.poll() => {
                        let Some(ev) = ev else { break };
                        match ev {
                            TrackRemoteEvent::OnRtpPacket(pkt) => {
                                // E2E-расшифровка (как в audio read_remote_loop,
                                // но для видео): payload зашифран целиком.
                                let payload = match &media_key {
                                    Some(k) => {
                                        match crate::crypto::media_decrypt_frame(k, &pkt.payload) {
                                            Ok(p) => p,
                                            Err(e) => {
                                                eprintln!("[video] media decrypt: {e}");
                                                continue;
                                            }
                                        }
                                    }
                                    None => pkt.payload.to_vec(),
                                };
                                // Депакетизация VP8: снимает RTP-заголовок
                                // кадра (picture ID и пр.), выдаёт чистый
                                // VP8-битстрим кадра.
                                let frame = match depacketizer.depacketize(&Bytes::from(payload)) {
                                    Ok(f) => f,
                                    Err(e) => {
                                        eprintln!("[video] depacketize: {e}");
                                        continue;
                                    }
                                };
                                if frame.is_empty() {
                                    continue;
                                }
                                // Кадр в UI: байты VP8-фрейма. UI декодирует
                                // через WebCodecs VideoDecoder('vp8').
                                let _ = app.emit(
                                    "call-video-frame",
                                    serde_json::json!({
                                        "callId": cid,
                                        // base64: tauri events — JSON, бинарка
                                        // через строку (как релей/вложения).
                                        "frame": base64::engine::general_purpose::STANDARD.encode(&frame),
                                    }),
                                );
                            }
                            TrackRemoteEvent::OnEnded | TrackRemoteEvent::OnEnding => {
                                // Трек умер — гасим слот, чтобы следующий
                                // video_start не крутил вхолостую мёртвый Arc.
                                *video_slot.lock().await = None;
                                break;
                            }
                            _ => {}
                        }
                    }
                    _ = stop_rx.changed() => break,
                }
            }
            eprintln!("[video] remote reader finished (call {cid})");
        });
        session.video_reader = Some(reader);
        Ok(())
    }

    /// Видео (шаг 3/3): стоп reader'а remote-видео. Идемпотентно.
    pub fn video_stop(&mut self, call_id: &str) {
        if let Some(session) = self.calls.get_mut(call_id) {
            if let Some(reader) = session.video_reader.take() {
                reader.abort();
            }
        }
    }

    /// Close a call session (graceful PeerConnection teardown).
    pub async fn close(&mut self, call_id: &str) -> Result<(), String> {
        if let Some(session) = self.calls.remove(call_id) {
            let _ = session.stop_tx.send(true);
            session.pc.close().await.map_err(|e| e.to_string())?;
            // `session` здесь дропается: CameraHandle::drop гасит захват камеры
            // (шаг 2/3) и закрывает канал кадров — writer завершится сам.
        }
        Ok(())
    }

    /// Close all sessions (app shutdown).
    #[allow(dead_code)]
    pub async fn close_all(&mut self) {
        for (_id, session) in self.calls.drain() {
            let _ = session.pc.close().await;
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn media_start_outgoing(
    app: tauri::AppHandle,
    call_id: String,
    peer_public_key: String,
    peer_pq_ek: Option<String>,
    // Видео (шаг 1/3): необязательный флаг. Отсутствует/None → аудио-звонок
    // (поведение как было, старый фронт флаг не передаёт); true → в тот же
    // PeerConnection добавляется второй (VP8) track, его ssrc — в
    // SdpResult.video_ssrc.
    with_video: Option<bool>,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<SdpResult, String> {
    let mut mgr = state.lock().await;
    let with_video = with_video.unwrap_or(false);
    // Медиа-ключ: гибрид ML-KEM-768+X25519 при наличии PQ-ключей
    // Гибридный ключ: HKDF(x25519_ss ‖ mlkem_ss) — mlkem-часть отправитель
    // вычисляет инкапсуляцией против ek принимающего; kemct едет в
    // call-конверте (SdpResult.kemct → sendCallEnvelope), принимающий
    // декапсулирует в media_accept_incoming и собирает тот же HKDF.
    let mut kemct_out: Option<String> = None;
    let mut sender_ek_out: Option<String> = None;
    let media_key = match crate::key_store::load_keypair() {
        Ok(Some(kp)) => match (kp.pq_private_key.as_deref(), peer_pq_ek.as_deref()) {
            (Some(seed), Some(ek)) => {
                match crate::crypto::derive_shared_key(&kp.private_key, &peer_public_key) {
                    Ok(x_ss) => match crate::crypto_pq::media_hybrid_key_out(&x_ss, seed, ek) {
                        Ok((k, ct, my_ek)) => {
                            kemct_out = Some(ct);
                            sender_ek_out = Some(my_ek);
                            Some(k)
                        }
                        Err(e) => {
                            eprintln!("[media] PQ hybrid failed: {e}");
                            None
                        }
                    },
                    Err(e) => {
                        eprintln!("[media] DH failed: {e}");
                        None
                    }
                }
            }
            _ => match crate::crypto::derive_shared_key(&kp.private_key, &peer_public_key) {
                Ok(k) => Some(k),
                Err(e) => {
                    eprintln!("[media] DH failed: {e}");
                    None
                }
            },
        },
        _ => None,
    };
    let mut sdp = mgr
        .start_outgoing(app, &call_id, media_key, with_video)
        .await?;
    sdp.kemct = kemct_out;
    sdp.sender_ek = sender_ek_out;
    Ok(sdp)
}

#[tauri::command]
pub async fn media_accept_incoming(
    app: tauri::AppHandle,
    call_id: String,
    offer_sdp: String,
    peer_public_key: String,
    kemct: Option<String>,
    // Видео (шаг 1/3): см. media_start_outgoing — None = аудио-звонок.
    with_video: Option<bool>,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<SdpResult, String> {
    let mut mgr = state.lock().await;
    let with_video = with_video.unwrap_or(false);
    // PQ: kemct из call-конверта + свой PQ-seed → тот же гибридный
    // HKDF-ключ, что у звонящего. Нет kemct/seed — legacy X25519.
    let media_key = match crate::key_store::load_keypair() {
        Ok(Some(kp)) => match (kp.pq_private_key.as_deref(), kemct.as_deref()) {
            (Some(seed), Some(ct)) => {
                match crate::crypto::derive_shared_key(&kp.private_key, &peer_public_key) {
                    Ok(x_ss) => match crate::crypto_pq::media_hybrid_key_in(&x_ss, seed, ct) {
                        Ok(k) => Some(k),
                        Err(e) => {
                            eprintln!("[media] PQ hybrid-in failed: {e}");
                            None
                        }
                    },
                    Err(e) => {
                        eprintln!("[media] DH failed: {e}");
                        None
                    }
                }
            }
            _ => match crate::crypto::derive_shared_key(&kp.private_key, &peer_public_key) {
                Ok(k) => Some(k),
                Err(e) => {
                    eprintln!("[media] DH failed: {e}");
                    None
                }
            },
        },
        _ => None,
    };
    let sdp = mgr
        .accept_incoming(app, &call_id, &offer_sdp, media_key, with_video)
        .await?;
    Ok(sdp)
}

#[tauri::command]
pub async fn media_set_remote(
    call_id: String,
    sdp: String,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.set_remote(&call_id, &sdp).await
}

#[tauri::command]
pub async fn media_close(
    call_id: String,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.close(&call_id).await
}

#[tauri::command]
pub async fn media_set_muted(
    call_id: String,
    muted: bool,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.set_muted(&call_id, muted).await
}

/// Динамик: Android — speakerphone вкл/выкл; desktop — no-op.
#[tauri::command]
pub async fn media_set_speaker(
    call_id: String,
    on: bool,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.set_speaker(&call_id, on).await
}

/// Видео (шаг 2/3): старт камеры для активного видеозвонка. Кадры камеры
/// уходят зашифрованными в локальный VP8-трек того же PeerConnection.
///
/// Ошибка возвращается наверх, если звонок аудио-only, камера уже запущена или
/// платформенный бэкенд захвата недоступен (сейчас: Android — «не реализовано»,
/// desktop — заглушка без кадров; см. `crate::video`).
#[tauri::command]
pub async fn media_camera_start(
    call_id: String,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.camera_start(&call_id)
}

/// Видео (шаг 3/3): стоп камеры. `call_id` необязателен — без него гасим
/// камеру всех сессий (совместимо с вызовом `media_camera_stop()` без аргумента).
#[tauri::command]
pub async fn media_camera_stop(
    call_id: Option<String>,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.camera_stop(call_id.as_deref());
    Ok(())
}

/// Видео (шаг 3/3): WebCodecs-кадр из JS → локальный VP8-трек звонка.
///
/// Захват камеры и VP8-кодирование делает WebView (WebCodecs VideoEncoder —
/// Chrome 151 на Android), Rust получает уже готовый закодированный кадр.
/// Команда кладёт его в канал `write_video_loop` (E2E-шифр + RTP), как
/// нативный capture-бэкенд. Это заменяет camera2+MediaCodec через JNI.
///
/// `frame` — сырые байты EncodedVideoChunk (JS передаёт Uint8Array).
#[tauri::command]
pub async fn media_video_frame(
    call_id: String,
    frame: Vec<u8>,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    state.lock().await.video_accept_frame(&call_id, frame)
}

/// Видео (шаг 3/3): приём remote-видео. Запускает reader remote VP8-трека:
/// RTP-пакеты → депакетизация → E2E-расшифровка → кадры отдаются в UI
/// через событие `call-video-frame`. Сам трек приходит через `on_track`
/// (видео отсекается от audio-pipeline фильтром по `kind()`).
///
/// Идемпотентно: повторный вызов для того же звонка не запускает второй reader.
#[tauri::command]
pub async fn media_video_start(
    call_id: String,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.video_start(&call_id, app)
}

/// Видео (шаг 3/3): стоп приёма remote-видео (гасит reader-таску).
#[tauri::command]
pub async fn media_video_stop(
    call_id: String,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.video_stop(&call_id);
    Ok(())
}

/// Full-screen уведомление входящего звонка: Android — системное
/// уведомление поверх локскрина (JNI → VaultForegroundService.showIncomingCall);
/// desktop — no-op (окно и так видно). Вызывается из JS при incoming_ringing.
#[tauri::command]
pub async fn media_show_incoming_call(caller_name: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::audio::audio_android::show_incoming_call_notification(&caller_name);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = caller_name;
    }
    Ok(())
}

/// Убрать уведомление входящего звонка (принят/отклонён/завершён/таймаут).
#[tauri::command]
pub async fn media_dismiss_incoming_call() -> Result<(), String> {
    #[cfg(target_os = "android")]
    crate::audio::audio_android::dismiss_incoming_call_notification();
    Ok(())
}

/// «hangup» по DataChannel
/// собеседник получает за миллисекунды вместо 30-60с по email.
/// Возвращает true если отправлено по DC, false — канала нет (email fallback).
#[tauri::command]
pub async fn media_send_hangup(
    call_id: String,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<bool, String> {
    let mut mgr = state.lock().await;
    mgr.send_hangup(&call_id).await
}

#[tauri::command]
pub async fn media_set_ice_servers(
    urls: Vec<String>,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.set_ice_servers(urls);
    Ok(())
}

/// Рингтон входящего звонка: включает гудки
/// 440 Гц через cpal (независимо от webview/autoplay). Вызывается из фронта
/// при call_request, отключается при accept/reject/timeout/hangup.
#[tauri::command]
pub async fn media_ringtone_start() -> Result<(), String> {
    crate::audio::ringtone_start()
}

#[tauri::command]
pub async fn media_ringtone_stop() -> Result<(), String> {
    crate::audio::ringtone_stop();
    Ok(())
}

/// Звуки звонка: WAV-ассеты через cpal. name
/// incoming | outgoing | connect | end | missed. looped=true — крутить
/// до media_sound_stop (для incoming/outgoing). На Android — no-op
/// (фронт играет HTML5 Audio из public/sounds).
#[tauri::command]
pub async fn media_sound_play(name: String, looped: bool) -> Result<(), String> {
    // cpal может НАМЕРТВО зависнуть на enum/конфиге аудио-устройства
    // (глючный Bluetooth: default_output_device блокирует поток).
    // это выполнялось прямо в async-команде на tokio-воркере → воркер
    // занимался навсегда, и следующий invoke (email_send с call_request)
    // call_request не долетал до Gmail, call_cancel при hangup проходил).
    // Решение: cpal — в blocking-пул tokio (отдельные потоки, не воркеры)
    // + таймаут 3с, чтобы зависший cpal не блокировал рантайм.
    match timeout(
        Duration::from_secs(3),
        tokio::task::spawn_blocking(move || crate::audio::sound_play(&name, looped)),
    )
    .await
    {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => Err(format!("sound task join failed: {e}")),
        Err(_) => {
            eprintln!(
                "[sound] play timed out (cpal hung on audio device) — continuing without ringtone"
            );
            Err("sound play timed out (audio device hung)".into())
        }
    }
}

#[tauri::command]
pub async fn media_sound_stop() -> Result<(), String> {
    // Аналогично: sound_stop дропает cpal::Stream, что тоже может
    // заблокироваться на больном устройстве — в blocking-пул + таймаут.
    match timeout(
        Duration::from_secs(3),
        tokio::task::spawn_blocking(|| crate::audio::sound_stop()),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            eprintln!("[sound] stop task join failed: {e} — continuing");
            Ok(())
        }
        Err(_) => {
            eprintln!("[sound] stop timed out (cpal hung) — continuing");
            Ok(()) // остановка звука не критична — не роняем вызов
        }
    }
}
// ---------------------------------------------------------------------------
// Tests (video step 1/3: codec registration + second track; audio untouched)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal handler — the codec/track tests never negotiate, so no event
    /// has to be delivered anywhere.
    #[derive(Clone)]
    struct TestHandler;

    #[async_trait::async_trait]
    impl PeerConnectionEventHandler for TestHandler {}

    /// PeerConnection wired exactly like `build_pc` (same engine, same addrs),
    /// but without a Tauri AppHandle, so it can run in `cargo test`.
    async fn test_pc(with_video: bool) -> Arc<dyn PeerConnection> {
        Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(RTCConfigurationBuilder::new().build())
                .with_media_engine(build_media_engine(with_video).unwrap())
                .with_handler(Arc::new(TestHandler))
                .with_udp_addrs(vec!["127.0.0.1:0".to_owned()])
                .build()
                .await
                .expect("peer connection build"),
        )
    }

    async fn add_track(pc: &Arc<dyn PeerConnection>, track: TrackLocalStaticSample) {
        pc.add_track(Arc::new(track) as Arc<dyn TrackLocal>)
            .await
            .expect("add_track");
    }

    /// Local track descriptors: both codecs build (TrackLocalStaticSample::new
    /// fails when the library has no packetizer for the codec), and the video
    /// SSRC never collides with the audio one.
    #[tokio::test]
    async fn tracks_carry_their_codecs_and_distinct_ssrcs() {
        let audio_ssrc = 0x1111_2222u32;
        let video_ssrc = random_ssrc_excluding(audio_ssrc);
        assert_ne!(
            video_ssrc, audio_ssrc,
            "video SSRC must differ from audio SSRC"
        );

        // Codec params: Opus stays mono/48k, VP8 is video/90000 on PT 96.
        let opus = opus_codec();
        assert_eq!(opus.mime_type, MIME_TYPE_OPUS);
        assert_eq!(opus.clock_rate, 48000);
        assert_eq!(opus.channels, 1);
        let vp8 = vp8_codec();
        assert_eq!(vp8.mime_type, MIME_TYPE_VP8);
        assert_eq!(vp8.clock_rate, 90000);
        assert_eq!(VP8_PAYLOAD_TYPE, 96);
        assert_ne!(VP8_PAYLOAD_TYPE, OPUS_PAYLOAD_TYPE);

        let audio_track = TrackLocalStaticSample::new(audio_media_track("c1", audio_ssrc)).unwrap();
        let video_track = TrackLocalStaticSample::new(video_media_track("c1", video_ssrc)).unwrap();

        let audio_mst = audio_track.track().await;
        assert_eq!(audio_mst.kind(), RtpCodecKind::Audio);
        assert_eq!(
            audio_mst.codec(audio_ssrc).unwrap().mime_type,
            MIME_TYPE_OPUS
        );
        assert!(audio_mst.codec(video_ssrc).is_none());

        let video_mst = video_track.track().await;
        assert_eq!(video_mst.kind(), RtpCodecKind::Video);
        assert_eq!(
            video_mst.codec(video_ssrc).unwrap().mime_type,
            MIME_TYPE_VP8
        );
        assert!(video_mst.codec(audio_ssrc).is_none());
    }

    /// Offer SDP is built from the MediaEngine: with video the offer carries a
    /// second m-line with `VP8/90000` at PT 96 plus two senders (audio left in
    /// place); without video it stays audio-only — zero impact on audio calls.
    #[tokio::test]
    async fn video_call_registers_vp8_and_keeps_audio_call_audio_only() {
        let audio_ssrc = 0x0a0b_0c0du32;
        let video_ssrc = random_ssrc_excluding(audio_ssrc);

        // --- with_video = true ---------------------------------------------
        let pc = test_pc(true).await;
        add_track(
            &pc,
            TrackLocalStaticSample::new(audio_media_track("c1", audio_ssrc)).unwrap(),
        )
        .await;
        add_track(
            &pc,
            TrackLocalStaticSample::new(video_media_track("c1", video_ssrc)).unwrap(),
        )
        .await;

        let offer = tokio::time::timeout(Duration::from_secs(10), pc.create_offer(None))
            .await
            .expect("create_offer timed out")
            .expect("create_offer");
        assert!(
            offer
                .sdp
                .contains(&format!("a=rtpmap:{VP8_PAYLOAD_TYPE} VP8/90000")),
            "VP8 not registered in the media engine:\n{}",
            offer.sdp
        );
        assert!(
            offer.sdp.contains("m=audio") && offer.sdp.contains("m=video"),
            "video call offer must carry m=audio + m=video:\n{}",
            offer.sdp
        );

        let senders = pc.get_senders().await;
        assert_eq!(
            senders.len(),
            2,
            "video call must have audio + video senders"
        );
        let mut ssrcs = vec![];
        let mut kinds = vec![];
        for sender in &senders {
            let mst = sender.track().track().await;
            kinds.push(mst.kind());
            ssrcs.push(mst.ssrcs().next().unwrap());
        }
        assert!(kinds.contains(&RtpCodecKind::Audio));
        assert!(kinds.contains(&RtpCodecKind::Video));
        assert!(ssrcs.contains(&video_ssrc));
        assert_ne!(ssrcs[0], ssrcs[1], "audio and video SSRCs must differ");
        pc.close().await.expect("close");

        // --- with_video = false (prod audio path) --------------------------
        let pc = test_pc(false).await;
        add_track(
            &pc,
            TrackLocalStaticSample::new(audio_media_track("c2", audio_ssrc)).unwrap(),
        )
        .await;

        let offer = tokio::time::timeout(Duration::from_secs(10), pc.create_offer(None))
            .await
            .expect("create_offer timed out")
            .expect("create_offer");
        assert!(offer.sdp.contains("m=audio"));
        assert!(
            !offer.sdp.contains("m=video") && !offer.sdp.contains("VP8"),
            "audio-only call must not offer video:\n{}",
            offer.sdp
        );

        let senders = pc.get_senders().await;
        assert_eq!(senders.len(), 1, "audio call must have exactly one sender");
        pc.close().await.expect("close");
    }
}
