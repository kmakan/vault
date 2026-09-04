// Android library entry point — re-exports main.rs for Tauri cdylib
mod audio;
mod credential_store;
mod crypto;
mod crypto_pq;
mod duress;
mod email;
mod groups;
// Legacy-модуль (первые итерации): не вызывается из lib.rs, оставлен как
// API-запас.
#[allow(dead_code)]
mod history_store;
mod key_escrow;
#[cfg(test)]
mod key_escrow_smoke;
mod key_store;
mod media;
mod storage;
// Headless IMAP-монитор для FGS-процесса: уведомления при убитом
// activity (свайп из recents). Android-only: JNI-входы из VaultForegroundService.
#[cfg(target_os = "android")]
mod service_monitor;

/// Общий вход инициализации ndk-context: MainActivity
/// (audio_android) и headless-монитор FGS (service_monitor) делят один
/// флаг — двойная инициализация паниковала бы (panic=abort).
#[cfg(target_os = "android")]
pub(crate) fn service_monitor_ensure_ctx(env: &mut jni::JNIEnv, context: &jni::objects::JObject) {
    service_monitor::ensure_ndk_context(env, context);
}

use credential_store::StoredCredentials;
use storage::sqlite::Storage;

use crypto::{CryptoState, KeyPair};
use email::{EmailClient, EmailConfig, EmailMessage, IdleOutcome};
use key_store::{KeyStoreMetadata, StoredKeyPair, StoredPeerKey};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::Mutex;
use tokio::time::{timeout as t_timeout, Duration};

static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn generate_keypair() -> KeyPair {
    crypto::generate_keypair_cmd()
}

#[tauri::command]
fn encrypt_message(
    plaintext: String,
    private_key: String,
    peer_public_key: Option<String>,
) -> Result<String, String> {
    crypto::encrypt_cmd(&plaintext, &private_key, peer_public_key.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn decrypt_message(
    ciphertext: String,
    private_key: String,
    peer_public_key: Option<String>,
) -> Result<String, String> {
    crypto::decrypt_cmd(&ciphertext, &private_key, peer_public_key.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn encrypt_vault_message(
    plaintext: String,
    private_key: String,
    peer_public_key: Option<String>,
    my_pq_seed: Option<String>,
    peer_pq_ek: Option<String>,
) -> Result<String, String> {
    // PQ: если у контакта есть ML-KEM-ключ — гибридный конверт.
    // Фронт получает (wire, {pq, kemct}) и кладёт метаданные в JSON-конверт.
    // Нет PQ-ключа — legacy X25519 (старые контакты/клиенты).
    match (peer_public_key.as_deref(), peer_pq_ek.as_deref()) {
        (Some(peer), Some(ek)) => {
            let (wire, hdr) = crypto_pq::hybrid_encrypt_vault(
                &plaintext,
                &private_key,
                peer,
                my_pq_seed.as_deref(),
                ek,
            )
            .map_err(|e| e.to_string())?;
            // Складываем pq/kemct в wire как разделитель:
            // "PQ1:<kemct_b64>|:<wire_b64>" — расшифровщик понимает оба формата.
            let kemct = hdr.kemct.unwrap_or_default();
            let pq = hdr.pq.unwrap_or_default();
            Ok(format!("PQ1:{kemct}|{pq}|{wire}"))
        }
        _ => crypto::encrypt_vault_cmd(&plaintext, &private_key, peer_public_key.as_deref())
            .map_err(|e| e.to_string()),
    }
}

#[tauri::command]
fn decrypt_vault_message(
    ciphertext: String,
    private_key: String,
    peer_public_key: Option<String>,
    my_pq_seed: Option<String>,
    sender_pq_ek: Option<String>,
) -> Result<String, String> {
    // PQ: "PQ1:<kemct>|<sender_ek>|<wire>" — гибрид
    // прочее — legacy X25519. Порядок фолбэка важен: гибрид не должен
    // молча падать на legacy (иначе PQ-защита исчезает незаметно).
    let trimmed = ciphertext.trim();
    if let Some(rest) = trimmed.strip_prefix("PQ1:") {
        let parts: Vec<&str> = rest.splitn(3, '|').collect();
        if parts.len() == 3 {
            let (kemct, _sender_ek, wire) = (parts[0], parts[1], parts[2]);
            // my_pq_seed обязателен; peer (sender) X25519 ключ — из конверта
            let peer_key = peer_public_key.as_deref();
            let seed = my_pq_seed
                .as_deref()
                .ok_or_else(|| "PQ message but no PQ seed".to_string())?;
            let peer = peer_key.ok_or_else(|| "PQ message but no sender key".to_string())?;
            // Сохраняем ek отправителя для ответа (фронт вызовет save_peer_key)
            let _ = sender_pq_ek;
            return crypto_pq::hybrid_decrypt_vault(wire, &private_key, peer, seed, kemct)
                .map_err(|e| e.to_string());
        }
    }
    crypto::decrypt_vault_cmd(&ciphertext, &private_key, peer_public_key.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_app_icon(app: tauri::AppHandle, icon_id: String) -> Result<(), String> {
    let png: &[u8] = match icon_id.as_str() {
        "door" => include_bytes!("../icons/vault_icon_vault-door.png"),
        "envelope" => include_bytes!("../icons/vault_icon_vault-envelope.png"),
        "keyhole" => include_bytes!("../icons/vault_icon_vault-keyhole.png"),
        "letter" => include_bytes!("../icons/vault_icon_vault-letter.png"),
        "shield" => include_bytes!("../icons/vault_icon_vault-shield.png"),
        _ => return Err("unknown icon".to_string()),
    };

    let image = tauri::image::Image::from_bytes(png).map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    if let Some(win) = app.get_webview_window("main") {
        win.set_icon(image).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_fingerprint(public_key: String) -> Result<String, String> {
    crypto::fingerprint_cmd(&public_key).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_my_keypair(
    public_key: String,
    private_key: String,
    pq_public_key: Option<String>,
    pq_private_key: Option<String>,
) -> Result<(), String> {
    // PQ-мерж: при отсутствии новых PQ-полей сохраняем старые
    // экспорт/импорт и старый фронт (без PQ) не должны стирать PQ-пару.
    let (pq_public_key, pq_private_key) = match (pq_public_key, pq_private_key) {
        (Some(p), Some(s)) => (Some(p), Some(s)),
        _ => match key_store::load_keypair() {
            Ok(Some(old)) => (old.pq_public_key, old.pq_private_key),
            _ => (None, None),
        },
    };
    let keypair = StoredKeyPair {
        public_key,
        private_key,
        created_at: chrono::Utc::now().to_rfc3339(),
        pq_public_key,
        pq_private_key,
    };
    key_store::save_keypair(&keypair).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_my_keypair() -> Result<Option<StoredKeyPair>, String> {
    key_store::load_keypair().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_peer_key(
    email: String,
    public_key: String,
    label: Option<String>,
    pq_public_key: Option<String>,
) -> Result<(), String> {
    let key = StoredPeerKey {
        email,
        public_key,
        label,
        added_at: chrono::Utc::now().to_rfc3339(),
        pq_public_key,
    };
    key_store::add_peer_key(key).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_peer_keys() -> Result<Vec<StoredPeerKey>, String> {
    key_store::load_peer_keys().map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_peer_key(email: String) -> Result<bool, String> {
    key_store::remove_peer_key(&email).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_keys() -> Result<String, String> {
    key_store::export_keys().map_err(|e| e.to_string())
}

#[tauri::command]
fn import_keys(json_data: String) -> Result<KeyStoreMetadata, String> {
    key_store::import_keys(&json_data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_key_store_metadata() -> Result<Option<KeyStoreMetadata>, String> {
    key_store::get_store_metadata().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_all_keys() -> Result<(), String> {
    key_store::delete_all_keys().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

// --- Saved mailbox credentials (encrypted on device, auto-login on start) ---

#[tauri::command]
fn save_credentials(
    email: String,
    password: String,
    imap_server: String,
    imap_port: u16,
    smtp_server: String,
    smtp_port: u16,
) -> Result<(), String> {
    let creds = StoredCredentials {
        email,
        password,
        imap_server,
        imap_port,
        smtp_server,
        smtp_port,
        saved_at: chrono::Utc::now().to_rfc3339(),
    };
    credential_store::save_credentials(&creds).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_credentials() -> Result<Option<StoredCredentials>, String> {
    credential_store::load_credentials().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_credentials() -> Result<bool, String> {
    credential_store::delete_credentials().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_close_to_tray() -> bool {
    CLOSE_TO_TRAY.load(Ordering::Relaxed)
}

#[tauri::command]
fn encrypt_symmetric(plaintext: String, key: String) -> Result<String, String> {
    crypto::encrypt_symmetric_cmd(&plaintext, &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn decrypt_symmetric(ciphertext: String, key: String) -> Result<String, String> {
    crypto::decrypt_symmetric_cmd(&ciphertext, &key).map_err(|e| e.to_string())
}

/// Holds the live IMAP/SMTP session between Tauri command calls.
/// Слот 0 — IMAP-клиент (поллинг/фетчи); слот 1 — конфиг для SMTP-отправки.
/// SMTP отдельно от IMAP-lock: при зависшей IMAP-сессии (сломанный сокет,
/// каждая операция упирается в 30с таймаут) отправка НЕ должна ждать lock
/// и падать «Timed out waiting for email client lock».
/// Слот 2 — IMAP IDLE-клиент (Фаза 1.5 звонков): отдельная сессия, чтобы
/// IDLE (блокирующее ожидание) не держал lock основной сессии поллинга/UI.
pub struct EmailState(
    pub Mutex<Option<EmailClient>>,
    pub Mutex<Option<EmailConfig>>,
    pub Mutex<Option<EmailClient>>,
);

/// Результат инкрементального фетча: новые письма + обновлённые курсоры.
#[derive(Serialize)]
pub struct IncrementalFetchResult {
    pub messages: Vec<EmailMessage>,
    pub cursors: HashMap<String, u32>,
}

impl Default for EmailState {
    fn default() -> Self {
        Self(Mutex::new(None), Mutex::new(None), Mutex::new(None))
    }
}

/// Фоновый IMAP IDLE-монитор: цикл «IDLE → fetch → emit»
/// живёт в Rust-таске и НЕ зависит от JS-таймеров — при заморозке/торможении
/// WebView доставка писем и сигналов звонков не деградирует до 30с-поллинга.
/// Каждое событие: fetch_newer (INBOX+JUNK+All, свои курсоры) → emit
/// «mail-changed» {messages, cursors}; фронт обрабатывает их тем же путём,
#[derive(Default)]
pub struct IdleMonitor {
    stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

#[allow(dead_code)]
fn idle_stop_flag(state: &tauri::State<'_, IdleMonitor>) {
    state.stop.store(true, Ordering::SeqCst);
}

#[tauri::command]
async fn email_idle_start(
    app: tauri::AppHandle,
    email_state: State<'_, EmailState>,
    monitor: State<'_, IdleMonitor>,
    cursors: HashMap<String, u32>,
) -> Result<(), String> {
    use tauri::Emitter;
    let cfg = email_state
        .1
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    // Идемпотентно: повторный старт (смена почты, ребилд сессии) не плодит
    // второй цикл — старый останавливаем и запускаем новый со свежим конфигом.
    monitor.stop.store(true, Ordering::SeqCst);
    // ждём, пока старый таск завершится (макс. ~8с: idle tick 7с)
    for _ in 0..40 {
        if !monitor.running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    monitor.stop.store(false, Ordering::SeqCst);
    monitor.running.store(true, Ordering::SeqCst);
    let stop = monitor.stop.clone();
    let running = monitor.running.clone();
    tauri::async_runtime::spawn(async move {
        let mut client = EmailClient::new(cfg);
        // Стартовые курсоры приходят от фронта (cursorsCache) — иначе
        // пустой HashMap заставил бы fetch_newer тянуть последние ~100
        // писем INBOX при каждом старте монитора.
        let mut cursors: HashMap<String, u32> = cursors;
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            // Подключение (после сбоя — переподключение с backoff).
            if let Err(e) = client.connect_imap().await {
                eprintln!("[idle-monitor] connect failed: {e}");
                for _ in 0..15 {
                    if stop.load(Ordering::SeqCst) {
                        running.store(false, Ordering::SeqCst);
                        return;
                    }
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                continue;
            }
            // IDLE-тик 7с: серверный push приходит за ~1с, а сам тик служит
            // страховкой для JUNK (Gmail кладёт call_* в спам, IDLE-INBOX его
            let changed = match client.idle_wait("INBOX", Duration::from_secs(7)).await {
                Ok(o) => o == IdleOutcome::Changed,
                Err(e) => {
                    eprintln!("[idle-monitor] idle failed: {e}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match client.fetch_newer(&cursors).await {
                Ok((msgs, new_cursors)) => {
                    cursors = new_cursors;
                    if !msgs.is_empty() || changed {
                        let payload = serde_json::json!({
                            "messages": msgs,
                            "cursors": cursors,
                        });
                        if let Err(e) = app.emit("mail-changed", payload) {
                            eprintln!("[idle-monitor] emit failed: {e}");
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[idle-monitor] fetch_newer failed: {e}");
                    // Сессия могла рассинхрониться — на следующем витке
                    // переподключимся (connect_imap выше).
                    let _ = client.disconnect();
                }
            }
        }
        let _ = client.disconnect();
        running.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
async fn email_idle_stop(monitor: State<'_, IdleMonitor>) -> Result<(), String> {
    monitor.stop.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn email_connect(config: EmailConfig, state: State<'_, EmailState>) -> Result<bool, String> {
    // Disconnect any previous session before opening a new one.
    let mut guard = state.0.lock().await;
    if let Some(mut client) = guard.take() {
        client.disconnect();
    }

    let mut client = EmailClient::new(config.clone());
    client
        .connect_imap()
        .await
        .map_err(|e| format!("Failed to connect: {e}"))?;

    *guard = Some(client);
    *state.1.lock().await = Some(config);
    Ok(true)
}

#[tauri::command]
async fn email_fetch_messages(state: State<'_, EmailState>) -> Result<Vec<EmailMessage>, String> {
    // Полный скан (fetchPendingContactInvites/Accepts при входе) НЕ должен
    // блокировать UI-фетчи: если клиент занят — возвращаем пусто, инвайты
    // подхватятся следующим тиком. Иначе на большом INBOX полный скан
    // держит lock десятки секунд и fetch_bodies падает.
    let Ok(mut guard) = state.0.try_lock() else {
        return Ok(Vec::new());
    };
    let client = guard
        .as_mut()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    match t_timeout(Duration::from_secs(30), client.fetch_messages()).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(first_err)) => {
            // Gmail обрывает idle-соединения — переподключаемся и повторяем
            // один раз (reconnect тоже с таймаутом).
            t_timeout(Duration::from_secs(15), client.reconnect_imap())
                .await
                .map_err(|_| format!("Reconnect timed out (original: {first_err})"))?
                .map_err(|e| format!("Reconnect failed: {e} (original: {first_err})"))?;
            t_timeout(Duration::from_secs(30), client.fetch_messages())
                .await
                .map_err(|_| "Full scan timed out (retry)".to_string())?
                .map_err(|e| e.to_string())
        }
        Err(_) => Err("Full scan timed out".to_string()),
    }
}

/// Инкрементальный фетч: только письма новее per-folder UID-курсоров.
/// Возвращает новые письма + обновлённые курсоры; первый запуск (пустые
/// курсоры) — полный скан последних писем + инициализация курсоров.
#[tauri::command]
async fn email_fetch_incremental(
    state: State<'_, EmailState>,
    cursors: HashMap<String, u32>,
) -> Result<IncrementalFetchResult, String> {
    // Поллинг НЕ ждёт lock: если клиент занят UI-операцией (fetch_bodies при
    // открытии чата), тик молча пропускается — фоновый поллинг не должен
    // из-за «Timed out waiting for email client lock»).
    let Ok(mut guard) = state.0.try_lock() else {
        eprintln!("[email] incremental SKIPPED: client lock busy");
        return Ok(IncrementalFetchResult {
            messages: vec![],
            cursors,
        });
    };
    // Весь поллинг ≤ 35с: если IMAP-сессия деградировала (троттлинг Gmail,
    // сеть), fetch_newer/reconnect не должны держать клиент и lock вечно.
    let result = t_timeout(Duration::from_secs(35), async {
        let client = guard
            .as_mut()
            .ok_or_else(|| "Not connected to email server".to_string())?;
        let to_result = |r: anyhow::Result<(Vec<EmailMessage>, HashMap<String, u32>)>| {
            r.map(|(messages, cursors)| IncrementalFetchResult { messages, cursors })
                .map_err(|e| e.to_string())
        };
        match to_result(client.fetch_newer(&cursors).await) {
            Ok(v) => Ok(v),
            Err(first_err) => {
                t_timeout(Duration::from_secs(20), client.reconnect_imap())
                    .await
                    .map_err(|_| format!("Reconnect timed out (original: {first_err})"))?
                    .map_err(|e| format!("Reconnect failed: {e} (original: {first_err})"))?;
                to_result(client.fetch_newer(&cursors).await)
            }
        }
    })
    .await
    .map_err(|_| "Incremental fetch timed out".to_string())?;
    drop(guard);
    result
}

#[tauri::command]
async fn email_fetch_incremental_fast(
    state: State<'_, EmailState>,
    cursors: HashMap<String, u32>,
) -> Result<IncrementalFetchResult, String> {
    // email_fetch_bodies), НЕ конкурирует за основной lock (state.0), который
    // может быть занят зависшими операциями (троттлинг Gmail) — при этом
    // входящий call_request не виден часами.
    let cfg = t_timeout(Duration::from_secs(10), state.1.lock())
        .await
        .map_err(|_| "Timed out waiting for config lock".to_string())?
        .clone()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    let mut client = EmailClient::new(cfg);
    client
        .connect_imap()
        .await
        .map_err(|e| format!("Failed to connect for fast fetch: {e}"))?;
    let result = t_timeout(Duration::from_secs(30), client.fetch_newer(&cursors))
        .await
        .map_err(|_| "Fast incremental fetch timed out".to_string())?
        .map_err(|e| e.to_string())
        .map(|(messages, cursors)| IncrementalFetchResult { messages, cursors });
    let _ = client.disconnect();
    result
}

#[tauri::command]
async fn email_fetch_body(
    uid: String,
    folder: Option<String>,
    state: State<'_, EmailState>,
) -> Result<String, String> {
    let folder = folder.unwrap_or_else(|| "INBOX".to_string());
    // Поштучный фетч (инвайты/аватары) НЕ должен держать lock вечно:
    // таймаут на lock и на саму операцию — иначе при медленном сокете
    // N писем × 30с блокируют UI-фетчи тел.
    let mut guard = t_timeout(Duration::from_secs(30), state.0.lock())
        .await
        .map_err(|_| "Timed out waiting for email client lock".to_string())?;
    let client = guard
        .as_mut()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    match t_timeout(
        Duration::from_secs(25),
        client.fetch_message_body(&uid, &folder),
    )
    .await
    {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(first_err)) => {
            t_timeout(Duration::from_secs(15), client.reconnect_imap())
                .await
                .map_err(|_| format!("Reconnect timed out (original: {first_err})"))?
                .map_err(|e| format!("Reconnect failed: {e} (original: {first_err})"))?;
            t_timeout(
                Duration::from_secs(25),
                client.fetch_message_body(&uid, &folder),
            )
            .await
            .map_err(|_| "Timed out fetching body (retry)".to_string())?
            .map_err(|e| e.to_string())
        }
        Err(_) => Err("Timed out fetching message body".to_string()),
    }
}

#[tauri::command]
async fn email_fetch_bodies(
    uids: Vec<String>,
    folder: Option<String>,
    state: State<'_, EmailState>,
) -> Result<Vec<(String, String)>, String> {
    let folder = folder.unwrap_or_else(|| "INBOX".to_string());
    // UI-фетч тел на ОТДЕЛЬНОМ соединении: imap 2.4.1 синхронный — его
    // uid_fetch НЕ прерывается t_timeout (идёт до сокет-таймаута 30с).
    // На общем клиенте (поллинг + reconnect + retry) один такой фетч
    // держал lock 60-90с, и ВСЕ параллельные fetch_bodies падали по
    // lock-таймауту. Отдельный клиент
    // из config: поллинг и UI не конкурируют вообще.
    let cfg = t_timeout(Duration::from_secs(10), state.1.lock())
        .await
        .map_err(|_| "Timed out waiting for config lock".to_string())?
        .clone()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    let mut client = EmailClient::new(cfg);
    client
        .connect_imap()
        .await
        .map_err(|e| format!("Failed to connect for bodies: {e}"))?;
    t_timeout(Duration::from_secs(60), client.fetch_bodies(&uids, &folder))
        .await
        .map_err(|_| "Timed out fetching message bodies".to_string())?
        .map_err(|e| e.to_string())
}

/// Скопировать эскроу-письмо из спама/ToMyself во INBOX.
/// Вызывается из locateEscrow при нахождении письма не в INBOX.
#[tauri::command]
async fn email_copy_to_inbox(
    uid: String,
    folder: String,
    state: State<'_, EmailState>,
) -> Result<(), String> {
    let cfg = t_timeout(Duration::from_secs(10), state.1.lock())
        .await
        .map_err(|_| "Timed out waiting for config lock".to_string())?
        .clone()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    let mut client = EmailClient::new(cfg);
    client
        .connect_imap()
        .await
        .map_err(|e| format!("Failed to connect: {e}"))?;
    t_timeout(Duration::from_secs(30), client.copy_to_inbox(&folder, &uid))
        .await
        .map_err(|_| "Timed out copying to inbox".to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn email_send(
    to: String,
    subject: String,
    body: String,
    state: State<'_, EmailState>,
) -> Result<bool, String> {
    // SMTP НЕ ждёт IMAP-lock: берём config из отдельного слота и отправляем
    // своим транспортом. Иначе при зависшей IMAP-сессии (сломанный сокет —
    // каждая операция упирается в 30с таймаут) отправка ждала бы lock и
    // падала «Timed out waiting for email client lock».
    let cfg = t_timeout(Duration::from_secs(10), state.1.lock())
        .await
        .map_err(|_| "Timed out waiting for config lock".to_string())?
        .clone()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    let mut client = EmailClient::new(cfg);
    // SMTP: lettre-транспорт с 30с таймаутом на операцию. ВАЖНО
    // отправку успешной, ретрай не запускался, сигнал звонка терялся навсегда
    // Теперь возвращаем реальный статус: Err → JS-ретрай sendCallEnvelope ×3.
    match t_timeout(
        Duration::from_secs(45),
        client.send_email(&to, &subject, &body),
    )
    .await
    {
        Ok(Ok(())) => Ok(true),
        Ok(Err(e)) => {
            eprintln!("[email] send error: {e}");
            Err(format!("SMTP send failed: {e}"))
        }
        Err(_) => {
            eprintln!("[email] send timed out (45s)");
            Err("SMTP send timed out".to_string())
        }
    }
}

#[tauri::command]
async fn email_disconnect(
    state: State<'_, EmailState>,
    monitor: State<'_, IdleMonitor>,
) -> Result<(), String> {
    // Фоновый монитор гасим первым — иначе он переподключится сразу после disconnect.
    monitor.stop.store(true, Ordering::SeqCst);
    let mut guard = state.0.lock().await;
    if let Some(mut client) = guard.take() {
        client.disconnect();
    }
    // IDLE-клиент тоже закрываем — отдельная сессия (слот 2).
    let mut idle = state.2.lock().await;
    if let Some(mut client) = idle.take() {
        client.disconnect();
    }
    *state.1.lock().await = None;
    Ok(())
}

/// Результат IMAP IDLE (Фаза 1.5 звонков): появилось ли новое письмо.
#[derive(Serialize)]
struct IdleResult {
    changed: bool,
}

/// IMAP IDLE: блокируется до появления нового письма в `folder` или до
/// истечения `timeout_ms`. Сигнализация звонков call_* доходит за ~1с вместо
/// 3с ускоренного поллинга. Использует ОТДЕЛЬНУЮ сессию (слот 2 EmailState) —
/// основная (поллинг/UI) не блокируется. Фолбэк при ошибке/неподдержке IDLE —
/// ускоренный поллинг во фронте.
#[tauri::command]
async fn email_idle_wait(
    state: State<'_, EmailState>,
    folder: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<IdleResult, String> {
    let folder = folder.unwrap_or_else(|| "INBOX".to_string());
    let timeout_ms = timeout_ms.unwrap_or(20_000).clamp(1000, 120_000);
    // Конфиг из слота 1 (как email_fetch_bodies) — IDLE-клиент создаётся
    // лениво при первом вызове и живёт до email_disconnect.
    let cfg = state
        .1
        .lock()
        .await
        .clone()
        .ok_or_else(|| "Not connected to email server".to_string())?;
    let mut guard = state.2.lock().await;
    if guard.is_none() {
        *guard = Some(EmailClient::new(cfg));
    }
    let client = guard.as_mut().expect("just set");
    // IDLE — синхронная IMAP-операция (как uid_fetch в imap 2.4.1);
    // ограничивается самим wait_with_timeout, t_timeout её не прервёт.
    client
        .idle_wait(&folder, Duration::from_millis(timeout_ms))
        .await
        .map(|o| IdleResult {
            changed: o == IdleOutcome::Changed,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_load() -> Result<Vec<groups::Group>, String> {
    groups::load_groups()
        .map(|g| g.into_values().collect())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_create(name: String, creator: String) -> Result<groups::Group, String> {
    groups::create_group(&name, &creator).map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_add_member(group_id: String, email: String) -> Result<groups::Group, String> {
    groups::add_member(&group_id, &email).map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| {
            g.get(&group_id)
                .cloned()
                .ok_or_else(|| "Group not found".to_string())
        })
        .map_err(|e| e.to_string())?
}

/// Смена адреса участника группы (смена почты, тот же fingerprint).
/// Фронт проверяет, что old/new привязаны к одному ключу (peer_keys).
#[tauri::command]
fn groups_rename_member(
    group_id: String,
    old_email: String,
    new_email: String,
) -> Result<groups::Group, String> {
    groups::rename_member(&group_id, &old_email, &new_email).map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| {
            g.get(&group_id)
                .cloned()
                .ok_or_else(|| "Group not found".to_string())
        })
        .map_err(|e| e.to_string())?
}

/// Membership по fingerprint: массовое заполнение fingerprint
/// участников из peer_keys (ленивая миграция старых groups.json). Идемпотентно:
/// пустой fingerprint не затирает существующий.
#[tauri::command]
fn groups_save_member_fingerprints(
    group_id: String,
    members: Vec<MemberFingerprintIn>,
) -> Result<groups::Group, String> {
    let mut groups = groups::load_groups().map_err(|e| e.to_string())?;
    let group = groups
        .get_mut(&group_id)
        .ok_or_else(|| "Group not found".to_string())?;
    for m in members {
        if m.fingerprint.is_empty() {
            continue;
        }
        if let Some(existing) = group
            .members
            .iter_mut()
            .find(|x| x.email.eq_ignore_ascii_case(&m.email))
        {
            if existing.fingerprint.is_empty() {
                existing.fingerprint = m.fingerprint;
            }
        }
    }
    groups::save_groups(&groups).map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| {
            g.get(&group_id)
                .cloned()
                .ok_or_else(|| "Group not found".to_string())
        })
        .map_err(|e| e.to_string())?
}

/// Вход для groups_save_member_fingerprints (JS-объект { email, fingerprint }).
#[derive(Debug, serde::Deserialize)]
struct MemberFingerprintIn {
    email: String,
    #[serde(default)]
    fingerprint: String,
}

#[tauri::command]
fn groups_remove_member(group_id: String, email: String) -> Result<groups::Group, String> {
    groups::remove_member(&group_id, &email).map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| {
            g.get(&group_id)
                .cloned()
                .ok_or_else(|| "Group not found".to_string())
        })
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn groups_set_member_role(
    group_id: String,
    email: String,
    role: String,
) -> Result<groups::Group, String> {
    let role = match role.as_str() {
        "Admin" => groups::GroupRole::Admin,
        "Member" => groups::GroupRole::Member,
        // "Moderator" is a legacy role (removed from the model) — cannot be assigned.
        _ => return Err("Unknown role".to_string()),
    };
    groups::set_member_role(&group_id, &email, role).map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| {
            g.get(&group_id)
                .cloned()
                .ok_or_else(|| "Group not found".to_string())
        })
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn groups_leave(group_id: String, email: String) -> Result<groups::Group, String> {
    groups::remove_member(&group_id, &email).map_err(|e| e.to_string())?;
    groups::load_groups()
        .map(|g| {
            g.get(&group_id)
                .cloned()
                .ok_or_else(|| "Group not found".to_string())
        })
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn groups_delete(group_id: String) -> Result<(), String> {
    groups::delete_group(&group_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_rename(group_id: String, new_name: String) -> Result<groups::Group, String> {
    groups::rename_group(&group_id, &new_name).map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_get(group_id: String) -> Result<Option<groups::Group>, String> {
    groups::load_groups()
        .map(|g| g.get(&group_id).cloned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_import(
    group_id: String,
    name: String,
    group_key: String,
    sender: String,
    created_by: Option<String>,
    members: Option<Vec<groups::GroupMember>>,
) -> Result<groups::Group, String> {
    groups::import_group(
        &group_id,
        &name,
        &group_key,
        &sender,
        created_by.as_deref(),
        members.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn groups_set_key(group_id: String, group_key: String) -> Result<(), String> {
    groups::set_group_key(&group_id, &group_key).map_err(|e| e.to_string())
}

// localStorage/IndexedDB for durable state) ---
// Всё локальное состояние Vault живёт в sqlite (~/.local/share/
// com.vault.vault/vault.db): история чатов, tombstones, IMAP-курсоры,
// кэш тел, key/value.
// квота ~5 МБ (body-cache у Gmail-аккаунтов уже 3–7 МБ) и он ненадёжен
// в WebKitGTK. Никакой зависимости от IndexedDB.

fn open_db() -> Result<Storage, String> {
    Storage::open(None).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_history_save(account: String, chat_key: String, messages_json: String) -> Result<(), String> {
    open_db()?
        .save_history(&account, &chat_key, &messages_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_history_load(account: String, chat_key: String) -> Result<Option<String>, String> {
    open_db()?
        .load_history(&account, &chat_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_history_clear(account: String) -> Result<(), String> {
    open_db()?
        .clear_history(&account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_tombstone_add(account: String, msg_id: String, mid: String) -> Result<(), String> {
    eprintln!("[db_tombstone_add] account={account} msg_id={msg_id} mid={mid}");
    open_db()?
        .add_tombstone(&account, &msg_id, &mid)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_tombstones_load(account: String) -> Result<Vec<(String, String)>, String> {
    let rows = open_db()?
        .load_tombstones(&account)
        .map_err(|e| e.to_string())?;
    eprintln!("[db_tombstones_load] account={account} rows={}", rows.len());
    Ok(rows)
}

#[tauri::command]
fn db_tombstones_clear(account: String) -> Result<(), String> {
    open_db()?
        .clear_tombstones(&account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_cursors_save(account: String, cursors_json: String) -> Result<(), String> {
    open_db()?
        .save_cursors(&account, &cursors_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_cursors_load(account: String) -> Result<HashMap<String, u32>, String> {
    open_db()?.load_cursors(&account).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_body_cache_set(account: String, cache_key: String, body: String) -> Result<(), String> {
    open_db()?
        .body_cache_set(&account, &cache_key, &body)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_body_cache_get(account: String, cache_key: String) -> Result<Option<String>, String> {
    open_db()?
        .body_cache_get(&account, &cache_key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_body_cache_clear(account: String) -> Result<(), String> {
    open_db()?
        .body_cache_clear(&account)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_body_cache_load_all(account: String) -> Result<Vec<(String, String)>, String> {
    open_db()?
        .body_cache_load_all(&account)
        .map_err(|e| e.to_string())
}

/// автоочистка — удалить с устройства всё старше cutoff (ISO).
#[tauri::command]
fn db_autoclean_purge(account: String, keys_json: String) -> Result<usize, String> {
    open_db()?
        .autoclean_purge(&account, &keys_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn debug_log(msg: String) {
    eprintln!("[JS] {}", msg);
}

/// RELEASE-PREP: проверка обновлений. GET latest.json с
/// vault-msg.ru (статический файл на нашем nginx, без серверного кода).
/// Возвращает {version, changelog, apk_url, desktop_url} или
/// Err(message) при сетевой недоступности — фронт покажет мягкий текст.
/// HTTP-клиент: native-tls (уже в дереве для lettre) — без новых зависимостей.
/// Хост проверки обновлений (RELEASE-PREP): connect + Host-заголовок в check_app_update.
const UPDATE_ENDPOINT_HOST: &str = "vault-msg.ru";

#[tauri::command]
async fn check_app_update(current_version: String) -> Result<Option<serde_json::Value>, String> {
    const TIMEOUT_SECS: u64 = 10;

    // численно по компонентам, не лексикографически.
    fn version_gt(a: &str, b: &str) -> bool {
        let parse = |s: &str| -> Vec<u64> {
            s.trim_start_matches('v')
                .split(|c: char| !c.is_ascii_digit())
                .filter(|p| !p.is_empty())
                .map(|p| p.parse::<u64>().unwrap_or(0))
                .collect()
        };
        let (av, bv) = (parse(a), parse(b));
        for i in 0..av.len().max(bv.len()) {
            let (x, y) = (
                av.get(i).copied().unwrap_or(0),
                bv.get(i).copied().unwrap_or(0),
            );
            if x != y {
                return x > y;
            }
        }
        false
    }

    let response = t_timeout(std::time::Duration::from_secs(TIMEOUT_SECS), async {
        use std::io::Read;
        use std::net::TcpStream;

        // native-tls handshake + минимальный HTTP/1.1 GET. Сервер — наш nginx
        // со статикой; редиректов и чанков не ожидаем, но обрабатываем оба.
        let connector = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
        let stream = TcpStream::connect((UPDATE_ENDPOINT_HOST, 443)).map_err(|e| e.to_string())?;
        let mut stream = connector
            .connect(UPDATE_ENDPOINT_HOST, stream)
            .map_err(|e| e.to_string())?;
        let req = format!(
            "GET /latest.json HTTP/1.1\r\nHost: {}\r\nUser-Agent: Vault/{}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
            UPDATE_ENDPOINT_HOST, current_version
        );
        use std::io::Write;
        stream
            .write_all(req.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok::<String, String>(String::from_utf8_lossy(&buf).to_string())
    })
    .await
    .map_err(|_| "timeout".to_string())??;

    // Выделить тело: после первого пустого-строчного разделителя.
    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .ok_or("bad http response")?;
    let latest: serde_json::Value =
        serde_json::from_str(body.trim()).map_err(|e| format!("bad json: {e}"))?;
    let remote_version = latest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or("no version field")?
        .to_string();
    if version_gt(&remote_version, &current_version) {
        Ok(Some(latest))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn db_kv_set(account: String, key: String, value: String) -> Result<(), String> {
    open_db()?
        .kv_set(&account, &key, &value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_kv_get(account: String, key: String) -> Result<Option<String>, String> {
    open_db()?.kv_get(&account, &key).map_err(|e| e.to_string())
}

/// Открыть URL системным браузером (Android: ACTION_VIEW через JNI-мост в
/// VaultForegroundService.openUrlCompat — плагин-opener на Android не доходил
/// до браузера; desktop: plugin-shell openExternal-путь не используется, вызов
/// только с мобильных). Возвращает Ok(()) даже если браузер не открылся —
/// фолбэк (anchor-click) уже был сделан во фронте.
#[tauri::command]
fn android_open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let url_for_log = url.clone();
        let r = std::panic::catch_unwind(move || {
            let ctx = ndk_context::android_context();
            let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
                .map_err(|e| format!("vm: {e}"))?;
            let mut env = vm
                .attach_current_thread()
                .map_err(|e| format!("attach: {e}"))?;
            let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
            let jurl = env.new_string(&url).map_err(|e| format!("u: {e}"))?;
            let cls = crate::audio::audio_android::find_app_class(
                &mut env,
                &activity,
                "com.vault.vault.VaultForegroundService",
            )
            .map_err(|e| format!("find class: {e}"))?;
            let call = env.call_static_method(
                &cls,
                "openUrlCompat",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[(&activity).into(), (&jurl).into()],
            );
            if let Err(err) = call {
                let _ = env.exception_clear();
                return Err(format!("openUrlCompat: {err}"));
            }
            Ok::<(), String>(())
        });
        match r {
            Ok(Ok(())) => log::info!("[android] openUrl ok: {url_for_log}"),
            Ok(Err(e)) => log::error!("[android] openUrl failed: {e}"),
            Err(_) => log::error!("[android] openUrl panic"),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = url;
        log::info!("[android] openUrl called on non-android — skip");
    }
    Ok(())
}

// ── Duress-защита ──────────────────────────────────────────────
#[tauri::command]
fn duress_get_config() -> Result<duress::DuressConfig, String> {
    Ok(duress::load_config())
}

/// Сохранение конфига: фронт сам хэширует? НЕТ — хэширует Rust (соль внутри).
/// Вход: уже проверенные секреты в открытом виде? НЕТ — принимаем готовые хэши
/// из duress_hash_secret, чтобы секрет не ходил дважды.
#[tauri::command]
fn duress_hash_secret(secret: String) -> Result<String, String> {
    Ok(duress::hash_secret(&secret))
}

#[tauri::command]
fn duress_verify(secret: String, stored_hash: String) -> Result<bool, String> {
    Ok(duress::verify_secret(&secret, &stored_hash))
}

#[tauri::command]
fn duress_save_config(config: duress::DuressConfig) -> Result<(), String> {
    duress::save_config(&config)
}

#[tauri::command]
fn duress_wipe_all() -> Result<(), String> {
    duress::wipe_all_data()
}

#[tauri::command]
fn db_kv_delete(account: String, key: String) -> Result<(), String> {
    open_db()?
        .kv_delete(&account, &key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_kv_get_all() -> Result<Vec<(String, String, String)>, String> {
    open_db()?.kv_get_all().map_err(|e| e.to_string())
}

#[tauri::command]
fn db_kv_set_all(entries: Vec<(String, String, String)>) -> Result<(), String> {
    open_db()?.kv_set_all(&entries).map_err(|e| e.to_string())
}

// --- Backup: полный экспорт состояния — ключи + kv_store.
// JSON можно сохранить в файл и восстановить на другом устройстве/после
// переустановки.
#[tauri::command]
fn export_backup() -> Result<String, String> {
    let keys = key_store::export_keys().map_err(|e| e.to_string())?;
    let kv = open_db()?.kv_get_all().map_err(|e| e.to_string())?;
    let backup = serde_json::json!({
        "version": 1,
        "type": "vault-backup",
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "keys": serde_json::from_str::<serde_json::Value>(&keys).unwrap_or(serde_json::json!({})),
        "kv_store": kv,
    });
    Ok(serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?)
}

#[tauri::command]
fn import_backup(json_data: String) -> Result<String, String> {
    let data: serde_json::Value = serde_json::from_str(&json_data).map_err(|e| e.to_string())?;
    let mut restored = Vec::new();
    // 1. Ключи (keypair + peer_keys) — через существующий import_keys.
    if let Some(keys) = data.get("keys") {
        let meta = key_store::import_keys(&keys.to_string()).map_err(|e| e.to_string())?;
        restored.push(format!("keys: {}", meta.key_count));
    }
    // 2. kv_store — полная замена (профили, пометки, курсоры, кэши).
    if let Some(kv) = data.get("kv_store").and_then(|v| v.as_array()) {
        let entries: Vec<(String, String, String)> = kv
            .iter()
            .filter_map(|row| {
                let a = row.get(0)?.as_str()?.to_string();
                let k = row.get(1)?.as_str()?.to_string();
                let v = row.get(2)?.as_str()?.to_string();
                Some((a, k, v))
            })
            .collect();
        open_db()?.kv_set_all(&entries).map_err(|e| e.to_string())?;
        restored.push(format!("kv_store: {}", entries.len()));
    }
    Ok(restored.join(", "))
}

// --- Key Recovery: мнемоника 12 слов обёртывает backup.
// Генерация мнемоники (показывается пользователю один раз).
#[tauri::command]
fn recovery_generate_mnemonic() -> Result<String, String> {
    key_escrow::generate_mnemonic()
}

// Проверка введённых слов (валидация контрольной суммы, до расшифровки).
#[tauri::command]
fn recovery_validate_mnemonic(mnemonic: String) -> Result<bool, String> {
    key_escrow::validate_mnemonic(&mnemonic).map(|_| true)
}

// Обернуть ТЕКУЩИЙ backup словами → JSON WrappedBackup (уходит в эскроу-письмо).
#[tauri::command]
fn recovery_wrap_backup(mnemonic: String) -> Result<String, String> {
    let backup = export_backup()?;
    let wrapped = key_escrow::wrap_backup(&backup, &mnemonic)?;
    serde_json::to_string(&wrapped).map_err(|e| e.to_string())
}

// Распаковать WrappedBackup словами → строка backup-JSON (для import_backup).
#[tauri::command]
fn recovery_unwrap_backup(wrapped_json: String, mnemonic: String) -> Result<String, String> {
    let wrapped: key_escrow::WrappedBackup =
        serde_json::from_str(&wrapped_json).map_err(|e| e.to_string())?;
    key_escrow::unwrap_backup(&wrapped, &mnemonic)
}

/// Эскроу-письмо: сохранить/прочитать локальную «метку» о том, что эскроу
/// отправлен (kv_store), и сформировать тело письма.
#[tauri::command]
fn recovery_build_escrow_email(wrapped_json: String) -> Result<String, String> {
    // Тело письма — сам wrapped JSON. Пустая тема, без X-Vault-* заголовков:
    // письмо ищется по содержимому (парс конверта), стелс соблюдён.
    let w: serde_json::Value = serde_json::from_str(&wrapped_json).map_err(|e| e.to_string())?;
    let envelope = serde_json::json!({
        "vault": 1,
        "type": "key_escrow",
        "ts": chrono::Utc::now().timestamp(),
        "payload": w,
    });
    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

/// Разобрать тело письма в WrappedBackup, если это эскроу-конверт.
#[tauri::command]
fn recovery_parse_escrow_email(body: String) -> Result<Option<String>, String> {
    // fold_lines при отправке рвёт длинные строки на ~76 символов ЖЁСТКИМИ
    // переносами ВНУТРИ JSON (base64 wrapped разорван). decode_quoted_printable
    // восстанавливает только мягкие переносы (=). Поэтому перед парсингом
    // убираем ВСЕ CR/LF — JSON соберётся обратно в одну строку.
    let cleaned: String = body.chars().filter(|c| *c != '\n' && *c != '\r').collect();
    let trimmed = cleaned.trim();
    if !trimmed.contains("\"key_escrow\"") {
        return Ok(None);
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(v) => {
            if v.get("vault").and_then(|x| x.as_i64()) == Some(1)
                && v.get("type").and_then(|x| x.as_str()) == Some("key_escrow")
            {
                let payload = v.get("payload").cloned().unwrap_or(serde_json::Value::Null);
                return Ok(Some(
                    serde_json::to_string(&payload).map_err(|e| e.to_string())?,
                ));
            }
            Ok(None)
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn db_emails_save(account: String, emails_json: String) -> Result<(), String> {
    open_db()?
        .save_emails(&account, &emails_json)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn db_emails_load(account: String) -> Result<Vec<storage::sqlite::EmailRow>, String> {
    let rows = open_db()?
        .load_emails(&account)
        .map_err(|e| e.to_string())?;
    eprintln!("[db_emails_load] account={account} rows={}", rows.len());
    Ok(rows)
}

#[tauri::command]
fn db_emails_clear(account: String) -> Result<(), String> {
    open_db()?.clear_emails(&account).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // RUST_LOG: без инициализации лога error!/debug! из webrtc/rtc
    // не видны — ICE-gathering падал молча («ICE gathering timed out»).
    let rust_log = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());
    if std::env::var("VAULT_LOG_INIT").is_err() {
        std::env::set_var("VAULT_LOG_INIT", "1");
        let _ = env_logger::Builder::new()
            .filter_level(log::LevelFilter::Info)
            .parse_filters(&rust_log)
            .try_init();
        // Android Rust-логи → logcat.
        #[cfg(target_os = "android")]
        let _ = android_logger::init_once(
            android_logger::Config::default()
                .with_max_level(log::LevelFilter::Debug)
                .with_tag("VaultRust"),
        );
    }
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(feature = "barcode-scanner")]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    }
    builder
        .manage(CryptoState::default())
        .manage(EmailState::default())
        .manage(IdleMonitor::default())
        .manage(tokio::sync::Mutex::new(media::CallMediaManager::new()))
        .invoke_handler(tauri::generate_handler![
            generate_keypair,
            encrypt_message,
            decrypt_message,
            encrypt_vault_message,
            decrypt_vault_message,
            set_app_icon,
            get_fingerprint,
            save_my_keypair,
            load_my_keypair,
            save_peer_key,
            load_peer_keys,
            remove_peer_key,
            export_keys,
            import_keys,
            get_key_store_metadata,
            delete_all_keys,
            set_close_to_tray,
            get_close_to_tray,
            save_credentials,
            load_credentials,
            delete_credentials,
            encrypt_symmetric,
            decrypt_symmetric,
            email_connect,
            email_fetch_messages,
            email_fetch_incremental,
            email_fetch_incremental_fast,
            email_fetch_body,
            email_fetch_bodies,
            email_copy_to_inbox,
            email_idle_wait,
            email_idle_start,
            email_idle_stop,
            email_send,
            recovery_generate_mnemonic,
            recovery_validate_mnemonic,
            recovery_wrap_backup,
            recovery_unwrap_backup,
            recovery_build_escrow_email,
            recovery_parse_escrow_email,
            email_disconnect,
            groups_load,
            groups_create,
            groups_add_member,
            groups_rename_member,
            groups_save_member_fingerprints,
            android_open_url,
            duress_get_config,
            duress_hash_secret,
            duress_verify,
            duress_save_config,
            duress_wipe_all,
            groups_remove_member,
            groups_set_member_role,
            groups_leave,
            groups_get,
            groups_import,
            groups_set_key,
            groups_delete,
            groups_rename,
            db_history_save,
            db_history_load,
            db_history_clear,
            db_tombstone_add,
            db_tombstones_load,
            db_tombstones_clear,
            db_cursors_save,
            db_cursors_load,
            db_body_cache_set,
            db_body_cache_get,
            db_body_cache_clear,
            db_body_cache_load_all,
            db_autoclean_purge,
            check_app_update,
            debug_log,
            db_kv_set,
            db_kv_get,
            db_kv_delete,
            db_kv_get_all,
            db_kv_set_all,
            export_backup,
            import_backup,
            db_emails_save,
            db_emails_load,
            db_emails_clear,
            media::media_start_outgoing,
            media::media_accept_incoming,
            media::media_set_remote,
            media::media_close,
            media::media_set_muted,
            media::media_set_speaker,
            media::media_send_hangup,
            media::media_show_incoming_call,
            media::media_dismiss_incoming_call,
            media::media_set_ice_servers,
            // Рингтон входящего звонка (cpal, не webview — работает и со
            // свёрнутым окном; autoplay-политика WebKitGTK не мешает).
            media::media_ringtone_start,
            media::media_ringtone_stop,
            // Звуки звонка: WAV-ассеты через cpal (desktop) /
            // HTML5 Audio (Android, фронт сам).
            media::media_sound_play,
            media::media_sound_stop,
            // Фаза 3 перепроектирования звонков: JS сообщает решение
            // монитору-владельцу (call_state в monitor.db) — без него монитор
            // ставит missed поверх принятого звонка.
            #[cfg(target_os = "android")]
            service_monitor::call_report_state,
        ])
        .setup(|app| {
            // Mobile (Android/iOS): dirs::home_dir() returns None without a
            // $HOME env var, so all ~/.vault storage (keys, groups,
            // credentials) would fail with "Cannot determine home directory".
            // Point HOME at the app-private data dir once, before any command
            // (commands run after setup).
            #[cfg(mobile)]
            {
                if let Ok(dir) = app.path().app_data_dir() {
                    std::env::set_var("HOME", dir);
                }
            }

            // Try to get the default window icon from bundled resources
            let icon = if let Some(default_icon) = app.default_window_icon() {
                default_icon.clone()
            } else {
                // Fallback: embed icon directly
                let icon_bytes = include_bytes!("../icons/128x128.png");
                tauri::image::Image::from_bytes(icon_bytes).expect("Failed to parse bundled icon")
            };

            // Set window icon on Linux
            #[cfg(target_os = "linux")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.set_icon(icon.clone()).ok();
                }
            }

            // Set up system tray (desktop only — нет tray на Android/iOS)
            #[cfg(desktop)]
            let _tray_icon = tauri::tray::TrayIconBuilder::new()
                .tooltip("Vault - E2E Encrypted Messenger")
                .icon(icon)
                .build(app)?;

            // Linux: WebKitGTK по умолчанию отклоняет getUserMedia (микрофон) —
            // без явного обработчика разрешений голосовые сообщения не работают
            // ни у кого. Tauri/wry не подключают сигнал permission-request,
            // поэтому подключаем его напрямую к нативному WebView: разрешаем
            // захват аудио/видео (UserMediaPermissionRequest), остальное
            // оставляем дефолтному поведению (отклонение).
            #[cfg(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            ))]
            {
                use webkit2gtk::glib::prelude::ObjectExt;
                use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                if let Some(webview_window) = app.get_webview_window("main") {
                    let _ = webview_window.with_webview(|webview| {
                        let wk = webview.inner();
                        // Включаем медиа-захват в настройках WebKit
                        // (enable-media-stream по умолчанию выключен).
                        if let Some(settings) = wk.settings() {
                            settings.set_enable_media_stream(true);
                            settings.set_enable_mediasource(true);
                        }
                        // Собственно выдача разрешений.
                        wk.connect_permission_request(|_view, request| {
                            if request.is::<webkit2gtk::UserMediaPermissionRequest>() {
                                request.allow();
                                true // обработано
                            } else {
                                false // дефолт WebKit (отклонение)
                            }
                        });
                    });
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    // Duress-замок: окно уходит в трей, процесс живёт.
                    // Вебвью продолжает висеть «visible» — visibilitychange не
                    // сработает при возврате, и relock-флаг разблокировки не
                    // сбрасывался: замок не показывался при возврате из трея.
                    // Сигналим фронту ДО скрытия: фронт сбросит флаг сессии и
                    // поднимет LockScreen заранее — при показе окна замок уже
                    // на экране.
                    use tauri::Emitter;
                    let _ = window.emit("vault://window-hidden", ());
                    window.hide().unwrap();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
    // ОТКАТ prevent_exit: удержание раннера после ExitRequested
    // на Android оставляло живой процесс с УНИЧТОЖЕННОЙ activity —
    // повторный open пересоздавал activity, но wry не перепривязывал
    // поверхность WebView → чёрный экран до полного рестарта. Живучесть
    // процесса для пушей обеспечивает VaultForegroundService; уведомле-
}
