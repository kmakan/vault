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

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::Emitter;
use tokio::sync::{Mutex, watch};
use tokio::time::timeout;

use webrtc::data_channel::{DataChannel, DataChannelEvent};
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder, RTCIceServer, RTCSessionDescription, RTCIceGatheringState,
    RTCPeerConnectionState, SettingEngine,
};
use webrtc::runtime::{Receiver, Sender, channel};

use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::media_engine::{MIME_TYPE_OPUS, MediaEngine};
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
    RtpCodecKind,
};

/// Opus dynamic payload type (both ends are our app; registered in MediaEngine).
const OPUS_PAYLOAD_TYPE: u8 = 120;
/// Max time to wait for ICE gathering before giving up (non-trickle).
/// 4с (27.08): было 15с — ответ (SDP) создавался слишком долго, звонок
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
    /// Динамик вкл/выкл (27.08): desktop — смена устройства вывода,
    /// Android — speakerphone через JNI (audio_android::set_speakerphone).
    speaker_tx: watch::Sender<bool>,
    /// Мгновенный hangup поверх WebRTC (28.08): DataChannel «vault-ctrl».
    /// call_end по email идёт 30-60с — собеседник сидит с трубкой. DC
    /// доставляет «hangup» за миллисекунды после DTLS. None до открытия.
    dc: Option<Arc<dyn DataChannel>>,
}

/// SDP payload returned to the UI (JSON-encoded RTCSessionDescription).
#[derive(Serialize, Clone)]
pub struct SdpResult {
    pub sdp: String,
    pub call_id: String,
}

/// Event handler: forwards webrtc events into channels for the session.
#[derive(Clone)]
struct CallHandler {
    gather_complete_tx: Sender<()>,
    connected_tx: Sender<()>,
    track_tx: Sender<Arc<dyn TrackRemote>>,
    /// Мгновенный hangup (28.08): входящий DataChannel от пира (callee
    /// получает канал, созданный caller'ом, через DCEP-негосиацию).
    dc_tx: Sender<Arc<dyn DataChannel>>,
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
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let _ = self.track_tx.try_send(track);
    }

    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        let _ = self.dc_tx.try_send(dc);
    }
}

impl CallMediaManager {
    pub fn new() -> Self {
        // Dev fallback: public STUN (roadmap: dev-only; X2TURN comes in Phase 3).
        // Множество серверов: stun.l.google.com из РФ/с мобильного интернета может
        // быть недоступен (замедление/блокировка) → gathering таймаутил на Android
        // (27.08: answer создавался 22с, пока Google STUN не отвечал). Запросы ко
        // всем серверам идут ПАРАЛЛЕЛЬНО (stun_gatherer.rs), поэтому несколько
        // серверов не замедляют gathering — самый быстрый ответ даёт srflx.
        // Проверены с сети 27.08 (мс): google 36, sipgate 56, zadarma 60,
        // sipnet.ru 73, 1und1.de 60. МЁРТВЫЕ (не добавлять): stunprotocol.org
        // (DNS), stun.yandex.ru и stun.mts.ru (таймаут).
        // STUN для host/srflx. TURN (openrelay.metered.ca) убран (27.08):
        // отдаёт 400 Bad Request на все allocate → 15с ожидания gathering и
        // шум в логах. Для desktop↔desktop в одной сети host-кандидатов
        // достаточно; TURN вернём, когда поднимем свой (coturn, как у
        // SimpleX turn.simplex.im:443).
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

    /// Build a PeerConnection with an Opus audio track; returns the PC, the
    /// local track (caller writes encoded frames into it) and the ICE
    /// gathering-complete receiver.
    async fn build_pc(
        &mut self,
        app: tauri::AppHandle,
        call_id: &str,
        media_key: Option<[u8; 32]>,
    ) -> Result<(Arc<dyn PeerConnection>, Arc<TrackLocalStaticSample>, Receiver<()>), String> {
        let mut media_engine = MediaEngine::default();
        let audio_codec = RTCRtpCodec {
            mime_type: MIME_TYPE_OPUS.to_owned(),
            clock_rate: 48000,
            // MONO: энкодер/декодер audiopus используют OpusChannels::Mono
            // (audio.rs) — SDP обязан совпадать, иначе рассинхрон каналов.
            channels: 1,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: vec![],
        };
        media_engine
            .register_codec(
                RTCRtpCodecParameters {
                    rtp_codec: audio_codec.clone(),
                    payload_type: OPUS_PAYLOAD_TYPE,
                    ..Default::default()
                },
                RtpCodecKind::Audio,
            )
            .map_err(|e| e.to_string())?;

        let config = RTCConfigurationBuilder::new()
            .with_ice_servers(self.ice_servers.clone())
            .build();

        // ICE-таймауты под email-сигнализацию (27.08, корень ICE Failed):
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
        let (track_tx, track_rx) = channel::<Arc<dyn TrackRemote>>(1);
        let (dc_tx, mut dc_rx) = channel::<Arc<dyn DataChannel>>(1);

        let handler = Arc::new(CallHandler {
            gather_complete_tx: gather_tx,
            connected_tx,
            track_tx,
            dc_tx,
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

        // МГНОВЕННЫЙ HANGUP (28.08): DataChannel «vault-ctrl» поверх
        // DTLS-SCTP. call_end по email идёт 30-60с — собеседник сидит с
        // трубкой. DC доставляет «hangup» за миллисекунды. Канал создаётся
        // ДО offer/answer, чтобы DCEP-негосиация попала в SDP; у пира он
        // придёт через on_data_channel (dc_rx).
        let dc: Option<Arc<dyn DataChannel>> = match pc.create_data_channel("vault-ctrl", None).await {
            Ok(dc) => Some(dc),
            Err(e) => {
                eprintln!("[media] create_data_channel failed (hangup fallback = email): {e}");
                None
            }
        };

        // Local Opus track (SSRC random; the library packetizes samples).
        let ssrc = rand::random::<u32>();
        let track = Arc::new(
            TrackLocalStaticSample::new(MediaStreamTrack::new(
                format!("vault-audio-{call_id}"),
                format!("vault-audio-{call_id}"),
                "vault-audio".to_owned(),
                RtpCodecKind::Audio,
                vec![RTCRtpEncodingParameters {
                    rtp_coding_parameters: RTCRtpCodingParameters {
                        ssrc: Some(ssrc),
                        ..Default::default()
                    },
                    codec: audio_codec,
                    ..Default::default()
                }],
            ))
            .map_err(|e| e.to_string())?,
        );

        pc.add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
            .await
            .map_err(|e| e.to_string())?;

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
                // Событие в UI (27.08): оверлей показывает «Соединение…» до
                // этого момента, таймер разговора — только после. Раньше
                // таймер шёл с момента accept, а SDP шёл по почте до 54с —
                // пользователь видел «минуту тишины» при работающем таймере.
                if let Err(e) = app1.emit(
                    "call-media-connected",
                    serde_json::json!({ "callId": cid }),
                ) {
                    eprintln!("[media] emit call-media-connected failed: {e}");
                }
                crate::audio::run_audio_pipeline(
                    track, ssrc, OPUS_PAYLOAD_TYPE, track_rx, stop_rx, muted, media_key,
                    speaker_rx,
                )
                .await;
            });
        }

        // Слушаем ВХОДЯЩИЙ DataChannel от пира (28.08): пир создаёт свой
        // «vault-ctrl», он приходит нам через on_data_channel (dc_rx).
        // Сообщение «hangup» → событие в UI → мгновенное завершение без
        // ожидания call_end по email (30-60с).
        {
            let app2 = app.clone();
            let cid2 = call_id.to_owned();
            tauri::async_runtime::spawn(async move {
                let dc = match dc_rx.recv().await {
                    Some(dc) => dc,
                    None => return,
                };
                eprintln!("[media] remote data channel received");
                while let Some(ev) = dc.poll().await {
                    if let DataChannelEvent::OnMessage(msg) = ev {
                        let text = String::from_utf8_lossy(&msg.data);
                        if text.trim() == "hangup" {
                            eprintln!("[media] DC hangup received from peer");
                            let _ = app2.emit(
                                "call-remote-hangup",
                                serde_json::json!({ "callId": cid2 }),
                            );
                            break;
                        }
                    }
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
                dc,
            },
        );

        Ok((pc, track, gather_rx))
    }

    /// Wait for non-trickle ICE gathering; return the local SDP as a JSON
    /// string (RTCSessionDescription), or Err on timeout.
    async fn wait_for_local_sdp(
        pc: &Arc<dyn PeerConnection>,
        gather_rx: &mut Receiver<()>,
    ) -> Result<String, String> {
        // На Android (26.08) gathering НЕ завершается (Complete не приходит)
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
        // Диагностика (26.08): сколько кандидатов реально в SDP — если 0,
        // соединение не поднимется даже с partial-подходом.
        let cand_count = desc.sdp.matches("a=candidate:").count();
        eprintln!("[media] local SDP: candidates={cand_count}, len={}", sdp_json.len());
        Ok(sdp_json)
    }

    /// Start an outgoing call: build PC + track, create offer, gather ICE,
    /// return the full SDP (JSON).
    pub async fn start_outgoing(
        &mut self,
        app: tauri::AppHandle,
        call_id: &str,
        media_key: Option<[u8; 32]>,
    ) -> Result<SdpResult, String> {
        let (pc, _track, mut gather_rx) = self.build_pc(app, call_id, media_key).await?;

        let offer = pc.create_offer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(offer).await.map_err(|e| e.to_string())?;

        let sdp = Self::wait_for_local_sdp(&pc, &mut gather_rx).await?;

        Ok(SdpResult {
            sdp,
            call_id: call_id.to_owned(),
        })
    }

    /// Accept an incoming call: build PC + track, set remote offer, create
    /// answer, gather ICE, return answer SDP (JSON).
    pub async fn accept_incoming(
        &mut self,
        app: tauri::AppHandle,
        call_id: &str,
        offer_sdp: &str,
        media_key: Option<[u8; 32]>,
    ) -> Result<SdpResult, String> {
        let (pc, _track, mut gather_rx) = self.build_pc(app, call_id, media_key).await?;

        let offer: RTCSessionDescription =
            serde_json::from_str(offer_sdp).map_err(|e| e.to_string())?;
        pc.set_remote_description(offer).await.map_err(|e| e.to_string())?;

        let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
        pc.set_local_description(answer).await.map_err(|e| e.to_string())?;

        let sdp = Self::wait_for_local_sdp(&pc, &mut gather_rx).await?;

        Ok(SdpResult {
            sdp,
            call_id: call_id.to_owned(),
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
        session.muted.store(muted, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    /// Динамик вкл/выкл (27.08): Android — speakerphone через AudioManager
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

    /// Мгновенный hangup поверх WebRTC (28.08): шлёт «hangup» по
    /// DataChannel «vault-ctrl» — собеседник получает за миллисекунды,
    /// не ждёт call_end по email (30-60с). Email-сигнал остаётся как
    /// fallback (фронт шлёт его отдельно). Ok(false) если канала нет
    /// (SDP ещё не обменялись) — тогда работает только email.
    pub async fn send_hangup(&mut self, call_id: &str) -> Result<bool, String> {
        let session = self
            .calls
            .get(call_id)
            .ok_or_else(|| "call not found".to_string())?;
        let dc = match &session.dc {
            Some(dc) => Arc::clone(dc),
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

    /// Close a call session (graceful PeerConnection teardown).
    pub async fn close(&mut self, call_id: &str) -> Result<(), String> {
        if let Some(session) = self.calls.remove(call_id) {
            let _ = session.stop_tx.send(true);
            session.pc.close().await.map_err(|e| e.to_string())?;
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
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<SdpResult, String> {
    let mut mgr = state.lock().await;
    // Вычисляем общий ключ (X25519 DH) для E2E-шифрования медиа.
    let media_key = match crate::key_store::load_keypair() {
        Ok(Some(kp)) => match crate::crypto::derive_shared_key(&kp.private_key, &peer_public_key) {
            Ok(k) => Some(k),
            Err(e) => { eprintln!("[media] DH failed: {e}"); None }
        },
        _ => None,
    };
    mgr.start_outgoing(app, &call_id, media_key).await
}

#[tauri::command]
pub async fn media_accept_incoming(
    app: tauri::AppHandle,
    call_id: String,
    offer_sdp: String,
    peer_public_key: String,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<SdpResult, String> {
    let mut mgr = state.lock().await;
    let media_key = match crate::key_store::load_keypair() {
        Ok(Some(kp)) => match crate::crypto::derive_shared_key(&kp.private_key, &peer_public_key) {
            Ok(k) => Some(k),
            Err(e) => { eprintln!("[media] DH failed: {e}"); None }
        },
        _ => None,
    };
    mgr.accept_incoming(app, &call_id, &offer_sdp, media_key).await
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

/// Динамик (27.08): Android — speakerphone вкл/выкл; desktop — no-op.
#[tauri::command]
pub async fn media_set_speaker(
    call_id: String,
    on: bool,
    state: tauri::State<'_, Mutex<CallMediaManager>>,
) -> Result<(), String> {
    let mut mgr = state.lock().await;
    mgr.set_speaker(&call_id, on).await
}

/// Мгновенный hangup поверх WebRTC (28.08): «hangup» по DataChannel —
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

/// Рингтон входящего звонка (22.08, запрос пользователя): включает гудки
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

/// Звуки звонка (27.08, редизайн): WAV-ассеты через cpal. name:
/// incoming | outgoing | connect | end | missed. looped=true — крутить
/// до media_sound_stop (для incoming/outgoing). На Android — no-op
/// (фронт играет HTML5 Audio из public/sounds).
#[tauri::command]
pub async fn media_sound_play(name: String, looped: bool) -> Result<(), String> {
    // cpal может НАМЕРТВО зависнуть на enum/конфиге аудио-устройства
    // (глючный Bluetooth: default_output_device() блокирует поток). Раньше
    // это выполнялось прямо в async-команде на tokio-воркере → воркер
    // занимался навсегда, и следующий invoke (email_send с call_request)
    // не получал воркера — сигнал звонка не отправлялся (баг 27.08:
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
            eprintln!("[sound] play timed out (cpal hung on audio device) — continuing without ringtone");
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