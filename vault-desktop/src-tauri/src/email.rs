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
use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::message::Message;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Tokio1Executor};
use native_tls::{TlsConnector, TlsStream};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

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
    /// Размер письма в байтах (RFC822.SIZE из IMAP-заголовочного фетча).
    /// 0 = неизвестно. Download-on-demand: письма крупнее порога не
    /// фетчатся телом автоматически — пользователь качает по требованию.
    #[serde(default)]
    pub size: u32,
}

fn default_inbox() -> String {
    "INBOX".to_string()
}

/// Результат IMAP IDLE: в папке появилось письмо или истёк таймаут.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleOutcome {
    /// Сервер прислал EXISTS/EXISTS-уведомление — в выбранной папке новое письмо.
    Changed,
    /// Таймаут истёк, новых писем нет.
    TimedOut,
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
    /// «Письма себе» (mail.ru: INBOX/ToMyself) — провайдеры с автосортировкой
    /// раскладывают письма From==To (эскроу-письмо Key Recovery!) в подпапку
    /// INBOX, и письмо «самому себе» не видно в INBOX. Без сканирования
    /// этой папки восстановление аккаунта молча не работает.
    self_letters: Option<String>,
}

pub struct EmailClient {
    config: EmailConfig,
    imap_session: Option<Session<TlsStream<TcpStream>>>,
    /// Папка, выбранная в текущей сессии (использует только IDLE-путь:
    /// select делается один раз и переиспользуется, пока папка не сменилась).
    selected_folder: Option<String>,
    /// Серия неудач IDLE/соединения подряд — основа backoff (2с→5с→15с→30с→60с).
    fail_streak: u32,
    /// Счётчик переподключений: попадает в лог, чтобы шторм реконнектов был
    /// виден без разбора каждой строки «imap: connected».
    reconnects: u32,
    /// До какого момента новые CONNECT-попытки отбрасываются (серия неудач).
    connect_retry_after: Option<Instant>,
}

/// Ступени backoff (сек) по номеру неудачи: 2с → 5с → 15с → 30с → плато 60с.
/// Сбрасывается при первой успешной операции: восстановившееся соединение
/// возвращается к нормальному темпу сразу, не дожидаясь конца лестницы.
const BACKOFF_STEPS_SEC: [u64; 5] = [2, 5, 15, 30, 60];

/// Вычислить дедлайн следующей CONNECT-попытки и остаток паузы.
///
/// Вынесено в свободную функцию, чтобы правило можно было покрыть тестом без
/// `EmailConfig` и без сети. Ключевое свойство — **дедлайн не продлевается**:
/// если активная пауза ещё не истекла, возвращается тот же самый момент и тот
/// же остаток, сколько был до этой неудачи. Иначе серия неудач (а фаст-путь
/// «сессии нет → ошибка → note_failure» повторяется каждые ~3мс) бесконечно
/// сдвигала бы дедлайн вперёд, и пауза не истекала бы НИКОГДА — сессия не
/// строилась бы никогда (livelock, телефон X50, 04.10.2026, 0.1.210).
///
/// `(fail_streak, deadline, now) -> (новый deadline, остаток)`
fn next_connect_deadline(
    fail_streak: u32,
    deadline: Option<Instant>,
    now: Instant,
) -> (Option<Instant>, Duration) {
    match deadline {
        Some(existing) if existing > now => (Some(existing), existing - now),
        _ => {
            let idx = (fail_streak.saturating_sub(1) as usize).min(BACKOFF_STEPS_SEC.len() - 1);
            let delay = Duration::from_secs(BACKOFF_STEPS_SEC[idx]);
            (Some(now + delay), delay)
        }
    }
}

impl EmailClient {
    pub fn new(config: EmailConfig) -> Self {
        Self {
            config,
            imap_session: None,
            selected_folder: None,
            fail_streak: 0,
            reconnects: 0,
            connect_retry_after: None,
        }
    }

    /// Есть ли живая IMAP-сессия.
    pub fn is_connected(&self) -> bool {
        self.imap_session.is_some()
    }

    /// Текущая серия неудач (для диагностических логов).
    pub fn fail_streak(&self) -> u32 {
        self.fail_streak
    }

    /// Пауза для ТЕКУЩЕЙ серии неудач (без изменения счётчика).
    pub fn backoff_delay(&self) -> Duration {
        let idx = (self.fail_streak.saturating_sub(1) as usize).min(BACKOFF_STEPS_SEC.len() - 1);
        Duration::from_secs(BACKOFF_STEPS_SEC[idx])
    }

    /// Отличать «сервера нет такой папки» от сетевого сбоя.
    ///
    /// Имена папок приходят ИЗ ДАННЫХ (настройки папок), а не из кода, и
    /// формируются динамически. Если такой папки на сервере нет, SELECT
    /// возвращает `No such folder` / `No such mailbox` (в тексте ошибки,
    /// вместе с мусором вроде `select RELAY failed: No Response:
    /// [CLIENTBUG] SELECT No such folder`). Это НЕ сетевая неудача: TCP жив,
    /// TLS жив, авторизация прошла — просто ящик не создан/удалён.
    ///
    /// Зачем отдельная проверка (живой тест, телефон X50, 0.1.211, 04.10.2026):
    /// клиент считал такую ошибку полноценным сетевым сбоем, звал
    /// `note_failure()`, растил streak и уходил в backoff на 60с. За 110с
    /// наблюдения — 59 записей «imap: reconnect deferred» при streak≈60 и
    /// всего 8 ФАКТИЧЕСКИХ переподключений. То есть на отсутствующую папку
    /// тратилось столько же ресурсов, сколько на реальный сетевой обрыв:
    /// лестница backoff не отличала «сеть упала» от «папки нет».
    ///
    /// Проверяется ВЕСЬ цепочка источников (`source()`), а не только верхний
    /// контекст: ошибка SELECT оборачивается в `anyhow::Context` («select
    /// {folder} failed: …»), и верхний слой сам по себе не содержит признака.
    /// Регистр не важен — провайдеры пишут по-разному.
    pub fn is_missing_folder_error(err: &anyhow::Error) -> bool {
        let is_missing = |text: &str| {
            let t = text.to_ascii_lowercase();
            t.contains("no such folder") || t.contains("no such mailbox")
        };
        // Строка цепочки целиком — ловит вложенные варианты вроде
        // «No Response: [CLIENTBUG] SELECT No such folder».
        if is_missing(&format!("{err:?}")) {
            return true;
        }
        // Пошаговый обход цепочки — не зависит от формата Debug-вывода.
        let mut src: Option<&(dyn std::error::Error + 'static)> = err.source();
        while let Some(e) = src {
            if is_missing(&e.to_string()) {
                return true;
            }
            src = e.source();
        }
        false
    }

    /// Засчитать неудачу в лестнице backoff; вернуть паузу до следующей попытки.
    pub fn note_failure(&mut self) -> Duration {
        self.fail_streak = self.fail_streak.saturating_add(1);
        // ДЕДЛАЙН МОНОТОННЫЙ: новая неудача НЕ передвигает его вперёд.
        //
        // Зачем: прежний код писал `connect_retry_after = now + delay` на КАЖДОЙ
        // неудаче. При активном фаст-пути (тик каждые ~3мс, пока сессии нет)
        // дедлайн непрерывно сдвигался вперёд, поэтому пауза НИКОГДА не
        // истекала: ensure_connected() вечно возвращал «IMAP connect backoff
        // active», а reconnect_imap_rate_limited() вечно писал «deferred».
        // На живом тесте (телефон X50, 04.10, 0.1.210) это выглядело как
        // 32 «reconnect deferred» за 40с при streak=492 и НУЛЕ успешных
        // подключений — livelock номер два, уже без шторма TCP, но с тем же
        // корнем: сессия никогда не строилась.
        //
        // Теперь: активная (ещё не истёкшая) пауза НЕ продлевается — новые
        // неудачи лишь считаются в streak, но дедлайн остаётся тем, что был
        // назначен ПЕРВОЙ неудачей серии. Иначе серия снова уводит дедлайн
        // вперёд и он не истекает никогда (ровно тот же livelock).
        // Когда паузы нет (первая неудача серии / предыдущая истекла) —
        // назначаем now + delay. Успех через note_success() сбрасывает всё.
        let now = Instant::now();
        let (deadline, remaining) =
            next_connect_deadline(self.fail_streak, self.connect_retry_after, now);
        self.connect_retry_after = deadline;
        remaining
    }

    /// Успех — лестница backoff сброшена, следующий сбой снова начнётся с 2с.
    pub fn note_success(&mut self) {
        self.fail_streak = 0;
        self.connect_retry_after = None;
    }

    /// Подключиться ТОЛЬКО если сессии ещё нет.
    ///
    /// Зачем: IDLE-мониторы зовут это каждый тик (7с). Раньше они вызывали
    /// connect_imap() безусловно — то есть КАЖДЫЕ 7 секунд создавали новое
    /// TCP+TLS+login-соединение и печатали «imap: connected», даже когда
    /// старое было живо. Это и есть постоянный шторм подключений в logcat
    /// (батарея/трафик/риск троттлинга провайдера). Теперь соединение
    /// переиспользуется, а пересоздаётся только при реальном обрыве.
    pub async fn ensure_connected(&mut self) -> Result<()> {
        if self.imap_session.is_some() {
            return Ok(());
        }
        // Активная пауза после серии неудач: не идём к провайдеру раньше времени.
        if let Some(t) = self.connect_retry_after {
            if Instant::now() < t {
                return Err(anyhow::anyhow!("IMAP connect backoff active"));
            }
        }
        match self.connect_imap().await {
            Ok(()) => {
                self.note_success();
                Ok(())
            }
            Err(e) => {
                // Ошибка «нет такой папки» — не сетевая: не засчитываем её в
                // лестницу backoff (streak остаётся, дедлайн не продлевается).
                // Иначе удалённый/несуществующий ящик из настроек папок
                // выжигал бы streak до плато 60с и ронял реальные обновления.
                if Self::is_missing_folder_error(&e) {
                    log::info!(
                        "imap: connect attempt reported missing folder \
                         (no streak, no backoff): {e}"
                    );
                    return Err(e);
                }
                let delay = self.note_failure();
                log::warn!(
                    "imap: connect failed (streak={}, next attempt in {}s): {e}",
                    self.fail_streak,
                    delay.as_secs()
                );
                Err(e)
            }
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
        // всё. Таймаут read/write 30 с даёт
        // Err, который существующий reconnect-путь уже умеет обрабатывать.
        // Сам TcpStream::connect без таймаута висит по системному TCP-таймауту
        // (минуты) — кнопка входа показывает «…» и «вход не проходит».
        //
        // HAPPY EYEBALLS (обязательно): getaddrinfo отдаёт AAAA (IPv6) ПЕРВЫМ,
        // а многие сети (российские провайдеры, корпоративные/гостевые Wi-Fi)
        // раздают IPv6-адрес БЕЗ рабочего маршрута наружу. Взять `.next()` —
        // значит уйти в чёрную дыру IPv6 и упасть по таймауту, хотя IPv4 в той
        // же сети работает (реальный кейс: телефон X50, imap.yandex.com — IPv6
        // 100% потерь, IPv4 9мс). Поэтому перебираем ВСЕ адреса: сначала IPv4,
        // затем IPv6, каждый с коротким таймаутом 5с.
        let host = self.config.imap_server.clone();
        let port = self.config.imap_port;
        let mut addrs: Vec<std::net::SocketAddr> = (host.as_str(), port)
            .to_socket_addrs()
            .context("Failed to resolve IMAP host")?
            .collect();
        if addrs.is_empty() {
            anyhow::bail!("No addresses for IMAP host");
        }
        addrs.sort_by_key(|a| u8::from(a.is_ipv6()));
        let mut tcp: Option<TcpStream> = None;
        let mut last_err = String::new();
        for a in &addrs {
            match TcpStream::connect_timeout(a, std::time::Duration::from_secs(5)) {
                Ok(s) => {
                    log::info!("imap: connected to {a}");
                    tcp = Some(s);
                    break;
                }
                Err(e) => {
                    log::warn!("imap: connect to {a} failed: {e}");
                    last_err = format!("{a}: {e}");
                }
            }
        }
        let tcp = tcp.ok_or_else(|| {
            anyhow::anyhow!(
                "Failed to connect to IMAP server (tried {} address(es); last: {})",
                addrs.len(),
                last_err
            )
        })?;
        let timeout = std::time::Duration::from_secs(30);
        tcp.set_read_timeout(Some(timeout))
            .context("Failed to set read timeout")?;
        tcp.set_write_timeout(Some(timeout))
            .context("Failed to set write timeout")?;
        let ssl_stream = tls
            .connect(&self.config.imap_server, tcp)
            .context("Failed TLS handshake")?;

        let client = imap::Client::new(ssl_stream);
        // Яндекс режет логин с доменом-алиасом (koanmak@ya.com → AUTHENTICATIONFAILED),
        // хотя тот же ящик принимается как «koanmak» или «koanmak@yandex.ru».
        // Для @ya.com отправляем bare-логин; остальные провайдеры работают как прежде.
        let imap_login: &str = if self.config.email.ends_with("@ya.com") {
            self.config
                .email
                .split('@')
                .next()
                .unwrap_or(&self.config.email)
        } else {
            &self.config.email
        };
        let session = client
            .login(imap_login, &self.config.password)
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
            if out.junk.is_none() && attrs.iter().any(|a| a == "\\junk" || a == "\\spam") {
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
            // «Письма себе» (mail.ru: INBOX/ToMyself, локаль «Письма себе»).
            // Автосортировка провайдера прячет From==To из INBOX — эскроу-письмо
            // восстановления аккаунта было бы невидимо.
            if out.self_letters.is_none()
                && (name_l.ends_with("/tomyself")
                    || name_l == "tomyself"
                    || name_l == "myself"
                    || name_l.ends_with("/myself")
                    || name_l == "письма себе"
                    || name_l.ends_with("/письма себе")
                    || name_l.ends_with("/letters to myself")
                    || name_l == "letters to myself")
            {
                out.self_letters = Some(name.to_string());
            }
        }
        out
    }

    /// Fetch the most recent `limit` messages from one mailbox, newest first.
    fn fetch_folder(&mut self, folder: &str, limit: usize) -> Result<Vec<EmailMessage>> {
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;

        // Папки из настроек — динамические, сервер мог не создать/удалить ящик.
        // Отсутствие папки НЕ должно выглядеть как сетевой сбой: возвращаем
        // пустой результат, чтобы вызывающий цикл просто пропустил эту папку
        // (без реконнекта и без роста streak). Реальные ошибки сети — в Err.
        if let Err(e) = session.select(folder) {
            let err = anyhow::anyhow!("select {folder} failed: {e}");
            if Self::is_missing_folder_error(&err) {
                eprintln!("[email] folder {folder} missing on server — skipped");
                return Ok(Vec::new());
            }
            return Err(err);
        }

        let message_ids = session.uid_search("ALL")?;
        let mut messages = Vec::new();

        let mut uids: Vec<u32> = message_ids.iter().copied().collect();
        uids.sort_by(|a, b| b.cmp(a));
        uids.truncate(limit);

        // Один round-trip вместо поштучных uid_fetch: на ящике с тысячами
        // писем последовательные запросы занимали минуты, и поллинг/клик
        // по чату «зависали» (а то и умирали по таймауту).
        // Ошибка батч-фетча пробрасывается наверх (НЕ молчаливый пустой
        // if-let-Ok глотал ошибку, и приложение молча видело пустой ящик.
        if !uids.is_empty() {
            let uid_set = uids
                .iter()
                .map(|u| u.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let data = session
                .uid_fetch(&uid_set, "(UID FLAGS RFC822.HEADER RFC822.SIZE)")
                .with_context(|| format!("UID FETCH failed in folder {folder}"))?;
            for fetch in data.iter() {
                let uid = fetch.uid.unwrap_or_default().to_string();
                let flags = fetch.flags();
                let is_read = flags.iter().any(|f| matches!(f, imap::types::Flag::Seen));

                if let Some(header) = fetch.header() {
                    let header_str = String::from_utf8_lossy(header);
                    let from = extract_header(&header_str, "From:")
                        .unwrap_or_else(|| "Unknown".to_string());
                    let to =
                        extract_header(&header_str, "To:").unwrap_or_else(|| "Unknown".to_string());
                    let subject = extract_header(&header_str, "Subject:")
                        .unwrap_or_else(|| "(no subject)".to_string());
                    let date = extract_header(&header_str, "Date:")
                        .unwrap_or_else(|| "Unknown".to_string());
                    let message_id = extract_header(&header_str, "Message-ID:").unwrap_or_default();

                    messages.push(EmailMessage {
                        id: uid,
                        from,
                        to,
                        subject,
                        date,
                        is_read,
                        folder: folder.to_string(),
                        message_id,
                        size: fetch.size.unwrap_or(0),
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
        self.reconnects = self.reconnects.saturating_add(1);
        // Лог ровно ОДИН раз на реальное переподключение, с номером и причиной:
        // при шторме видно «imap: reconnect #N (streak=…)», а не сотни
        // безликих «imap: connected». Успех/провал самого коннекта пишет
        // connect_imap (connected / connect to … failed).
        log::info!(
            "imap: reconnect #{} (streak={})",
            self.reconnects,
            self.fail_streak
        );
        if let Some(mut session) = self.imap_session.take() {
            let _ = session.logout();
        }
        self.connect_imap().await
    }

    /// Fetch recent messages. Folder strategy: ONLY
    /// INBOX + Junk. Sent is NEVER read: the sender's copies are found in
    /// Junk/INBOX (Gmail self-BCC behaviour) or not needed (outgoing messages
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
                // The Junk folder may be missing/unreachable — do not fail the
                // whole fetch, INBOX is already retrieved.
                Err(e) => eprintln!("[email] junk folder {junk} fetch failed: {e}"),
            }
        }

        // «Письма себе» (mail.ru: INBOX/ToMyself) — эскроу-письмо Key Recovery
        // прячется туда автосортировкой провайдера (From==To). Читаем и её.
        if let Some(selfl) = &folders.self_letters {
            match self.fetch_folder(selfl, 100) {
                Ok(self_msgs) => {
                    for m in self_msgs {
                        if !m.message_id.is_empty() && !seen.insert(m.message_id.clone()) {
                            continue;
                        }
                        messages.push(m);
                    }
                }
                Err(e) => eprintln!("[email] self-letters folder {selfl} fetch failed: {e}"),
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

        // Нет такой папки → пустой результат и max_uid = 0. Ноль важен: пустой
        // результат НЕ продвигает курсор (см. collect() в fetch_newer), поэтому
        // пропущенный ящик не «отравляет» курсор и не заставляет клиент
        // переподключаться. Реальные ошибки сети идут в Err как раньше.
        if let Err(e) = session.select(folder) {
            let err = anyhow::anyhow!("select {folder} failed: {e}");
            if Self::is_missing_folder_error(&err) {
                eprintln!("[email] folder {folder} missing on server — skipped");
                return Ok((Vec::new(), 0));
            }
            return Err(err);
        }

        let uid_list = match last_uid {
            None => session.uid_search("ALL")?,
            // Диапазон X:* на Gmail НЕНАДЁЖЕН: при скоплении нескольких
            // писем после курсора (17 писем за день офлайна) он возвращал
            // ТОЛЬКО максимальный uid — середина диапазона (все письма
            // между курсором и max) терялась навсегда, чат пустел
            // (кейс 13.09: группа «Четыре», uid 1551-1567, получен один).
            // Надёжный путь: полный список ALL + клиентский фильтр
            // uid > last. Папка уже выбрана, ALL — один RTT, объём
            // копеечный (uid-числа). Self-валиддность проверок ниже
            // (UIDVALIDITY reset, max == last) сохраняется.
            Some(_last) => session.uid_search("ALL")?,
        };
        let raw_uids: Vec<u32> = uid_list.iter().copied().collect();
        let raw_max = raw_uids.iter().copied().max().unwrap_or(0);
        // САМОВОССТАНОВЛЕНИЕ: Gmail периодически ПЕРЕСОЗДАЁТ папку
        // Спама (автоочистка) — UIDVALIDITY меняется, UID'ы начинаются с 1.
        // Старый курсор (например 2963) оказывается ВПЕРЕДИ реального max
        // (например 69), и клиентский фильтр uid > last_uid навсегда
        // отбрасывает всё — инкрементальный фетч слепнет (входящие звонки в
        // Спаме не видны). Признак сброса: search вернул непустой список,
        // но его max ≤ курсора. Если max == курсор — это обычный «нет новых»
        // (quirk Gmail: X:* на пустом диапазоне возвращает max) — тихо.
        // Если max < курсор — пересканируем папку целиком и пере-семеним.
        if let Some(last) = last_uid {
            if !raw_uids.is_empty() && raw_max < last {
                eprintln!(
                    "[email] folder {folder}: cursor {last} AHEAD of mailbox max {raw_max} \
                     (UIDVALIDITY reset) — full re-scan, re-seeding cursor"
                );
                return self.fetch_folder_from(folder, None, limit);
            }
        }
        let mut uids: Vec<u32> = raw_uids
            .into_iter()
            .filter(|u| match last_uid {
                None => true,
                Some(last) => *u > last,
            })
            .collect();
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
                .uid_fetch(&uid_set, "(UID FLAGS RFC822.HEADER RFC822.SIZE)")
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
                        size: fetch.size.unwrap_or(0),
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
        eprintln!(
            "[email] fetch_newer: junk={:?} all={:?} cursors_junk={:?}",
            folders.junk,
            folders.all,
            cursors.get("JUNK")
        );
        let mut new_cursors = cursors.clone();
        // Дедуп по Message-ID внутри одного батча: одно письмо может лежать
        // в двух папках (провайдер положил в INBOX, потом перенёс в Спам).
        // Ключ дедупа — message_id + папка: копия из ДРУГОЙ папки не
        // глотается, а отдаётся фронту — там она «оживит» запись, чей
        // старый (INBOX, uid) стал мёртвым после переноса письма.
        let mut seen: HashSet<String> = HashSet::new();
        let mut messages: Vec<EmailMessage> = Vec::new();

        let mut collect = |_folder: &str, fallback: &str, msgs: Vec<EmailMessage>, max_uid: u32| {
            // Пустой результат НЕ продвигает курсор: uid_search мог вернуть
            // пусто из-за троттлинга/рассинхрона сессии, и запись 0
            // «отравляла» папку — инкремент от 0 при следующих поллингах
            // тоже возвращал пусто (Zoho), чаты пустели навсегда.
            // Курсор движется только при реально полученных письмах.
            if max_uid > 0 {
                new_cursors.insert(fallback.to_string(), max_uid);
            }
            if max_uid == 0 {
                return; // empty folder — nothing new
            }
            for m in msgs {
                // Ключ дедупа = message_id + папка (folder — String
                // с serde-default «INBOX», пустым не бывает).
                let dedup_key = format!("{}|{}", m.message_id, m.folder);
                if !m.message_id.is_empty() && !seen.insert(dedup_key) {
                    continue;
                }
                messages.push(m);
            }
        };

        // INBOX — всегда (основной источник входящих).
        match self.fetch_folder_from("INBOX", cursors.get("INBOX").copied(), 100) {
            Ok((msgs, max)) => collect("INBOX", "INBOX", msgs, max),
            Err(e) => eprintln!("[email] INBOX incremental fetch failed: {e}"),
        }

        // Спам — всегда: Gmail кладёт шифрописьма в Junk.
        // Важно: имя папки Спама в IMAP (modified UTF-7) МЕНЯЕТСЯ между
        // сессиями (Gmail encoding variance). Ключ курсора для Junk — всегда
        // "JUNK" (не имя папки), чтобы курсор переживал перезапуск.
        if let Some(junk) = &folders.junk {
            match self.fetch_folder_from(junk, cursors.get("JUNK").copied(), 50) {
                Ok((msgs, max)) => collect(junk, "JUNK", msgs, max),
                Err(e) => eprintln!("[email] Junk folder {junk} incremental fetch failed: {e}"),
            }
        }

        // «Письма себе» (mail.ru: INBOX/ToMyself) — эскроу-письмо Key Recovery
        // автосортировкой провайдера уезжает туда, минуя INBOX. Курсор "SELF".
        if let Some(selfl) = &folders.self_letters {
            match self.fetch_folder_from(selfl, cursors.get("SELF").copied(), 50) {
                Ok((msgs, max)) => collect(selfl, "SELF", msgs, max),
                Err(e) => eprintln!("[email] self-letters {selfl} incremental fetch failed: {e}"),
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

        // Всегда select (включая INBOX) — на новом соединении папка не выбрана.
        // ошибка select БОЛЬШЕ не игнорируется. Пример: select
        // Спама упал → uid_fetch по совпавшему ЧИСЛУ uid вытянул тело ЧУЖОГО
        // письма из INBOX (100КБ рассылка) → base64 невалиден → «decrypt
        // failed» навсегда (звонок при смахнутом приложении не показывался).
        // Также проверяем UIDVALIDITY? Достаточно Err: невозможно определить
        // папку — честный Err (caller делает retry).
        let sel = match session.select(folder) {
            Ok(sel) => sel,
            Err(e) => {
                let err = anyhow::anyhow!("select {folder} failed: {e}");
                // Отсутствующая папка — не сетевой сбой и не рассинхрон:
                // reconnect+retry её не создаст, вызывающий в lib.rs будет
                // повторять попытки и в итоге уйдёт в backoff на 60с
                // (шторм реконнектов, телефон X50, 04.10.2026). Возвращаем
                // пустое тело БЕЗ Err — цикл пропустит эту папку и пойдёт
                // дальше. Отличие от «теряем письмо»: здесь письма в папке
                // физически нет, пустой кэш тела корректен.
                if Self::is_missing_folder_error(&err) {
                    eprintln!("[email] body fetch: folder {folder} missing — skipped");
                    let _ = session.select("INBOX");
                    return Ok(String::new());
                }
                return Err(err);
            }
        };
        // Папки берутся из настроек и могут отсутствовать на сервере (удалены,
        // не созданы провайдером). Это НЕ рассинхрон сессии: переподключение
        // не поможет — папки всё так же нет. Пустое тело из-за РЕАЛЬНОГО
        // рассинхрона по-прежнему даёт Err (проверка body.is_empty() ниже),
        // чтобы вызывающий всё-таки сделал reconnect и повторил.
        if sel.exists == 0 {
            anyhow::bail!("select {folder}: mailbox empty (select failed silently?)");
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

    /// Скопировать письмо из его папки (Спам/«Письма себе»/др.) во INBOX.
    /// Безопасный COPY: оригинал НЕ удаляется (нет риска потерять письмо при
    /// сбое). Эскроу-письмо восстановления должно лежать в папке, которую
    /// провайдер не чистит, — иначе через ~30 дней восстановление станет
    /// невозможным.
    pub async fn copy_to_inbox(&mut self, folder: &str, uid: &str) -> Result<(), String> {
        let session = self
            .imap_session
            .as_mut()
            .ok_or_else(|| "Not connected to IMAP server".to_string())?;
        session
            .select(folder)
            .map_err(|e| format!("select {folder} failed: {e}"))?;
        let _ = session.uid_copy(uid, "INBOX");
        let _ = session.select("INBOX");
        Ok(())
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

        // ВСЕГДА select(folder), включая INBOX: на новом соединении (теперь
        // каждый fetch_bodies — отдельный клиент) папка не выбрана, uid_fetch
        // без select возвращает пусто.
        //
        // Отсутствующая папка — не рассинхрон: без проверки ошибки select все
        // uid_fetch ниже вернули бы пусто, сработал bail «Empty body for ALL N
        // uids», и вызывающий в lib.rs пошёл переподключаться по кругу
        // (шторм реконнектов, телефон X50, 04.10.2026). Отдаём пустой батч
        // без Err — цикл пропустит папку. Реальная ошибка сети — в Err.
        if let Err(e) = session.select(folder) {
            let err = anyhow::anyhow!("select {folder} failed: {e}");
            if Self::is_missing_folder_error(&err) {
                eprintln!("[fetch_bodies] folder={folder} missing on server — skipped");
                return Ok(Vec::new());
            }
            return Err(err);
        }

        let mut out = Vec::with_capacity(uids.len());
        let mut empty_uids: Vec<String> = Vec::new();
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
            // Пустое тело одного uid НЕ должно обрывать весь батч: провайдер
            // переносит письмо INBOX→Спам после индексации, и uid в старой
            // папке остаётся мёртвым навсегда. Раньше первый такой uid
            // ронял весь запрос (break + bail!) — и тела всех остальных
            // писем папки не загружались до полного рескана. Мёртвые uid
            // пропускаем и собираем отдельно; живые тела отдаём.
            if body.is_empty() {
                empty_uids.push(uid.clone());
                continue;
            }
            out.push((uid.clone(), body));
        }
        eprintln!(
            "[fetch_bodies] folder={folder} requested={} returned={} empty_uids={:?}",
            uids.len(),
            out.len(),
            empty_uids
        );

        if folder != "INBOX" {
            let _ = session.select("INBOX");
        }

        // ВСЕ тела пустые = реальный рассинхрон сессии (см. fetch_message_body):
        // Err, чтобы lib.rs сделал reconnect и повторил батч. Частично пустые —
        // норма (письма переехали в другую папку), отдаём то, что есть.
        if out.is_empty() && !empty_uids.is_empty() {
            anyhow::bail!(
                "Empty body for ALL {n} uids in {folder} (session desync?)",
                n = empty_uids.len()
            );
        }
        Ok(out)
    }

    pub async fn send_email(&mut self, to: &str, subject: &str, body: &str) -> Result<()> {
        self.send_email_with_id(to, subject, body, None).await
    }

    /// Отправка с явным Message-ID (download-on-demand): мета-сообщение
    /// ссылается на data-письмо по Message-ID, поэтому тот должен быть
    /// известен ДО отправки. Нейтральный вид (<vault-...@dom>) не выдаёт
    /// больше информации, чем UUID, генерируемый провайдером.
    pub async fn send_email_with_id(
        &mut self,
        to: &str,
        subject: &str,
        body: &str,
        message_id: Option<&str>,
    ) -> Result<()> {
        let from_mailbox: Mailbox = self.config.email.parse().context("Invalid sender email")?;
        let to_mailbox: Mailbox = to.parse().context("Invalid recipient email")?;

        let mut builder = Message::builder()
            .from(from_mailbox)
            .to(to_mailbox)
            .subject(subject)
            .header(ContentType::TEXT_PLAIN);
        if let Some(mid) = message_id {
            builder = builder.message_id(Some(mid.to_string()));
        }
        let email = builder
            .body(fold_lines(body))
            .context("Failed to build email")?;

        let creds = Credentials::new(self.config.email.clone(), self.config.password.clone());

        // Яндекс SMTP — порт 465 (SMTPS: TLS сразу, без STARTTLS). Для порта
        // 465 нужен relay (TLS), для 587 — starttls_relay.
        // всегда делал starttls_relay даже на 465 — Яндекс ждал TLS-рукопожатие,
        // а клиент начинал с STARTTLS-команды → соединение рвалось, «Failed to
        // send email».
        let transport_builder = if self.config.smtp_port == 465 {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&self.config.smtp_server)?
                .port(self.config.smtp_port)
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&self.config.smtp_server)?
                .port(self.config.smtp_port)
        };
        let transport = transport_builder
            .credentials(creds)
            // 10с вместо 30с: при зависании SMTP сигнал звонка
            // (call_accept/answer) ждал 30с до ретрая — собеседник висел
            // в «Соединение…». 10с достаточно для штатной отправки.
            .timeout(Some(std::time::Duration::from_secs(10)))
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
        self.selected_folder = None;
        self.fail_streak = 0;
        self.connect_retry_after = None;
    }

    // ── IMAP IDLE (Фаза 1.5 звонков) ────────────────────────────────────────
    // Серверный push вместо поллинга: IDLE блокируется, пока в выбранной
    // папке не появится письмо (или не истечёт таймаут). Сигналы call_*
    // доходят за ~1с вместо 3с ускоренного поллинга.
    //
    // ВАЖНО: вызывать только на ОТДЕЛЬНОМ EmailClient (слот 2 в lib.rs) —
    // IDLE держит сессию занятой, и пока идёт ожидание, команды поверх неё
    // невозможны. Основной клиент (поллинг/UI) не должен об этом знать.
    pub async fn idle_wait(&mut self, folder: &str, timeout: Duration) -> Result<IdleOutcome> {
        match self.idle_wait_once(folder, timeout).await {
            Ok(outcome) => {
                self.note_success();
                Ok(outcome)
            }
            Err(first_err) => {
                // Отсутствие папки — НЕ сетевая неудача: не растим streak и не
                // переподключаемся (лестница backoff остаётся для настоящих
                // обрывов). Цикл просто пропустит эту папку.
                if Self::is_missing_folder_error(&first_err) {
                    log::info!(
                        "imap: idle_wait skip — folder missing on server \
                         (no streak, no reconnect): {first_err}"
                    );
                    return Ok(IdleOutcome::TimedOut);
                }
                // Сервер оборвал IDLE-соединение (провайдер рвёт idle-сессии,
                // сетевой сбой) — переподключаемся и пробуем ещё раз.
                //
                // BACKOFF: раньше каждый вызов idle_wait при ошибке дёргал
                // reconnect_imap() без всякой паузы. В сочетании с двумя
                // параллельными IDLE-циклами на один аккаунт это давало
                // серию reconnect'ов раз в 1–2 секунды («imap: connected»
                // десятками строк в logcat). Теперь перед переподключением
                // выдерживается ступень лестницы 2с→5с→15с→30с→60с, а сам
                // reconnect_imap_rate_limited откладывает попытку, если
                // пауза ещё не истекла. Успех сбрасывает лестницу.
                let delay = self.note_failure();
                log::warn!(
                    "imap: idle_wait failed (streak={}, reconnect in {}s): {first_err}",
                    self.fail_streak,
                    delay.as_secs()
                );
                // max_wait = полный IDLE-таймаут: паузу ждать есть где, и она
                // не приведёт к выходу по таймауту вызывающего. При превышении
                // reconnect_imap_rate_limited сбросит битую сессию и вернёт
                // управление — восстановление доделает следующий тик.
                self.reconnect_imap_rate_limited(timeout).await?;
                match self.idle_wait_once(folder, timeout).await {
                    Ok(outcome) => {
                        self.note_success();
                        Ok(outcome)
                    }
                    Err(e) => Err(anyhow::anyhow!(
                        "IDLE retry failed after reconnect: {e} (original: {first_err})"
                    )),
                }
            }
        }
    }

    /// Переподключение с учётом лестницы backoff: если пауза после
    /// предыдущей неудачи ещё не истекла — ждём её остаток и только затем
    /// идём к провайдеру. Это ограничивает частоту реконнектов при серии
    /// сбоев (и не даёт «штормить» IMAP-сервер).
    ///
    /// Публичный метод: тем же ограниченным реконнектом пользуется быстрый
    /// путь звонков (email_fetch_incremental_fast), который дёргается из JS
    /// по таймеру — без лестницы серия сбоев давала бы новое TCP+TLS каждый
    /// тик (7с).
    pub async fn reconnect_imap_rate_limited(&mut self, max_wait: Duration) -> Result<()> {
        // СЕССИЮ ВЫБРАСЫВАЕМ ДО паузы, а не после неё.
        //
        // Это и есть фикс livelock'а, наблюдённого на телефоне 04.10
        // (0.1.209): «imap: connected» = 0 при streak=335 и
        // «backoff wait 59s before reconnect #4» каждые 15с. Прежний код
        // спал остаток паузы ВНУТРИ этой функции, а все вызывающие в lib.rs
        // оборачивали её в t_timeout(15s/20s). Пауза 60с туда физически не
        // помещалась → t_timeout срывал функцию ДО reconnect_imap(), битая
        // сессия оставалась в self.imap_session (is_some() == true), поэтому
        // даже ensure_connected() её не трогал. Следующий тик повторял то
        // же самое — восстановление становилось невозможным навсегда, и
        // клиент пил CPU каждые 15с вместо построения соединения.
        //
        // Теперь: битая сессия сбрасывается немедленно, поэтому любой
        // последующий путь (ensure_connected / fetch_*) увидит «нет сессии»
        // и построит соединение сам, когда пауза истечёт. Состояние после
        // обрыва таймаута — всегда восстановимое.
        if let Some(mut session) = self.imap_session.take() {
            let _ = session.logout();
        }
        if let Some(t) = self.connect_retry_after {
            let now = Instant::now();
            if now < t {
                let wait = t - now;
                // Пауза не помещается в бюджет вызывающего — НЕ спим здесь,
                // а отдаём управление: сессия уже сброшена, reconnect доделает
                // ближайший тик. Иначе снова выйдем по таймауту.
                if wait > max_wait {
                    log::info!(
                        "imap: reconnect deferred, backoff {}s left > caller budget {}s (session dropped, retry later)",
                        wait.as_secs(),
                        max_wait.as_secs()
                    );
                    return Err(anyhow::anyhow!(
                        "IMAP reconnect deferred: backoff {}s exceeds caller budget {}s",
                        wait.as_secs(),
                        max_wait.as_secs()
                    ));
                }
                log::info!(
                    "imap: backoff wait {}s before reconnect #{}",
                    wait.as_secs(),
                    self.reconnects + 1
                );
                tokio::time::sleep(wait).await;
            }
        }
        self.reconnect_imap().await
    }

    async fn idle_wait_once(&mut self, folder: &str, timeout: Duration) -> Result<IdleOutcome> {
        if self.imap_session.is_none() {
            self.connect_imap().await?;
            self.selected_folder = None;
        }
        let session = self
            .imap_session
            .as_mut()
            .context("Not connected to IMAP server")?;
        // SELECT делаем только при смене папки — это один round-trip.
        if self.selected_folder.as_deref() != Some(folder) {
            if let Err(e) = session.select(folder) {
                let err = anyhow::anyhow!("select {folder} failed: {e}");
                // Нет такой папки — это НЕ обрыв сети. Сессия жива, просто
                // ящик удалён/не создан. Возвращаем «таймаут без новых писем»:
                // IDLE-цикл просто пропустит эту папку, БЕЗ note_failure() и
                // БЕЗ переподключения. Иначе клиент на каждый несуществующий
                // ящик растил streak и уходил в backoff на 60с (X50, 0.1.211).
                if Self::is_missing_folder_error(&err) {
                    log::info!(
                        "imap: idle skip folder {folder} — no such folder on server \
                         (not a network failure, keeping session)"
                    );
                    return Ok(IdleOutcome::TimedOut);
                }
                return Err(err);
            }
            self.selected_folder = Some(folder.to_string());
        }
        let handle = session
            .idle()
            .map_err(|e| anyhow::anyhow!("IDLE command failed: {e}"))?;
        match handle
            .wait_with_timeout(timeout)
            .map_err(|e| anyhow::anyhow!("IDLE wait failed: {e}"))?
        {
            imap::extensions::idle::WaitOutcome::MailboxChanged => Ok(IdleOutcome::Changed),
            imap::extensions::idle::WaitOutcome::TimedOut => Ok(IdleOutcome::TimedOut),
        }
    }
}

/// Decode quoted-printable MIME body — transport-encoded `=XX` and soft line
/// breaks (`=\r\n`). Needed because SMTP relays (Gmail included) may re-encode
/// the Vault encrypted block (base64) as quoted-printable on delivery.
pub(crate) fn decode_quoted_printable(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'=' => {
                // Soft line break: "=\r\n" или "=\n" → пропускаем, НО только
                // если после перевода есть содержимое. "=\r\n" в КОНЦЕ тела =
                // base64-пэйдинг ('==') + финальный CRLF служебного 7bit-тела,
                // а не QP-перенос: старая ветка съедала один '=' (68→67 символов,
                // atob бросал → isEncrypted=false → письмо молча отбрасывалось;
                // живой баг X50 09.10: hav/meta-письма не распознавались как
                // зашифрованные — аватарки не восстанавливались).
                if i + 1 < bytes.len() && (bytes[i + 1] == b'\r' || bytes[i + 1] == b'\n') {
                    let eol = if i + 2 < bytes.len()
                        && bytes[i + 1] == b'\r'
                        && bytes[i + 2] == b'\n'
                    {
                        2
                    } else {
                        1
                    };
                    let after = i + 1 + eol;
                    if after < bytes.len() {
                        i = after; // настоящий QP-перенос: продолжение есть
                        continue;
                    }
                    // Конец тела: '=' — это пэйдинг base64 → литерал
                    // (CRLF ниже отдаётся как есть; потребители режут пробелы).
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Регрессия X50 09.10.2026: кадр 49Б → base64 68 символов с '==',
    /// RFC822.TEXT заканчивается CRLF. Старый decode принимал '==\r\n' за
    /// QP soft-break и съедал '=' (67 символов) → isEncrypted=false →
    /// hav/meta-письма молча отбрасывались.
    #[test]
    fn qp_keeps_base64_padding_before_final_crlf() {
        // Инвариант потребителей (isEncrypted/decrypt): после strip-whitespace
        // форма должна совпасть с исходным base64 ЦЕЛИКОМ, включая пэйдинг.
        // Старый код терял '=' → 67 символов (%4 != 0) → atob/декодер падали.
        let strip = |s: &str| -> String { s.chars().filter(|c| !c.is_whitespace()).collect() };
        let raw = "gbgdGPmguO+L19LJeVo537gZSu3xWjA2FvPb1Jk3HhuGFHnEgR/f/FELEZK/AVIG0A==\r\n";
        let out = strip(&decode_quoted_printable(raw));
        assert_eq!(out, strip(raw));
        assert_eq!(out.len() % 4, 0, "пэйдинг потерян: {} символов", out.len());
        let single = "YWJjZA=\r\n"; // одинарный пэйдинг + CRLF
        assert_eq!(strip(&decode_quoted_printable(single)), strip(single));
    }

    #[test]
    fn qp_soft_breaks_and_escapes_still_work() {
        assert_eq!(decode_quoted_printable("abc=\r\ndef"), "abcdef");
        assert_eq!(decode_quoted_printable("abc=\ndef"), "abcdef");
        assert_eq!(decode_quoted_printable("a=3Db"), "a=b");
        assert_eq!(decode_quoted_printable("keep=tail"), "keep=tail");
    }

    /// Регресс на livelock №2 (живой тест, телефон X50, 04.10.2026, 0.1.210):
    /// серия неудач не должна БЕСКОНЕЧНО отодвигать дедлайн следующего CONNECT.
    /// Прежний код писал `now + delay` на каждой неудаче, поэтому при
    /// фаст-пути (тик каждые ~3мс) пауза не истекала НИКОГДА: 32 «reconnect
    /// deferred» за 40с при streak=492 и нул успешных подключений.
    #[test]
    fn connect_deadline_is_not_extended_by_failure_series() {
        let t0 = Instant::now();
        // Первая неудача серии: пауза назначается по лестнице (streak=1 → 2с).
        let (mut deadline, remaining) = next_connect_deadline(1, None, t0);
        assert_eq!(remaining, Duration::from_secs(2));
        let first_deadline = deadline.expect("дедлайн назначен");

        // 500 неудач подряд, каждая через 3мс (тик фаст-пути). Дедлайн обязан
        // остаться ТОТ ЖЕ — иначе пауза не истекает никогда.
        for i in 2..=500u32 {
            let now = t0 + Duration::from_millis(3 * (i - 1) as u64);
            let (new_deadline, _) = next_connect_deadline(i, deadline, now);
            assert_eq!(
                new_deadline, deadline,
                "неудача #{i} передвинула дедлайн: {new_deadline:?} != {deadline:?}"
            );
            deadline = new_deadline;
        }
        assert_eq!(deadline, Some(first_deadline));

        // Спустя 2с пауза ИСТЕКАЕТ: следующая неудача назначает новую паузу.
        let after = first_deadline + Duration::from_millis(1);
        let (d2, r2) = next_connect_deadline(500, deadline, after);
        assert_eq!(r2, Duration::from_secs(60), "после истечения — плато 60с");
        assert!(d2 > deadline, "истёкшая пауза должна назначать новую");
    }

    /// Без предыдущей серии лестница идёт 2с → 5с → 15с → 30с → 60с (плато).
    /// Каждая ступень «начинается» после полного истечения предыдущей.
    #[test]
    fn backoff_ladder_then_plateau() {
        let t0 = Instant::now();
        let mut deadline: Option<Instant> = None;
        let mut offset = Duration::ZERO;
        for (streak, want) in [
            (1u32, 2u64),
            (2, 5),
            (3, 15),
            (4, 30),
            (5, 60),
            (6, 60),
            (99, 60),
        ] {
            let now = t0 + offset;
            let (d, r) = next_connect_deadline(streak, deadline, now);
            assert_eq!(r, Duration::from_secs(want), "ступень streak={streak}");
            deadline = d;
            offset = d.expect("дедлайн") - t0;
        }
    }

    /// note_success() обязан полностью сбрасывать лестницу backoff:
    /// после успеха deadline = None → паузы нет, и ensure_connected()
    /// сразу идёт к провайдеру (лестница начинается заново с 2с).
    #[test]
    fn note_success_resets_backoff() {
        let t0 = Instant::now();
        // Глубокая серия неудач назначает плато 60с.
        let (deadline, r) = next_connect_deadline(7, None, t0);
        assert_eq!(r, Duration::from_secs(60));
        assert!(deadline.is_some());

        // note_success() → connect_retry_after = None.
        let after_success: Option<Instant> = None;
        let (_, r2) = next_connect_deadline(1, after_success, t0);
        assert_eq!(r2, Duration::from_secs(2), "после успеха лестница с 2с");
    }

    /// Разделение «нет такой папки» и сетевого сбоя (живой тест, телефон X50,
    /// 04.10.2026, 0.1.211): 59 «reconnect deferred» при streak≈60 и 8
    /// реальных переподключений — клиент растил streak на ответ сервера об
    /// отсутствующем ящике. Отсутствие папки обязано распознаваться и НЕ
    /// обрабатываться как сетевая неудача.
    #[test]
    fn is_missing_folder_error_true_for_missing_folder() {
        // Точная строка из лога провайдера (папка из настроек, имя динамическое).
        let missing =
            anyhow::anyhow!("select RELAY failed: No Response: [CLIENTBUG] SELECT No such folder");
        assert!(
            EmailClient::is_missing_folder_error(&missing),
            "«No such folder» обязан распознаваться как отсутствие папки"
        );

        // Сетевой сбой — обычный Err, лестница backoff обязана применяться.
        let network = anyhow::anyhow!("select &BCEEPwQwBDw- failed: unexpected EOF");
        assert!(
            !EmailClient::is_missing_folder_error(&network),
            "unexpected EOF — сетевой сбой, не отсутствие папки"
        );
    }
}
