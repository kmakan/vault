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
use tokio::sync::{Mutex, watch};
use tokio::time::timeout;

use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder, RTCIceServer, RTCSessionDescription, RTCIceGatheringState,
    RTCPeerConnectionState,
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
const ICE_GATHER_TIMEOUT: Duration = Duration::from_secs(8);

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
}

impl CallMediaManager {
    pub fn new() -> Self {
        // Dev fallback: public STUN (roadmap: dev-only; X2TURN comes in Phase 3).
        let dev_ice = RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
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

        let (gather_tx, gather_rx) = channel::<()>(1);
        let (connected_tx, connected_rx) = channel::<()>(1);
        let (track_tx, track_rx) = channel::<Arc<dyn TrackRemote>>(1);

        let handler = Arc::new(CallHandler {
            gather_complete_tx: gather_tx,
            connected_tx,
            track_tx,
        });

        let pc: Arc<dyn PeerConnection> = Arc::new(
            PeerConnectionBuilder::new()
                .with_configuration(config)
                .with_media_engine(media_engine)
                .with_handler(handler)
                .with_udp_addrs(vec!["0.0.0.0:0".to_owned()])
                .build()
                .await
                .map_err(|e| e.to_string())?,
        );

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
        {
            let track = track.clone();
            let mut stop_rx = stop_rx.clone();
            let muted = muted.clone();
            let mut connected_rx = connected_rx;
            tauri::async_runtime::spawn(async move {
                tokio::select! {
                    _ = connected_rx.recv() => {}
                    _ = stop_rx.changed() => return,
                }
                eprintln!("[media] connected — starting audio pipeline");
                crate::audio::run_audio_pipeline(
                    track, ssrc, OPUS_PAYLOAD_TYPE, track_rx, stop_rx, muted, media_key,
                )
                .await;
            });
        }

        self.calls.insert(
            call_id.to_owned(),
            CallSession {
                pc: Arc::clone(&pc),
                stop_tx,
                muted,
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
        timeout(ICE_GATHER_TIMEOUT, gather_rx.recv())
            .await
            .map_err(|_| "ICE gathering timed out".to_string())?;
        let desc = pc
            .local_description()
            .await
            .ok_or_else(|| "no local description".to_string())?;
        serde_json::to_string(&desc).map_err(|e| e.to_string())
    }

    /// Start an outgoing call: build PC + track, create offer, gather ICE,
    /// return the full SDP (JSON).
    pub async fn start_outgoing(&mut self, call_id: &str, media_key: Option<[u8; 32]>) -> Result<SdpResult, String> {
        let (pc, _track, mut gather_rx) = self.build_pc(call_id, media_key).await?;

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
        call_id: &str,
        offer_sdp: &str,
        media_key: Option<[u8; 32]>,
    ) -> Result<SdpResult, String> {
        let (pc, _track, mut gather_rx) = self.build_pc(call_id, media_key).await?;

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
    mgr.start_outgoing(&call_id, media_key).await
}

#[tauri::command]
pub async fn media_accept_incoming(
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
    mgr.accept_incoming(&call_id, &offer_sdp, media_key).await
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