//! M1.9: Bridge between Desktop Tauri cmds and vault-client reusable core.
//!
//! Exposes tauri::commands for the JS frontend (features/incoming.js parity):
//! - vault_classify_incoming: classify a decrypted plaintext envelope
//! - vault_store_incoming_message: persist a classified Message in MessageStore
//! - vault_download_attachment: decrypt an EncryptedEnvelope → native file
//! - vault_save_file: save already-decrypted base64 data → native file
//!
//! State (MessageStore/AttachmentStore) инициализируется лениво и хранится в
//! Tauri State[VaultBridgeState].

use serde::Deserialize;
use std::path::PathBuf;
use vault_client::vault::AttachmentStore;
use vault_client::vault::ClassifyResult;
use vault_client::vault::MessageStore;
use vault_client::vault::VaultMessage;
// ClassifyKind нужен только тестам (test_classify_kind_display) — в прод-сборке не используется.
#[cfg(test)]
use vault_client::vault::ClassifyKind;

/// Bridge state — singleton via Tauri State.
#[derive(Default)]
pub struct VaultBridgeState {
    messages: std::sync::Mutex<MessageStore>,
}

impl VaultBridgeState {
    pub fn new() -> Self {
        Self {
            messages: std::sync::Mutex::new(MessageStore::new().unwrap_or_default()),
        }
    }

    pub fn messages(&self) -> std::sync::MutexGuard<'_, MessageStore> {
        self.messages.lock().unwrap()
    }

    pub fn attachments(&self) -> AttachmentStore {
        AttachmentStore::new().unwrap_or_default()
    }
}

/// Input for `vault_classify_incoming`.
#[derive(Debug, Deserialize)]
pub struct ClassifyInput {
    /// Sender email (canonicalized).
    pub from: String,
    /// Decrypted plaintext JSON.
    pub decrypted: String,
    /// Сырой заголовок `Date` письма (RFC 2822) или ISO relay-копии.
    /// Старые вызовы без поля не ломаются: `default` = пусто = «не свежее».
    #[serde(default)]
    pub date: String,
}

/// Convert ClassifyResult to JSON-safe Value.
fn classify_result_to_json(r: &ClassifyResult, fresh: bool) -> serde_json::Value {
    serde_json::json!({
        "kind": r.kind.to_string(),
        "msg_type": r.msg_type.as_ref().and_then(|mt| serde_json::to_value(mt).ok()),
        "env_id": r.env_id,
        "chat_key": r.chat_key,
        "title": r.title,
        // Свежесть для уведомления решает ядро (`timings::poll_fresh_at`),
        // а не фронт: политика «неизвестный Date не будит» — протокольная.
        "fresh": fresh,
    })
}

/// Классификация + свежесть как единый ответ роутеру.
///
/// `now_ms` — параметр, а не обращение к часам: тесты фиксируют время, и
/// мутация порога ловится, а не списывается на «повезло с часами».
fn classify_json(input: &ClassifyInput, now_ms: i64) -> Option<serde_json::Value> {
    let r = vault_client::vault::classify(&input.decrypted, &input.from)?;
    let fresh = vault_client::vault::timings::poll_fresh_at(&input.date, now_ms);
    Some(classify_result_to_json(&r, fresh))
}

/// Classify an incoming decrypted plaintext via core.
/// Returns JSON {kind, msg_type, env_id, chat_key, title, fresh} or null.
///
/// Классификатор чистый: ему нужны только байты письма, состояние — нет.
/// Раньше здесь создавался `MessageStore::new()`, который на КАЖДОЕ входящее
/// письмо читал `~/.vault/messages.json` с диска. Пока команда была мёртвой,
/// это было незаметно; с W1 она на горячем пути поллинга, поэтому вызов идёт
/// напрямую в `vault::classify`.
#[tauri::command]
pub async fn vault_classify_incoming(
    input: ClassifyInput,
) -> Result<Option<serde_json::Value>, String> {
    Ok(classify_json(
        &input,
        vault_client::vault::timings::now_ms(),
    ))
}

/// Снимок окон фоновой доставки — данные для фронта (ADR-005 §W4).
///
/// Мост не решает и не дублирует числа: всё приходит из
/// `vault_client::vault::timings::snapshot`. Нужен, чтобы окно свежести в
/// `features/incoming.js` перестало быть литералом, а UI мог показать
/// настоящий порог вместо копии.
#[tauri::command]
pub fn vault_timings_snapshot() -> vault_client::vault::timings::TimingsSnapshot {
    vault_client::vault::timings::snapshot()
}

/// ADR-005 R1 / W4: правило времени жизни сообщения — в Rust.
/// JS не считает «когда истечёт» сам: он получает готовые значения отсюда.
///
/// Правило состояния звонка — в ядре (ADR-005 R1 / W4).
///
/// JS не решает, «занято ли», «вытеснять ли» и «какой сигнал уходит при
/// отбое»: это протокол, и по нему фронт с ядром обязаны считать одинаково.
/// Здесь только транспорт: строка → enum → правило → строка.
///
/// Неизвестное состояние/событие трактуем как «состояние не меняется»:
/// решение не принято — значит, перехода нет.
#[tauri::command]
pub fn vault_call_next_state(current: String, event: String) -> String {
    use vault_client::vault::call_state::{next_state, CallEvent, CallState};
    let st = match CallState::from_str(&current) {
        Some(s) => s,
        None => return current,
    };
    // Имя события разбирает ядро (`CallEvent::from_name`): таблица имён —
    // протокол, и вторая её копия была бы второй версией того же контракта.
    let ev = match CallEvent::from_name(&event) {
        Some(ev) => ev,
        None => return current,
    };
    match next_state(st, ev) {
        Some(next) => next.as_str().to_string(),
        None => current,
    }
}

/// Разобрать data-письмо (download-on-demand) — ADR-005 R1 / W4.
///
/// ФОРМАТ — В ЯДРЕ: «что считается data-письмом» (`vault_dod_data` строго 1 и
/// непустое тело) решает Rust. JS получает `ref` и `data`.
#[tauri::command]
pub fn vault_parse_dod_data(plain: String) -> Option<vault_client::vault::signals::DodData> {
    vault_client::vault::signals::parse_dod_data(&plain)
}

/// Разобрать канальный конверт — ADR-005 R1 / W4.
///
/// ФОРМАТ — В ЯДРЕ: `channel === 1` и набор полей (meta/post/hello). JS
/// получает разобранные поля и применяет последствия (обновить аватар,
/// показать пост, запомнить подписчика).
#[tauri::command]
pub fn vault_parse_channel_envelope(
    plain: String,
) -> Option<vault_client::vault::channels::ChannelEnvelope> {
    vault_client::vault::channels::parse_channel_envelope(&plain)
}

/// Идентификатор сообщения из конверта — ADR-005 R1 / W4.
///
/// Правило «как вытащить id» — в ядре (envelope::id_of): значение поля `id`
/// возвращается как есть (нулевой id валиден), отсутствие поля или null —
/// пустая строка.
#[tauri::command]
pub fn vault_envelope_id(text: String) -> Option<serde_json::Value> {
    vault_client::vault::envelope::id_of(&text)
}

/// Разобрать сервисный сигнал (реакция/правка/квитанция/голос/presence/мета) —
/// ADR-005 R1 / W4.
///
/// РОУТЕР В ЯДРЕ: «что это за письмо — сообщение или служебный сигнал» решает
/// Rust (vault::signals::parse_signal). Раньше JS разбирал это сам, одинаково
/// в личных чатах и группах, и местами РАЗНЫМИ правилами (квитанцию о
/// доставке личные чаты скрывали, а групповые показывали как обычный текст).
#[tauri::command]
pub fn vault_parse_signal(plain: String) -> Option<vault_client::vault::signals::SignalEnvelope> {
    vault_client::vault::signals::parse_signal(&plain)
}

/// Собрать data-письмо (download-on-demand) — ADR-005 R1 / W4.
#[tauri::command]
pub fn vault_build_dod_data(reference: String, data: String) -> String {
    vault_client::vault::signals::build_dod_data(&reference, &data)
}

/// Сырой объект конверта (как JSON-объект, без разбора полей) — ADR-005 R1 / W4.
///
/// Релей-дубль отправки требует ОБЪЕКТ конверта (а не строку). Раньше JS
/// разбирал его сам (`JSON.parse(envelope)`) — это был разбор протокола в
/// фронте. Теперь разбор — в ядре; правила полей конверта при этом не
/// меняются: возвращается ровно тот объект, что внутри конверта.
#[tauri::command]
pub fn vault_envelope_object(text: String) -> Option<serde_json::Value> {
    vault_client::vault::envelope::raw_object(&text)
}

/// Разобрать wire-конверт сообщения (ADR-005 R1 / W4).
///
/// ПРАВИЛА РАЗБОРА — В ЯДРЕ: какие поля берутся, что считается «не наш
/// конвертом» (нет метки `vault: 1` или `text` не строка) и как устроен
/// подконверт голосования. JS получает готовые поля.
///
/// `None` — письмо не наш конверт (legacy-текст, чужой JSON, битый JSON).
#[tauri::command]
pub fn vault_parse_envelope(plain: String) -> Option<serde_json::Value> {
    use vault_client::vault::envelope::parse;
    parse(&plain).map(|fields| serde_json::to_value(fields).unwrap_or(serde_json::Value::Null))
}

/// Собрать wire-конверт сообщения (ADR-005 R1 / W4).
///
/// ФОРМАТ КОНВЕРТА — В ЯДРЕ: какие поля входят и при каких условиях.
/// JS приносит данные (id, текст, имя, аватары, ключи, ttl, ts) и получает
/// готовую строку. Пока сборка жила в App.vue, а разбор — в Rust
/// (incoming::classify), формат был описан в двух местах.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn vault_build_envelope(
    id: String,
    text: String,
    name: String,
    avatar: String,
    gavatar: Option<String>,
    key: String,
    pq_ek: Option<String>,
    tok: Option<String>,
    msg_type: Option<String>,
    ttl_secs: i64,
    ts_ms: i64,
) -> String {
    use vault_client::vault::envelope::{build, EnvelopeInput};
    build(&EnvelopeInput {
        id,
        text,
        name,
        avatar,
        gavatar,
        key,
        pq_ek,
        tok,
        msg_type,
        ttl_secs,
        ts_ms,
    })
}

/// Таблица ответов «можно ли» для всех состояний звонка — ADR-005 R1 / W4.
///
/// Одним вызовом: часть решений о состоянии читается в СИНХРОННЫХ местах
/// (шаблон компонента, fire-and-forget `hangup`, где await внутри сдвинул бы
/// сброс состояния на микротаск). Ответ зависит только от состояния, поэтому
/// JS кэширует таблицу и читает из неё — а решает по-прежнему ядро.
#[tauri::command]
pub fn vault_call_can_table() -> serde_json::Value {
    use vault_client::vault::call_state::can_table;
    serde_json::to_value(can_table()).unwrap_or(serde_json::Value::Null)
}

/// Полный словарь проводных имён протокола звонка (события и вопросы) — W4.
///
/// Зачем одним вызовом: JS-гейт `scripts/call-wire-names-gate.mjs` сверяет
/// литералы в фичах с этим словарём. Ядро печатает имена, JS только читает,
/// поэтому переименование на одной стороне не даёт «понятное JS слово,
/// которое ядро молча не заметило».
#[tauri::command]
pub fn vault_call_wire_names() -> vault_client::vault::call_state::CallWireNames {
    vault_client::vault::call_state::wire_names()
}

#[tauri::command]
pub fn vault_call_can(current: String, question: String) -> bool {
    use vault_client::vault::call_state::{can, CallQuestion, CallState};
    let st = match CallState::from_str(&current) {
        Some(s) => s,
        None => return false,
    };
    // Имя вопроса разбирает ядро: оно же их и печатает в `can_table`, поэтому
    // round-trip «напечатал ↔ прочитал» держится тестом `question_names_roundtrip`.
    let q = match CallQuestion::from_name(&question) {
        Some(q) => q,
        None => return false,
    };
    can(st, q)
}

/// Применим ли переход в текущем состоянии (решение — тоже в Rust).
#[tauri::command]
pub fn vault_call_can_apply(current: String, event: String) -> bool {
    use vault_client::vault::call_state::{can_apply, CallEvent, CallState};
    let st = match CallState::from_str(&current) {
        Some(s) => s,
        None => return false,
    };
    let ev = match CallEvent::from_name(&event) {
        Some(ev) => ev,
        None => return false,
    };
    can_apply(st, ev)
}

/// Что делать с пришедшим `call_request`: принять / проигнорировать / отказать
/// (занято) / вытеснить текущий звонок.
#[tauri::command]
pub fn vault_call_incoming_action(current: String, same_call: bool, has_current: bool) -> String {
    use vault_client::vault::call_state::{incoming_request_action, CallState};
    let st = match CallState::from_str(&current) {
        Some(s) => s,
        None => return "ignore".to_string(),
    };
    incoming_request_action(st, same_call, has_current)
        .as_str()
        .to_string()
}

/// Тип терминального сигнала при отбое: `call_end` (разговор был) или
/// `call_cancel` (звонок не состоялся).
#[tauri::command]
pub fn vault_call_hangup_signal_kind(state: String) -> String {
    use vault_client::vault::call_state::{hangup_signal_kind, CallState};
    let st = match CallState::from_str(&state) {
        Some(s) => s,
        None => return "call_cancel".to_string(),
    };
    hangup_signal_kind(st).to_string()
}

/// Можно ли начать исходящий звонок из этого состояния.
#[tauri::command]
pub fn vault_call_can_start(state: String) -> bool {
    use vault_client::vault::call_state::{can_start_outgoing, CallState};
    match CallState::from_str(&state) {
        Some(s) => can_start_outgoing(s),
        None => false,
    }
}

/// Игнорировать ли «поздний» таймаут гудка (звонок уже идёт).
#[tauri::command]
pub fn vault_call_ignore_stale_ring_timeout(state: String) -> bool {
    use vault_client::vault::call_state::{ignore_stale_ring_timeout, CallState};
    match CallState::from_str(&state) {
        Some(s) => ignore_stale_ring_timeout(s),
        None => false,
    }
}

/// Момент истечения: `base_ms + ttl_secs*1000` (0 — не исчезает).
#[tauri::command]
pub fn vault_ephemeral_expire_at(base_ms: i64, ttl_secs: i64) -> i64 {
    vault_client::vault::ephemeral::expire_at(base_ms, ttl_secs)
}

/// Истекло ли сообщение к моменту `now_ms` (`expires_at == 0` — никогда).
#[tauri::command]
pub fn vault_ephemeral_is_expired(expires_at: i64, now_ms: i64) -> bool {
    vault_client::vault::ephemeral::is_expired(expires_at, now_ms)
}

/// Сколько миллисекунд осталось до истечения (0 — истекло или не истекает).
#[tauri::command]
pub fn vault_ephemeral_remaining_ms(expires_at: i64, now_ms: i64) -> i64 {
    vault_client::vault::ephemeral::remaining_ms(expires_at, now_ms)
}

/// Payload → `VaultMessage`: контракт с JS, вынесенный из команды, чтобы его
/// можно было проверить на хосте.
///
/// Имена полей — это `JSON.stringify(cls.msg)` из `features/incoming.js:415`:
/// `id, from, to, ts, text, name, avatar, reactions, edited, replies,
/// in_reply_to, ttl`. Полный payload конверта читается тем же кодом (в мосте
/// приходят и минимум-заготовка, и полный объект).
///
/// `id` берётся по цепочке: envId из JS (кросс-канальный дедуп relay-копии и
/// email-копии) → `id` payload → legacy `message_id` → пусто.
pub fn message_from_payload(
    from: &str,
    to: &str,
    env_id: Option<&str>,
    plain: &str,
) -> Result<VaultMessage, String> {
    let p: serde_json::Value =
        serde_json::from_str(plain).map_err(|e| format!("payload parse: {}", e))?;
    let id = env_id
        .or_else(|| p.get("id").and_then(|v| v.as_str()))
        .or_else(|| p.get("message_id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();
    Ok(VaultMessage {
        id,
        from: from.to_string(),
        to: to.to_string(),
        ts: p.get("ts").and_then(|v| v.as_i64()).unwrap_or(0),
        text: p
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        name: p
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        avatar: p
            .get("avatar")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        reactions: p
            .get("reactions")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        edited: p.get("edited").and_then(|v| v.as_bool()).unwrap_or(false),
        replies: p
            .get("replies")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        in_reply_to: p
            .get("in_reply_to")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        ttl: p.get("ttl").and_then(|v| v.as_u64()),
    })
}

/// Store an incoming message (after classify confirmed kind=Message).
///
/// JS передаёт `from`, `envId`, `plain` (decrypted payload JSON) + `chatKey`.
/// Rust парсит payload и создаёт VaultMessage via store logic. Это parity
/// с CLI `messages.rs:store_incoming`.
#[tauri::command]
pub async fn vault_store_incoming_message(
    state: tauri::State<'_, VaultBridgeState>,
    from: String,
    chat_key: Option<String>,
    env_id: Option<String>,
    plain: String,
) -> Result<bool, String> {
    let vm = message_from_payload(
        &from,
        &std::env::var("VAULT_EMAIL").unwrap_or_default(),
        env_id.as_deref(),
        &plain,
    )?;
    let mut store = state.messages();
    let from = vm.from.clone();
    let stored = store.store_incoming(&from, chat_key.as_deref(), vm);
    if stored {
        if let Err(e) = store.save() {
            log::warn!("[vault_bridge] MessageStore save failed: {}", e);
        }
    }
    Ok(stored)
}

// ── Attachment download (shared vault-core unpacking path) ──────────────

/// Download (decrypt) an `EncryptedEnvelope` and write the original file to
/// the user's downloads directory.
///
/// Uses `vault_client::vault::download_file` so that the CLI and Desktop share
/// the **same** unpacking logic (envelope parse + XChaCha20-Poly1305 decrypt).
///
/// JS passes the full ASCII-armored envelope text.  Returns the absolute path
/// to the saved file, or an `Err` string on failure.
#[tauri::command]
pub async fn vault_download_attachment(
    envelope_text: String,
    #[allow(unused_variables)] output_dir: Option<PathBuf>,
    output_name: Option<String>,
) -> Result<String, String> {
    let dir: PathBuf = match &output_dir {
        Some(d) => d.clone(),
        None => dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(std::env::temp_dir),
    };
    let path =
        vault_client::vault::download_file(&envelope_text, Some(&dir), output_name.as_deref())
            .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Имя файла без путей и управляющих символов.
///
/// Имя вложения приходит из расшифрованного конверта, то есть от отправителя —
/// это НЕ доверенный ввод. `../` в имени увёл бы запись за пределы каталога
/// загрузок (`dir.join(filename)`), поэтому имя чистим до обоих путей
/// сохранения (desktop и Android). Функция чистая и тестируется на хосте.
pub fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    // `.` и `..` — не имена файлов; ведущие точки убираем, чтобы не создавать
    // скрытые файлы и не ломать MediaStore.
    let trimmed = cleaned.trim().trim_start_matches('.').trim();
    if trimmed.is_empty() {
        "file".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Decode base64 and write it to `dir/filename`, creating `dir` if needed.
///
/// Pure filesystem helper (no HOME/download-dir lookup) so the real code path
/// is unit-testable with an explicit temp dir. Имя файла санитизируется
/// (`sanitize_filename`): источник имени — отправитель вложения.
pub fn save_base64_file(
    base64_data: &str,
    filename: &str,
    dir: &std::path::Path,
) -> Result<PathBuf, String> {
    use base64::Engine as _;
    let binary = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| format!("base64 decode error: {}", e))?;

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(sanitize_filename(filename));
    std::fs::write(&path, &binary).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Save already-decrypted base64 file data to the downloads directory.
///
/// Used by the Desktop "Download" button on attachment cards and the
/// full-size image viewer.  Falls back to the browser `<a download>`
/// mechanism if the Tauri command fails.
///
/// Android: `dirs` здесь непригоден (см. `android_save`): `download_dir()`
/// = None, `home_dir()` = приватный каталог приложения, куда пользователь не
/// попадёт. Файл кладём в общие Downloads через MediaStore; если MediaStore
/// недоступен (API < 29) — откатываемся на прежний `dirs`-путь.
#[tauri::command]
pub async fn vault_save_file(
    base64_data: String,
    filename: String,
    mime_type: String,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let result = crate::android_save::save_base64_to_public_downloads(
            &base64_data,
            &filename,
            &mime_type,
        );
        match result {
            Ok(path) => return Ok(path),
            Err(e) => {
                eprintln!("[vault_save_file] MediaStore недоступен, откат на dirs: {e}");
            }
        }
    }
    let dir = dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    let path = save_base64_file(&base64_data, &filename, &dir)?;
    let _ = mime_type; // reserved for future MIME-aware handling
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_classify_kind_display() {
        assert_eq!(ClassifyKind::Message.to_string(), "message");
        assert_eq!(ClassifyKind::Presence.to_string(), "presence");
        assert_eq!(ClassifyKind::Profile.to_string(), "profile");
        assert_eq!(ClassifyKind::Call.to_string(), "call");
        assert_eq!(ClassifyKind::Unknown.to_string(), "unknown");
    }

    #[test]
    fn test_classify_result_to_json() {
        let r = ClassifyResult {
            kind: ClassifyKind::Message,
            msg_type: None,
            env_id: Some("m1".to_string()),
            chat_key: Some("alice@x".to_string()),
            title: Some("Alice".to_string()),
        };
        let v = classify_result_to_json(&r, true);
        assert_eq!(v["kind"], "message");
        assert_eq!(v["env_id"], "m1");
        assert_eq!(v["chat_key"], "alice@x");
        assert_eq!(v["fresh"], true);
    }

    /// Свежесть — это ответ ядра в том же вызове, что и тип письма.
    /// Фиксированное `now` (1700000000 = Tue, 14 Nov 2023 22:13:20 UTC):
    /// тест не зависит от часов машины.
    #[test]
    fn test_classify_json_carries_core_freshness() {
        const NOW: i64 = 1_700_000_000_000;
        let input = |date: &str| ClassifyInput {
            from: "peer@x".to_string(),
            decrypted: r#"{"vault":1,"text":"hi"}"#.to_string(),
            date: date.to_string(),
        };
        // email-копия (RFC 2822) и relay-копия (ISO) одного момента.
        assert_eq!(
            classify_json(&input("Tue, 14 Nov 2023 22:13:20 +0000"), NOW).unwrap()["fresh"],
            true
        );
        assert_eq!(
            classify_json(&input("2023-11-14T22:13:20.000Z"), NOW).unwrap()["fresh"],
            true
        );
        // 901 секунда — за окном 15 минут.
        assert_eq!(
            classify_json(&input("Tue, 14 Nov 2023 21:58:19 +0000"), NOW).unwrap()["fresh"],
            false
        );
        // Политика опроса: неизвестный Date не будит.
        assert_eq!(
            classify_json(&input("garbage"), NOW).unwrap()["fresh"],
            false
        );
        assert_eq!(classify_json(&input(""), NOW).unwrap()["fresh"], false);
        // Не наше письмо — по-прежнему null, свежесть не выдумывается.
        let not_ours = ClassifyInput {
            decrypted: "plain text".to_string(),
            ..input("")
        };
        assert!(classify_json(&not_ours, NOW).is_none());
    }

    /// Имена полей снапшота — контракт с JS: переименование превратило бы
    /// окно во фронте в `undefined` (и свежесть — в NaN-сравнение).
    #[test]
    fn test_timings_snapshot_contract() {
        let v = serde_json::to_value(vault_timings_snapshot()).unwrap();
        assert_eq!(v["freshSecs"], 15 * 60);
        assert_eq!(v["callStaleMs"], 10 * 60 * 1000);
        assert_eq!(v["ringTimeoutMs"], 45 * 1000);
        assert_eq!(v["callTombstoneMs"], 10 * 60 * 1000);
        assert_eq!(v["seenCap"], 200);
    }

    #[test]
    fn test_vault_bridge_state_new() {
        let state = VaultBridgeState::new();
        {
            let _g = state.messages();
        }
        let _ = state.attachments();
    }

    #[test]
    fn test_store_incoming_persists() {
        let tmp = std::env::temp_dir().join("m19_test_store_incoming.json");
        let _ = std::fs::remove_file(&tmp);
        let mut store = vault_client::vault::MessageStore::with_path(tmp.clone()).unwrap();
        let vm = vault_client::vault::VaultMessage {
            id: "m1".to_string(),
            from: "alice@x".to_string(),
            to: "me@x".to_string(),
            ts: 1700000000,
            text: "hello".to_string(),
            name: "Alice".to_string(),
            avatar: "".to_string(),
            reactions: vec![],
            edited: false,
            replies: vec![],
            in_reply_to: None,
            ttl: Some(0),
        };
        let from = vm.from.clone();
        assert!(store.store_incoming(&from, None, vm));
        assert!(store.save().is_ok());
        // persisted → reload
        let loaded = vault_client::vault::MessageStore::with_path(tmp).unwrap();
        assert_eq!(loaded.messages_for("alice@x", None).len(), 1);
        let _ = std::fs::remove_file(std::env::temp_dir().join("m19_test_store_incoming.json"));
    }

    #[test]
    fn test_download_attachment_roundtrip() {
        use vault_client::crypto::Encryptor;
        let enc = Encryptor::new();
        let temp = std::env::temp_dir().join("vault_bridge_dl_test");
        std::fs::create_dir_all(&temp).unwrap();
        let src = temp.join("test.txt");
        std::fs::write(&src, b"bridge test data").unwrap();
        let envelope = enc.encrypt_file(&src).unwrap();
        let _ = std::fs::remove_file(&src);

        let result = vault_client::vault::download_file(&envelope, Some(&temp), None);
        assert!(result.is_ok());
        let recovered = std::fs::read(result.unwrap()).unwrap();
        assert_eq!(recovered, b"bridge test data");
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_save_file_roundtrip() {
        use base64::Engine as _;
        // Явный temp-dir: тест не зависит от $HOME/dirs::download_dir() и не
        // гоняется с env-тестами, которые временно подменяют HOME.
        let dir = std::env::temp_dir().join(format!("vault_bridge_save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let original = b"save file test";
        let b64 = base64::engine::general_purpose::STANDARD.encode(original);

        // Реальный путь сохранения (тот же код, что зовёт Tauri-команда).
        let path = save_base64_file(&b64, "vault_test_save_file.bin", &dir).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);

        // Кривой base64 → Err, а не panic.
        assert!(save_base64_file("!!!not-base64!!!", "x.bin", &dir).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // Имя вложения приходит из расшифрованного конверта (недоверенный ввод).
    // До 19.10.2026 `save_base64_file` делал `dir.join(filename)` как есть —
    // `../../` в имени писал файл за пределами каталога загрузок.
    #[test]
    fn test_sanitize_filename_strips_paths_and_traversal() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("/sdcard/Download/a.png"), "a.png");
        assert_eq!(sanitize_filename("C:\\Users\\x\\b.txt"), "b.txt");
        assert_eq!(sanitize_filename(".."), "file");
        assert_eq!(sanitize_filename("."), "file");
        assert_eq!(sanitize_filename("   "), "file");
        assert_eq!(sanitize_filename(".hidden"), "hidden");
        assert_eq!(sanitize_filename("dod\ntest.png"), "dodtest.png");
        assert_eq!(sanitize_filename("человек.png"), "человек.png");
        assert_eq!(sanitize_filename("dodtest.png"), "dodtest.png");
    }

    #[test]
    fn test_save_file_does_not_escape_target_dir() {
        use base64::Engine as _;
        let dir =
            std::env::temp_dir().join(format!("vault_bridge_traversal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"x");

        let path = save_base64_file(&b64, "../../escaped.bin", &dir).unwrap();
        assert_eq!(path, dir.join("escaped.bin"));
        assert!(!dir.parent().unwrap().join("escaped.bin").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Контракт payload → VaultMessage (то, что вынесено из команды) ──────
    // До 19.10.2026 маппинг жил внутри `vault_store_incoming_message` и не
    // проверялся ничем: переименование поля на JS-стороне (`features/incoming.js`
    // шлёт `JSON.stringify(cls.msg)`) прошло бы молча — сообщения писались бы
    // с пустыми id/ts.

    /// Полный конверт: каждое поле доезжает до VaultMessage.
    #[test]
    fn test_message_from_payload_full() {
        let plain = r#"{"vault":1,"id":"msg-1","text":"привет","name":"Аня",
            "avatar":"data:image/png;base64,AAA","ts":1700000000,
            "reactions":["👍","❤"],"edited":true,"replies":["m0"],
            "in_reply_to":"m0","ttl":86400}"#;
        let vm = message_from_payload("alice@x", "me@x", Some("msg-1"), plain).unwrap();
        assert_eq!(vm.id, "msg-1");
        assert_eq!(vm.from, "alice@x");
        assert_eq!(vm.to, "me@x");
        assert_eq!(vm.ts, 1700000000);
        assert_eq!(vm.text, "привет");
        assert_eq!(vm.name, "Аня");
        assert!(vm.avatar.starts_with("data:image/png"));
        assert_eq!(vm.reactions, vec!["👍".to_string(), "❤".to_string()]);
        assert!(vm.edited);
        assert_eq!(vm.replies, vec!["m0".to_string()]);
        assert_eq!(vm.in_reply_to.as_deref(), Some("m0"));
        assert_eq!(vm.ttl, Some(86400));
    }

    /// Минимум, который реально шлёт `features/incoming.js:415` (текст/имя/
    /// аватар пустые — полный персист идёт другим путём). Маппинг обязан
    /// принять его без ошибок и не выдумать данные.
    #[test]
    fn test_message_from_payload_incoming_js_stub() {
        let plain = r#"{"id":"uid-1|INBOX","from":"alice@x","to":"me@x",
            "ts":1700000123456,"text":"","name":"","avatar":"",
            "reactions":[],"edited":false,"replies":[],"in_reply_to":null,"ttl":null}"#;
        let vm = message_from_payload("alice@x", "me@x", Some("uid-1|INBOX"), plain).unwrap();
        assert_eq!(vm.id, "uid-1|INBOX");
        assert_eq!(vm.ts, 1700000123456);
        assert_eq!(vm.text, "");
        assert_eq!(vm.name, "");
        assert_eq!(vm.reactions.len(), 0);
        assert!(!vm.edited);
        assert_eq!(vm.in_reply_to, None);
        assert_eq!(vm.ttl, None);
    }

    /// Цепочка id: envId из JS важнее `payload.id` (дедуп relay-копии и
    /// email-копии одного сообщения), затем legacy `message_id`, иначе пусто.
    #[test]
    fn test_message_from_payload_id_chain() {
        let with_both = r#"{"id":"from-payload"}"#;
        assert_eq!(
            message_from_payload("a@x", "m@x", Some("from-js"), with_both)
                .unwrap()
                .id,
            "from-js"
        );
        assert_eq!(
            message_from_payload("a@x", "m@x", None, with_both)
                .unwrap()
                .id,
            "from-payload"
        );
        let legacy = r#"{"message_id":"legacy-1"}"#;
        assert_eq!(
            message_from_payload("a@x", "m@x", None, legacy).unwrap().id,
            "legacy-1"
        );
        assert_eq!(
            message_from_payload("a@x", "m@x", None, "{}").unwrap().id,
            ""
        );
    }

    /// Не-JSON — ошибка: сообщение не должно сохраниться «молча с пустым id».
    #[test]
    fn test_message_from_payload_rejects_non_json() {
        let err = message_from_payload("a@x", "m@x", None, "просто текст").unwrap_err();
        assert!(
            err.starts_with("payload parse:"),
            "неожиданная ошибка: {err}"
        );
    }
}
