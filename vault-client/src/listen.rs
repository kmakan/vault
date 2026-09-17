//! Headless listener (M2 bots-1, t_58dcac71) — `vault --listen`.
//!
//! Бот-режим без REPL: коннект к ящику, поллинг INBOX + relay-poll,
//! расшифровка входящих, выдача событий в stdout (NDJSON), чтение ответов
//! из stdin (NDJSON). Wire-формат идентичен Desktop/REPL (тот же AAD-конверт).
//!
//! События наружу (stdout, по строке JSON):
//!   {"type":"ready","email":"..."}
//!   {"type":"msg","id":"<env id>","from":"user@x","text":"...","ts":<ms>}
//! Команды внутрь (stdin, по строке JSON):
//!   {"action":"send","to":"user@x","text":"...","reply_to":"<env id>"}
//!   {"action":"quit"}
//!
//! Автоонбординг: первое письмо от человека несёт его pubkey/pq/tok внутри
//! конверта — бот молча сохраняет контакт (паттерн Desktop contact-merge /
//! repl.rs "Relay: peer token learned") и может отвечать гибридом без QR.

use std::collections::HashSet;
use std::io::Write;

use anyhow::Result;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::api::client::Config;
use crate::api::email::{EmailClient, EmailConfig};
use crate::cli::commands::provider_hosts;
use crate::crypto::CryptoClient;
use crate::vault::contacts::Contact;
use crate::vault::relay::{self, RelayState};
use crate::vault::ContactBook;

/// Тик поллинга: 15с — relay-дубль читается каждый тик (мгновенно), письма
/// — фолбэк (30-60с). Переопределяется --listen-interval.
const POLL_SECS: u64 = 15;

pub async fn run(config: Config, interval_secs: u64) -> Result<()> {
    let email = config
        .email
        .clone()
        .filter(|e| !e.is_empty())
        .ok_or_else(|| anyhow::anyhow!("--listen requires -e <email>"))?;
    let password = std::env::var("VAULT_PASSWORD").unwrap_or_default();
    if password.is_empty() {
        anyhow::bail!("--listen requires VAULT_PASSWORD env");
    }
    let (imap_host, smtp_host, smtp_port) = provider_hosts(&email);

    let mut crypto = CryptoClient::new();
    if !crypto.load_keypair() {
        anyhow::bail!("--listen requires existing keys (~/.vault/keys) — run the REPL once (login) first");
    }
    let mut contact_book = ContactBook::load_default().unwrap_or_default();

    let mut relay_state = RelayState::load();
    if relay_state.enabled && relay_state.my_token.is_empty() {
        match relay::register(&crypto.fingerprint()) {
            Ok(tok) => {
                relay_state.my_token = tok;
                let _ = relay_state.save();
            }
            Err(e) => tracing::warn!("relay register failed (email-only mode): {e}"),
        }
    }

    let mut client = EmailClient::new(EmailConfig {
        imap_server: config
            .server
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| imap_host.to_string()),
        smtp_server: smtp_host.to_string(),
        smtp_port,
        email: email.clone(),
        password,
        ..Default::default()
    });
    client.connect_imap().await?;

    // Durable dedup: переживает рестарты (аналог update-offset у Telegram-ботов)
    // — иначе после перезапуска бот перечитает весь UNSEEN-бэклог и ответит на
    // старые сообщения заново.
    let seen_file = dirs::home_dir()
        .map(|h| h.join(".vault/listen_seen.json"))
        .unwrap_or_else(|| std::path::PathBuf::from(".vault/listen_seen.json"));
    let mut seen: HashSet<String> = std::fs::read_to_string(&seen_file)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .collect();
    let mut seen_order: Vec<String> = seen.iter().cloned().collect();

    let mut out = std::io::stdout();
    emit(&mut out, &serde_json::json!({"type":"ready","email":email}));

    let (cmdtx, mut cmdrx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    tracing::debug!("stdin line: {} bytes", line.len());
                    let line = line.trim().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(v) => {
                            if cmdtx.send(v).is_err() {
                                return;
                            }
                        }
                        Err(e) => tracing::warn!("bad stdin command: {e}"),
                    }
                }
                Ok(None) => {
                    // stdin закрыт (мост умер) — корректно завершаемся
                    let _ = cmdtx.send(serde_json::json!({"action":"quit"}));
                    return;
                }
                Err(e) => {
                    tracing::warn!("stdin read error: {e}");
                    return;
                }
            }
        }
    });

    let interval = tokio::time::Duration::from_secs(interval_secs.max(5));
    loop {
        tokio::select! {
            Some(cmd) = cmdrx.recv() => {
                if cmd.get("action").and_then(|v| v.as_str()) == Some("quit") {
                    return Ok(());
                }
                handle_command(&cmd, &mut crypto, &contact_book, &mut client, &mut relay_state).await;
            }
            _ = tokio::time::sleep(interval) => {
                tick(&mut client, &mut crypto, &mut contact_book, &relay_state, &mut seen, &mut seen_order, &mut out, &email).await;
                // Дедуп на диске: переживаем рестарты без переотправки на бэклог.
                if let Some(dir) = seen_file.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                let _ = std::fs::write(&seen_file, serde_json::to_string(&seen_order).unwrap_or_default());
            }
        }
    }
}

/// Папки входящих для --listen больше не хардкодятся: mail.ru кладёт
/// From==To в INBOX/ToMyself, и хардкод падал с NONEXISTENT. Реальные
/// имена ищет EmailClient::inbox_folders (логика — как у Desktop).

/// Один цикл: письма + relay-очередь → дедуп → декод → события msg.
async fn tick(
    client: &mut EmailClient,
    crypto: &mut CryptoClient,
    contact_book: &mut ContactBook,
    relay_state: &RelayState,
    seen: &mut HashSet<String>,
    seen_order: &mut Vec<String>,
    out: &mut std::io::Stdout,
    me: &str,
) {
    let mut messages = Vec::new();
    let mut folder_of: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let folders = client.inbox_folders().await;
    tracing::debug!("listen: scanning folders: {:?}", folders);
    for folder in &folders {
        match client.fetch_messages_with_prefix(folder, 512).await {
            Ok(ms) => {
                tracing::debug!("listen: {folder} fetched {} msg(s)", ms.len());
                for m in &ms {
                    folder_of.insert(m.id.clone(), folder.to_string());
                }
                messages.extend(ms);
            }
            // Пустой ящик без Junk/ToMyself — не ошибка, просто тихо мимо;
            // отказ INBOX — видно (warn).
            Err(e) => {
                if folder == "INBOX" {
                    tracing::warn!("listen: INBOX fetch failed: {e}");
                } else {
                    tracing::debug!("listen: fetch {folder} skipped: {e}");
                }
            }
        }
    }
    // Relay — мгновенный канал (destructive-поллинг, как /inbox REPL).
    if relay_state.enabled && !relay_state.my_token.is_empty() {
        if let Ok(envs) = relay::poll(&relay_state.my_token) {
            for env in envs {
                messages.push(crate::api::email::EmailMessage {
                    id: format!("rl-{}", env.id),
                    from: env.from,
                    to: me.to_string(),
                    subject: String::new(),
                    body: env.body,
                    date: String::new(),
                    is_read: false,
                });
            }
        }
    }

    let mut contacts_dirty = false;
    tracing::debug!("listen: tick: {} message(s) to process", messages.len());
    for m in &messages {
        // Безусловный след каждого письма: ветки ошибок ниже логируются, а
        // успешный путь (Ok(Some) → dedup → emit) был молчаливым — из-за этого
        // «пропавшие» uid (напр. 674) выглядели как молча пропущенные.
        tracing::debug!(
            "listen-proc: uid={} from={} folder={} body_len={}",
            m.id,
            m.from,
            folder_of.get(&m.id).map(|s| s.as_str()).unwrap_or("-"),
            m.body.len()
        );
        if !crypto.is_encrypted(&m.body) {
            // стелс: чужие/служебные письма молча мимо
            tracing::debug!(
                "listen-skip: uid={} from={} body_len={} (not encrypted)",
                m.id,
                m.from,
                m.body.len()
            );
            continue;
        }
        // peer-ключ отправителя — для PQ-ветки decrypt_vault (как /read).
        let contact = contact_book.get(&m.from);
        if let Some(c) = contact {
            if !c.public_key.is_empty() {
                let _ = crypto.set_peer_key_pq(&c.public_key, c.pq_public_key.as_deref());
            }
        }
            let mut decrypted = decrypt_envelope(crypto, &m.body);
        if matches!(&decrypted, Ok(None) | Err(_)) {
            // Полный фетч по uid (BODY.PEEK[TEXT]<0.512> режет PQ1 >1КБ).
            let folder = folder_of.get(&m.id).map(|s| s.as_str()).unwrap_or("INBOX");
            if let Ok(full) = client.fetch_message_body(&m.id, folder).await {
                decrypted = decrypt_envelope(crypto, &full);
            }
        }
        if let Err(reason) = &decrypted {
            if m.id.starts_with("rl-") {
                // relay-конверты не ретраятся (destructive poll), поэтому
                // единственный способ увидеть причину провала — залогировать.
                tracing::warn!("rl-{} from={} decrypt failed: {}", m.id, m.from, reason);
            } else {
                // retry каждый тик (контакт/ключ могли появиться позже) — debug,
                // не warn: чужие письма давали бы шквал повторов.
                tracing::debug!(
                    "uid={} from={} decrypt deferred: {}",
                    m.id, m.from, reason
                );
            }
        }
        let Ok(Some((id, value))) = decrypted else {
            tracing::debug!(
                "listen: uid={} from={} skipped after decrypt (no vault/text)",
                m.id,
                m.from
            );
            continue;
        };
        // Успешная расшифровка раньше не логировалась вообще — теперь видно
        // и env-id, и есть ли в конверте поле text (receipt'ы его не несут).
        tracing::debug!(
            "listen-decrypted: uid={} from={} env_id={} has_text={} keys={:?}",
            m.id,
            m.from,
            id,
            value.get("text").is_some(),
            value
                .as_object()
                .map(|o| o.keys().collect::<Vec<_>>())
                .unwrap_or_default()
        );
        // Дедуп кросс-канальный: env.id первичен (релей+почта = одно событие).
        let key = if id.is_empty() {
            format!("uid:{}", m.id)
        } else {
            format!("env:{id}")
        };
        if !seen.insert(key.clone()) {
            tracing::debug!(
                "listen-dedup: uid={} from={} key={} already seen — skip without emit",
                m.id,
                m.from,
                key
            );
            continue;
        }
        seen_order.push(key);
        if seen_order.len() > 5000 {
            let drop = seen_order.drain(..2500).collect::<Vec<_>>();
            for k in drop {
                seen.remove(&k);
            }
        }
        let text = match value.get("text").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => {
                tracing::debug!(
                    "listen-skip: uid={} from={} env_id={} has no \"text\" field (service envelope)",
                    m.id,
                    m.from,
                    id
                );
                continue; // служебные (receipt/edit/react/call) боту в MVP не нужны
            }
        };
        // Автоонбординг: конверт несёт pubkey/pq/tok отправителя — сохраняем.
        if let Some(peer_key) = value.get("key").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            let pq = value.get("pq").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            let tok = value.get("tok").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            let mut c = contact_book
                .get(&m.from)
                .cloned()
                .unwrap_or_else(|| Contact::new(&m.from, "", peer_key));
            c.public_key = peer_key.to_string();
            if pq.is_some() {
                c.pq_public_key = pq.map(|s| s.to_string());
            }
            contact_book.add(c);
            contacts_dirty = true;
            if let Some(tok) = tok {
                // relay.peers — state, но пишем в файл релея (тот же ключ lowercase)
                let mut r = RelayState::load();
                let lc = m.from.to_lowercase();
                if r.peers.get(&lc) != Some(&tok.to_string()) {
                    r.peers.insert(lc, tok.to_string());
                    let _ = r.save();
                }
            }
        }
        // Self-копии (mail.ru складывает From==To в INBOX/ToMyself) —
        // это исходящий трафик самого аккаунта. Без фильтра бот отвечает
        // на свои же ответы → бесконечная петля.
        if m.from.eq_ignore_ascii_case(me) {
            tracing::debug!(
                "listen-skip: uid={} env_id={} self-copy from={} (ToMyself self-loop guard)",
                m.id,
                id,
                m.from
            );
            continue;
        }
        tracing::debug!(
            "listen-emit: uid={} env_id={} from={} chars={}",
            m.id,
            id,
            m.from,
            text.chars().count()
        );
        emit(
            out,
            &serde_json::json!({
                "type": "msg",
                "id": id,
                "from": m.from,
                "text": text,
                "ts": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            }),
        );
    }
    if contacts_dirty {
        let _ = contact_book.save_default();
    }
}

/// Расшифровать vault-конверт и разобрать JSON. Ok(None) — не наш/битый
/// (чужое письмо); Err — почему не расшифровалось (для deferred-диагностики).
fn decrypt_envelope(crypto: &CryptoClient, body: &str) -> anyhow::Result<Option<(String, Value)>> {
    let plain = match crypto.decrypt_vault(body) {
        Ok(p) => p,
        Err(e) => {
            let kind = if body.trim_start().starts_with("PQ1:") { "pq1" } else { "legacy" };
            anyhow::bail!("{kind}: {e:#}");
        }
    };
    let value: Option<Value> = serde_json::from_str(&plain).ok();
    match value {
        Some(value) if value.get("vault").and_then(|v| v.as_i64()) == Some(1) => {
            let id = value.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(Some((id, value)))
        }
        _ => {
            tracing::debug!(
                "listen: envelope decrypted but unrecognized: {}",
                plain.chars().take(120).collect::<String>()
            );
            Ok(None)
        }
    }
}

/// Команда send из stdin: E2E на pubkey контакта (гибрид PQ если есть) +
/// письмо (stealth, пустая тема) + relay-дубль.
async fn handle_command(
    cmd: &Value,
    crypto: &mut CryptoClient,
    contact_book: &ContactBook,
    client: &mut EmailClient,
    relay_state: &mut RelayState,
) {
    let Some(to) = cmd.get("to").and_then(|v| v.as_str()) else {
        tracing::warn!("send without to");
        return;
    };
    let text = cmd.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let Some(contact) = contact_book.get(to) else {
        tracing::warn!("send to unknown contact {to}");
        return;
    };
    if contact.public_key.is_empty() {
        tracing::warn!("no pubkey for {to}");
        return;
    }
    if let Err(e) = crypto.set_peer_key_pq(&contact.public_key, contact.pq_public_key.as_deref()) {
        tracing::warn!("set peer key failed: {e}");
        return;
    }
    let envelope = serde_json::json!({
        "vault": 1,
        "id": uuid::Uuid::new_v4().to_string(),
        "text": text,
        "reply_to": cmd.get("reply_to").and_then(|v| v.as_str()).unwrap_or(""),
        "name": cmd.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "avatar": "",
        "key": crypto.public_key_hex().unwrap_or_default(),
        "pq": crypto.pq_ek_b64.clone().unwrap_or_default(),
        "tok": relay_state.my_token.clone(),
        "ts": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    });
    let encrypted = match crypto.encrypt_vault(&envelope.to_string()) {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("encrypt failed: {e}");
            return;
        }
    };
    if let Err(e) = client.send_email(to, "", &encrypted).await {
        tracing::warn!("smtp to {to} failed: {e}");
        return; // relay без письма не шлём: email — источник истины
    }
    let env_id = envelope.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let from = cmd.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let _ = relay::publish(relay_state, to, &env_id, &encrypted, &from, &crypto.fingerprint());
}

fn emit(out: &mut std::io::Stdout, v: &Value) {
    // stdout — пайп в bridge.py. Раньше ошибки записи глотались (`let _ =`),
    // а ключ дедупа уже лежал в seen: сломанный/закрытый пайп = безвозвратная
    // потеря события, без единой строки в логе.
    if writeln!(out, "{v}").is_err() {
        tracing::warn!(
            "emit: stdout write failed (bridge pipe closed?) — event lost: {:?}",
            v.get("type")
        );
        return;
    }
    if out.flush().is_err() {
        tracing::warn!(
            "emit: stdout flush failed (bridge pipe broken?) — event lost: {:?}",
            v.get("type")
        );
    }
}
