// Email transport (IMAP/SMTP) for the serverless Vault desktop client.
//
// Desktop talks to the mailbox directly over IMAP/SMTP instead of going through
// the backend API (localhost:9443). Mirrors the verified vault-client email.rs
// (which passed e2e tests against real Gmail), carrying over the two critical
// fixes:
//   1. fold_lines() — fold long lines to ≤76 columns before sending, otherwise
//      Gmail's spam filter flags the message.
//   2. decode_quoted_printable() — SMTP relays (Gmail included) may re-encode
//      the Vault encrypted base64 block as quoted-printable; decode it on read
//      so the base64 block doesn't break on provider line wraps.
//
// Only transport lives here — crypto (X25519/XChaCha20) is handled by the
// already-registered Tauri crypto commands.

use anyhow::{Context, Result};
use imap::Session;
use std::collections::{HashMap, HashSet};
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::message::Message;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use native_tls::{TlsConnector, TlsStream};
use serde::{Deserialize, Serialize};
use std::net::TcpStream;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailConfig {
    pub email: String,
    pub password: String,
    pub imap_server: String,
    pub imap_port: u16,
    pub smtp_server: String,
    pub smtp_port: u16,
}

impl Default for EmailConfig {
    fn default() -> Self {
        Self {
            imap_server: "imap.gmail.com".to_string(),
            imap_port: 993,
            smtp_server: "smtp.gmail.com".to_string(),
            smtp_port: 587,
            email: String::new(),
            password: String::new(),
        }
    }
}

/// A message summary. Body is intentionally NOT included in the list — it is
/// heavy. Fetch it on demand via `fetch_message_body(uid, folder)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailMessage {
    pub id: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub date: String,
    pub is_read: bool,
    /// Mailbox the message lives in ("INBOX" or the Junk folder name) — needed
    /// because UIDs are per-folder, so fetching the body requires re-selecting
    /// the same folder. Gmail's spam filter routes Vault's encrypted mails to
    /// Junk; without this the desktop would silently miss them (CLI already
    /// searches Junk — see vault-client email.rs).
    #[serde(default = "default_inbox")]
    pub folder: String,
    /// RFC 5322 Message-ID — для дедупликации одного и того же письма из
    /// разных папок (у Gmail письмо лежит и в INBOX/Junk, и в All Mail под
    /// разными UID). Пусто, если заголовок отсутствует.
    #[serde(default)]
    pub message_id: String,
}

fn default_inbox() -> String {
    "INBOX".to_string()
}

/// Специальные папки, найденные одним LIST-запросом.
#[derive(Debug, Default)]
struct SpecialFolders {
    /// «Вся почта» (\All) — есть у Gmail, отсутствует у Zoho/Mail.ru/Yandex.
    all: Option<String>,
    /// Спам (\Junk/\Spam или папка с именем Spam/Junk/Спам).
    junk: Option<String>,
    /// Отправленные (\Sent) — нужны провайдерам БЕЗ \All (Zoho и др.):
    /// только там лежат копии наших исходящих писем (отправитель должен
    /// видеть свои сообщения в чате).
    sent: Option<String>,
}

pub struct EmailClient {
    config: EmailConfig,
    imap_session: Option<Session<TlsStream<TcpStream>>>,
}

impl EmailClient {
    pub fn new(config: EmailConfig) -> Self {
        Self {
            config,
            imap_session: None,
        }
    }

    /// Establish a TLS IMAP connection and log in. The session is kept alive in
    /// state so subsequent commands reuse it.
    pub async fn connect_imap(&mut self) -> Result<()> {
        let tls = TlsConnector::builder()
            .build()
            .context("Failed to create TLS connector")?;

        // Ручное соединение вместо imap::connect(): imap::connect() внутри себя
        // делает TcpStream::connect + TLS handshake, но НЕ ставит таймаут на
        // чтение/запись. BufStream-обёртка imap-крейта читает блокирующим
        // read() — при зависшем/заторможенном сервере (троттлинг Gmail,
        // рассинхрон сессии) вызов висит ВЕЧНО, окно перестаёт отвечать на
        // всё (это и была «поломка» 18.08). Таймаут read/write 30 с даёт
        // Err, который существующий reconnect-путь уже умеет обрабатывать.
        let tcp: TcpStream = TcpStream::connect((
            self.config.imap_server.as_str(),
            self.config.imap_port,
        ))
        .context("Failed to connect to IMAP server")?;
        let timeout = std::time::Duration::from_secs(30);
        tcp.set_read_timeout(Some(timeout))
            .context("Failed to set read timeout")?;
        tcp.set_write_timeout(Some(timeout))
            .context("Failed to set write timeout")?;
        let ssl_stream = tls
            .connect(&self.config.imap_server, tcp)
            .context("Failed TLS handshake")?;

        let client = imap::Client::new(ssl_stream);
        let session = client
            .login(&self.config.email, &self.config.password)
            .map_err(|e| anyhow::anyhow!("IMAP login failed: {}", e.0))?;

        self.imap_session = Some(session);
        Ok(())
    }

    /// Один LIST-запрос вместо трёх: находим специальные папки за один
    /// round-trip. Gmail локализует имена («Вся почта», «Спам»), поэтому
    /// спам ищем сначала по атрибуту (\Junk/\Spam), потом по имени папки.
    /// \All — опционально (есть у Gmail, нет у Zoho/Mail.ru/Yandex).
    fn find_special_folders(&mut self) -> SpecialFolders {
        let mut out = SpecialFolders::default();
        let session = match self.imap_session.as_mut() {
            Some(s) => s,
            None => return out,
        };
        let list = match session.list(None, Some("*")) {
            Ok(l) => l,
            Err(_) => return out,
        };
        for item in list.iter() {
            let name = item.name();
            if name.is_empty() {
                continue;
            }
            let attrs: Vec<String> = item
                .attributes()
                .iter()
                .filter_map(|a| {
                    if let imap::types::NameAttribute::Custom(s) = a {
                        Some(s.to_ascii_lowercase())
                    } else {
                        None
                    }
                })
                .collect();
            let name_l = name.to_ascii_lowercase();
            if out.all.is_none() && attrs.iter().any(|a| a == "\\all") {
                out.all = Some(name.to_string());
            }
            if out.junk.is_none()
                && attrs.iter().any(|a| a == "\\junk" || a == "\\spam")
            {
                out.junk = Some(name.to_string());
            }
            if out.sent.is_none() && attrs.iter().any(|a| a == "\\sent") {
                out.sent = Some(name.to_string());
            }
            // Фолбэк по имени — для провайдеров без атрибутов (Spam, Junk,
            // «Спам», [Gmail]/Spam). Берём только если атрибут не нашёлся.
            if out.junk.is_none()
                && (name_l == "spam"
                    || name_l == "junk"
                    || name_l == "спам"
                    || name_l.ends_with("/spam")
                    || name_l.ends_with("/junk"))
            {
                out.junk = Some(name.to_string());
            }
            if out.sent.is_none()
                && (name_l == "sent"
                    || name_l == "sent items"
                    || name_l == "sent messages"
                    || name_l.ends_with("/sent"))
            {
                out.sent = Some(name.to_string());
            }
        }
        out
    }

    /// Fetch the most recent `limit` messages from one mailbox, newest first.
    fn fetch_folder(
        &mut self,
        folder: &str,
        limit: usize,
    ) -> Result<Vec<EmailMessage>> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.select(folder)?;

        let message_ids = session.uid_search("ALL")?;
        let mut messages = Vec::new();

        let mut uids: Vec<u32> = message_ids.iter().copied().collect();
        uids.sort_by(|a, b| b.cmp(a));
        uids.truncate(limit);

        // Один round-trip вместо поштучных uid_fetch: на ящике с тысячами
        // писем последовательные запросы занимали минуты, и поллинг/клик
        // по чату «зависали» (а то и умирали по таймауту).
        // Ошибка батч-фетча пробрасывается наверх (НЕ молчаливый пустой
        // список): lib.rs трактует Err как «reconnect + retry». Раньше
        // if-let-Ok глотал ошибку, и приложение молча видело пустой ящик.
        if !uids.is_empty() {
            let uid_set = uids
                .iter()
                .map(|u| u.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let data = session
                .uid_fetch(&uid_set, "(UID FLAGS RFC822.HEADER)")
                .with_context(|| format!("UID FETCH failed in folder {folder}"))?;
            for fetch in data.iter() {
                let uid = fetch.uid.unwrap_or_default().to_string();
                let flags = fetch.flags();
                let is_read = flags.iter().any(|f| matches!(f, imap::types::Flag::Seen));

                if let Some(header) = fetch.header() {
                    let header_str = String::from_utf8_lossy(header);
                    let from = extract_header(&header_str, "From:")
                        .unwrap_or_else(|| "Unknown".to_string());
                    let to = extract_header(&header_str, "To:")
                        .unwrap_or_else(|| "Unknown".to_string());
                    let subject = extract_header(&header_str, "Subject:")
                        .unwrap_or_else(|| "(no subject)".to_string());
                    let date = extract_header(&header_str, "Date:")
                        .unwrap_or_else(|| "Unknown".to_string());
                    let message_id = extract_header(&header_str, "Message-ID:")
                        .unwrap_or_default();

                    messages.push(EmailMessage {
                        id: uid,
                        from,
                        to,
                        subject,
                        date,
                        is_read,
                        folder: folder.to_string(),
                        message_id,
                    });
                }
            }
        }

        messages.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(messages)
    }

    /// Переустановить IMAP-соединение (сервер оборвал его — idle-таймаут,
    /// сетевой сбой). Конфиг уже хранится в клиенте, поэтому можно просто
    /// заново подключиться без участия UI.
    pub async fn reconnect_imap(&mut self) -> Result<()> {
        if let Some(mut session) = self.imap_session.take() {
            let _ = session.logout();
        }
        self.connect_imap().await
    }

    /// Fetch recent messages. Стратегия выбора папок (не все провайдеры
    /// имеют «Вся почта»/\All):
    ///   1. INBOX — всегда явно (основной источник входящих).
    ///   2. Спам — всегда: Gmail кладёт шифрописьма в Junk, а у провайдеров
    ///      без \All это единственный шанс их увидеть.
    ///   3. \All (если есть, Gmail) — как дополнительный источник: там видны
    ///      и отправленные нами письма (вторая сторона 1:1-чата). Дедупликация
    ///      по Message-ID, т.к. у Gmail одно письмо лежит в INBOX и All Mail
    ///      под разными UID.
    pub async fn fetch_messages(&mut self) -> Result<Vec<EmailMessage>> {
        let folders = self.find_special_folders();

        let mut messages = self.fetch_folder("INBOX", 250)?;
        let mut seen: HashSet<String> = messages
            .iter()
            .filter(|m| !m.message_id.is_empty())
            .map(|m| m.message_id.clone())
            .collect();

        if let Some(junk) = &folders.junk {
            match self.fetch_folder(junk, 150) {
                Ok(junk_msgs) => {
                    for m in junk_msgs {
                        if !m.message_id.is_empty() && !seen.insert(m.message_id.clone()) {
                            continue;
                        }
                        messages.push(m);
                    }
                }
                // Папка спама может отсутствовать/быть недоступной — это не
                // повод ронять весь фетч: INBOX уже получен.
                Err(e) => eprintln!("[email] junk folder {junk} fetch failed: {e}"),
            }
        }

        if let Some(all) = &folders.all {
            match self.fetch_folder(all, 250) {
                Ok(all_msgs) => {
                    for m in all_msgs {
                        if !m.message_id.is_empty() && !seen.insert(m.message_id.clone()) {
                            continue;
                        }
                        messages.push(m);
                    }
                }
                Err(e) => eprintln!("[email] All Mail folder {all} fetch failed: {e}"),
            }
        } else if let Some(sent) = &folders.sent {
            // Нет \All (Zoho и др.): копии наших исходящих лежат ТОЛЬКО в Sent.
            // Без него отправитель не видит свои сообщения, а поллинг
            // затирает оптимистичный показ. С \All Sent избыточен (All Mail
            // уже содержит исходящие) — не тратим round-trip.
            match self.fetch_folder(sent, 150) {
                Ok(sent_msgs) => {
                    for m in sent_msgs {
                        if !m.message_id.is_empty() && !seen.insert(m.message_id.clone()) {
                            continue;
                        }
                        messages.push(m);
                    }
                }
                Err(e) => eprintln!("[email] Sent folder {sent} fetch failed: {e}"),
            }
        }

        // Вернуть сессию в INBOX — последующие вызовы ожидают её выбранной.
        let _ = self.imap_session.as_mut().map(|s| s.select("INBOX"));
        Ok(messages)
    }

    /// Fetch messages in one mailbox: either the most recent `limit`
    /// (first sync, no cursor) or everything with UID > `last_uid`
    /// (incremental poll). Returns the messages and the new high-water mark
    /// (max UID actually seen in this folder).
    fn fetch_folder_from(
        &mut self,
        folder: &str,
        last_uid: Option<u32>,
        limit: usize,
    ) -> Result<(Vec<EmailMessage>, u32)> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        session.select(folder)?;

        let uid_list = match last_uid {
            None => session.uid_search("ALL")?,
            Some(last) => session.uid_search(&format!("UID {}:*", last + 1))?,
        };
        let mut uids: Vec<u32> = uid_list.iter().copied().collect();
        let max_uid = uids.iter().copied().max().unwrap_or(0);
        uids.sort_by(|a, b| b.cmp(a));
        if last_uid.is_none() {
            uids.truncate(limit);
        }

        let mut messages = Vec::new();
        if !uids.is_empty() {
            let uid_set = uids
                .iter()
                .map(|u| u.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let data = session
                .uid_fetch(&uid_set, "(UID FLAGS RFC822.HEADER)")
                .with_context(|| format!("UID FETCH failed in folder {folder}"))?;
            for fetch in data.iter() {
                let uid = fetch.uid.unwrap_or_default().to_string();
                let flags = fetch.flags();
                let is_read = flags.iter().any(|f| matches!(f, imap::types::Flag::Seen));
                if let Some(header) = fetch.header() {
                    let header_str = String::from_utf8_lossy(header);
                    messages.push(EmailMessage {
                        id: uid,
                        from: extract_header(&header_str, "From:")
                            .unwrap_or_else(|| "Unknown".to_string()),
                        to: extract_header(&header_str, "To:")
                            .unwrap_or_else(|| "Unknown".to_string()),
                        subject: extract_header(&header_str, "Subject:")
                            .unwrap_or_else(|| "(no subject)".to_string()),
                        date: extract_header(&header_str, "Date:")
                            .unwrap_or_else(|| "Unknown".to_string()),
                        is_read,
                        folder: folder.to_string(),
                        message_id: extract_header(&header_str, "Message-ID:").unwrap_or_default(),
                    });
                }
            }
        }

        messages.sort_by(|a, b| b.id.cmp(&a.id));
        Ok((messages, max_uid))
    }

    /// Incremental fetch: only messages NEWER than the per-folder UID cursors,
    /// then advance the cursors. First sync (empty cursors) does a full scan
    /// of the recent folders (like fetch_messages) and seeds the cursors.
    /// Polling the mailbox every 30s with a full re-scan was both wasteful and
    /// a Gmail-throttling trigger; with cursors a quiet inbox costs one UID
    /// SEARCH per folder instead of re-fetching the last 50-100 envelopes.
    /// Returns (new_messages, updated_cursors).
    pub async fn fetch_newer(
        &mut self,
        cursors: &HashMap<String, u32>,
    ) -> Result<(Vec<EmailMessage>, HashMap<String, u32>)> {
        let folders = self.find_special_folders();
        let mut new_cursors = cursors.clone();
        let mut seen: HashSet<String> = HashSet::new();
        let mut messages: Vec<EmailMessage> = Vec::new();

        let mut collect =
            |folder: &str, fallback: &str, msgs: Vec<EmailMessage>, max_uid: u32| {
                // Пустой результат НЕ продвигает курсор: uid_search мог вернуть
                // пусто из-за троттлинга/рассинхрона сессии, и запись 0
                // «отравляла» папку — инкремент от 0 при следующих поллингах
                // тоже возвращал пусто (Zoho), чаты пустели навсегда (20.08).
                // Курсор движется только при реально полученных письмах.
                if max_uid > 0 {
                    new_cursors.insert(fallback.to_string(), max_uid);
                }
                if max_uid == 0 {
                    return; // empty folder — nothing new
                }
                for m in msgs {
                    if !m.message_id.is_empty() && !seen.insert(m.message_id.clone()) {
                        continue;
                    }
                    messages.push(m);
                }
            };

        // INBOX — всегда (основной источник входящих).
        match self
            .fetch_folder_from("INBOX", cursors.get("INBOX").copied(), 100)
        {
            Ok((msgs, max)) => collect("INBOX", "INBOX", msgs, max),
            Err(e) => eprintln!("[email] INBOX incremental fetch failed: {e}"),
        }

        // Спам — всегда: Gmail кладёт шифрописьма в Junk.
        if let Some(junk) = &folders.junk {
            match self
                .fetch_folder_from(junk, cursors.get(junk).copied(), 50)
            {
                Ok((msgs, max)) => collect(junk, junk, msgs, max),
                Err(e) => eprintln!("[email] Junk folder {junk} incremental fetch failed: {e}"),
            }
        }

        // \\All (Gmail) или Sent (Zoho и др., нет \\All) — исходящие копии.
        if let Some(all) = &folders.all {
            match self
                .fetch_folder_from(all, cursors.get(all).copied(), 100)
            {
                Ok((msgs, max)) => collect(all, all, msgs, max),
                Err(e) => eprintln!("[email] All Mail folder {all} incremental fetch failed: {e}"),
            }
        } else if let Some(sent) = &folders.sent {
            match self
                .fetch_folder_from(sent, cursors.get(sent).copied(), 50)
            {
                Ok((msgs, max)) => collect(sent, sent, msgs, max),
                Err(e) => eprintln!("[email] Sent folder {sent} incremental fetch failed: {e}"),
            }
        }

        // Вернуть сессию в INBOX — последующие вызовы ожидают её выбранной.
        let _ = self.imap_session.as_mut().map(|s| s.select("INBOX"));
        Ok((messages, new_cursors))
    }

    /// Fetch the body of a single message by UID, decoding quoted-printable so
    /// the Vault encrypted base64 block survives provider line wrapping.
    /// `folder` must match the mailbox the message lives in (UIDs are
    /// per-folder); defaults to INBOX.
    ///
    /// Returns Err (not Ok("")) when the body comes back empty: a desynced IMAP
    /// session can answer a UID FETCH with no literal, and the caller (lib.rs)
    /// treats Err as "reconnect + retry". Returning Ok("") used to poison the
    /// frontend body-cache permanently — invites/attachments/voice notes then
    /// rendered blank forever.
    pub async fn fetch_message_body(&mut self, uid: &str, folder: &str) -> Result<String> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        if folder != "INBOX" {
            let _ = session.select(folder);
        }

        let mut body = String::new();
        let fetch_res = session.uid_fetch(uid, "(RFC822.TEXT)");
        if let Ok(data) = fetch_res {
            for fetch in data.iter() {
                if let Some(text) = fetch.text() {
                    body = decode_quoted_printable(&String::from_utf8_lossy(text));
                    break;
                }
            }
        }

        // Вернуть сессию в INBOX.
        if folder != "INBOX" {
            let _ = session.select("INBOX");
        }

        if body.is_empty() {
            anyhow::bail!("Empty body for uid {uid} in {folder} (session desync?)");
        }
        Ok(body)
    }

    /// Fetch bodies of many messages from one mailbox in a batch: select the
    /// folder once, then UID FETCH each id. The UI previously fetched bodies
    /// one-by-one (each call re-selecting the folder) — dozens of round-trips
    /// made the chat look empty for a minute.
    pub async fn fetch_bodies(
        &mut self,
        uids: &[String],
        folder: &str,
    ) -> Result<Vec<(String, String)>> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        if folder != "INBOX" {
            let _ = session.select(folder);
        }

        let mut out = Vec::with_capacity(uids.len());
        let mut empty_uid: Option<String> = None;
        for uid in uids {
            let mut body = String::new();
            if let Ok(data) = session.uid_fetch(uid, "(RFC822.TEXT)") {
                for fetch in data.iter() {
                    if let Some(text) = fetch.text() {
                        body = decode_quoted_printable(&String::from_utf8_lossy(text));
                        break;
                    }
                }
            }
            if body.is_empty() {
                empty_uid = Some(uid.clone());
                break;
            }
            out.push((uid.clone(), body));
        }

        if folder != "INBOX" {
            let _ = session.select("INBOX");
        }

        // Пустое тело = рассинхрон сессии (см. fetch_message_body): Err, чтобы
        // lib.rs сделал reconnect и повторил весь батч. Ok с дырками раньше
        // намертво кэшировался фронтом как пустые сообщения.
        if let Some(uid) = empty_uid {
            anyhow::bail!("Empty body for uid {uid} in {folder} (session desync?)");
        }
        Ok(out)
    }

    pub async fn send_email(&mut self, to: &str, subject: &str, body: &str) -> Result<()> {
        let from_mailbox: Mailbox = self.config.email.parse().context("Invalid sender email")?;
        let to_mailbox: Mailbox = to.parse().context("Invalid recipient email")?;

        let email = Message::builder()
            .from(from_mailbox)
            .to(to_mailbox)
            .subject(subject)
            .header(ContentType::TEXT_PLAIN)
            .body(fold_lines(body))
            .context("Failed to build email")?;

        let creds = Credentials::new(self.config.email.clone(), self.config.password.clone());

        let transport =
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.config.smtp_server)?
                .credentials(creds)
                .port(self.config.smtp_port)
                .timeout(Some(std::time::Duration::from_secs(30)))
                .build();

        transport
            .send(email)
            .await
            .context("Failed to send email")?;
        Ok(())
    }

    pub fn disconnect(&mut self) {
        if let Some(mut session) = self.imap_session.take() {
            let _ = session.logout();
        }
    }
}

/// Decode quoted-printable MIME body — transport-encoded `=XX` and soft line
/// breaks (`=\r\n`). Needed because SMTP relays (Gmail included) may re-encode
/// the Vault encrypted block (base64) as quoted-printable on delivery.
fn decode_quoted_printable(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'=' => {
                // Soft line break: "=\r\n" or "=\n" → skip entirely
                if i + 1 < bytes.len() && (bytes[i + 1] == b'\r' || bytes[i + 1] == b'\n') {
                    i += if i + 2 < bytes.len() && bytes[i + 1] == b'\r' && bytes[i + 2] == b'\n' {
                        3
                    } else {
                        2
                    };
                    continue;
                }
                // Hex escape: =XX
                if i + 2 < bytes.len() {
                    let hi = (bytes[i + 1] as char).to_digit(16);
                    let lo = (bytes[i + 2] as char).to_digit(16);
                    if let (Some(h), Some(l)) = (hi, lo) {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                        continue;
                    }
                }
                // Literal '=' (shouldn't happen, but keep)
                out.push(b'=');
                i += 1;
            }
            b'\r' if i + 1 < bytes.len() && bytes[i + 1] == b'\n' => {
                // Normalize CRLF → LF
                out.push(b'\n');
                i += 2;
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// Fold long lines to ≤76 columns (RFC 5322 soft wrap) before sending.
/// SMTP relays and spam filters treat unbroken >100-char base64 lines as
/// suspicious, and some relays refuse long lines outright. The Vault encrypted
/// block and raw-base64 bodies are rebuilt by receivers via whitespace-stripping,
/// so folding is lossless for both codecs.
fn fold_lines(body: &str) -> String {
    const MAX: usize = 76;
    body.lines()
        .flat_map(|line| {
            if line.len() <= MAX {
                vec![line.to_string()]
            } else {
                line.as_bytes()
                    .chunks(MAX)
                    .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
                    .collect::<Vec<_>>()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_header(header: &str, name: &str) -> Option<String> {
    header
        .lines()
        .find(|line| line.to_lowercase().starts_with(&name.to_lowercase()))
        .and_then(|line| line.splitn(2, ':').nth(1))
        .map(|value| value.trim().to_string())
}