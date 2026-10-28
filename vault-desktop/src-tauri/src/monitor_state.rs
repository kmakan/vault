// Состояние headless-монитора: очередь доставки уведомлений, дедуп
// доставленного, машина состояний входящего звонка, форма адреса.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ. `service_monitor.rs` целиком заперт в
// `#[cfg(target_os = "android")]`: его JNI-входы вызываются из
// VaultForegroundService. Значит с хоста он НЕ КОМПИЛИРУЕТСЯ — ни одного
// теста, и `rust-mutation-gate` его не видит: 1509 строк кода, которое
// определяет «пришли ли уведомления при смахнутом приложении», ничего не
// измеряли (очередь моста #13). Здесь лежит ровно то, что работает БЕЗ JNI:
// формы ключей kv, отсечка seen-списка, порядок pending-очереди, TTL
// надгробий, нормализация отправителя, распознавание группового приглашения.
// Перенос ничего не меняет в поведении — он делает поведение ИЗМЕРИМЫМ.
// Единственная правка поведения: перевод urlSafe-алфавита в `is_group_invite`,
// который первая же проба с хоста показала битым в выпущенном коде.
//
// ГДЕ ПРАВИЛО. Числа окон и сами предикаты времени живут в ядре
// (`vault::timings`, `vault::call_record`) — там же и меряются. Этот модуль
// держит ПРОВОДКУ: что мост отдаёт ядру, что сохраняет в kv и в каком
// порядке очередь читается обратно. Дефект проводки выглядит на телефоне как
// «уведомления дублируются» / «письмо пропало» / «звонок звонит заново».

use std::sync::{Arc, Mutex};

use vault_client::vault::call_record;
use vault_client::vault::identity;
use vault_client::vault::timings::{date_fresh, dedup_cut, now_ms, CALL_TOMBSTONE_MS, SEEN_CAP};

use crate::email::EmailMessage;

/// Попыток доставки письма до отрицательного дедупа. Третья неудача — это не
/// «письмо плохое», это «мы его достать не можем»: письмо уходит в seen, чтобы
/// не тревожить его бесконечно, и больше никогда не будет показано.
pub(crate) const MAX_TRIES: u32 = 3;

/// Запись pending-очереди: письмо, КОТОРОЕ ЕЩЁ НЕ ДОСТАВЛЕНО.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct PendingEntry {
    pub mid: String,  // Message-ID (или from|folder|uid для писем без него)
    pub from: String, // отправитель (нормализованный, см. ingest)
    pub folder: String,
    pub uid: String,
    pub tries: u32,
}

/// ─────────── Машина состояний входящего звонка ───────────
/// Владелец состояния — монитор (call_state в kv monitor.db). call_id —
/// первичный ключ. Инварианты: один call_id = один рингтон за всё время;
/// решение (accepted/rejected) необратимо до ended; ретрансляции call_request
/// того же call_id НЕ перезапускают рингтон и НЕ создают «новых звонков»
/// (корень «телефон звонит заново после отклонения»).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct CallEntry {
    pub state: String,   // ringing | accepted | rejected | missed | ended
    pub caller: String,  // имя звонящего (для уведомления)
    pub email: String,   // адрес звонящего (для call_accept/reject письма)
    pub updated_at: i64, // ms, для TTL-чистки
}

type Db = Arc<Mutex<crate::storage::sqlite::Storage>>;

fn kv_json<T: serde::Serialize + serde::de::DeserializeOwned>(
    db: &Db,
    account: &str,
    key: &str,
) -> T
where
    T: Default,
{
    db.lock()
        .ok()
        .and_then(|g| g.kv_get(account, key).ok().flatten())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn kv_save<T: serde::Serialize>(db: &Db, account: &str, key: &str, val: &T) {
    if let Ok(json) = serde_json::to_string(val) {
        if let Ok(g) = db.lock() {
            let _ = g.kv_set(account, key, &json);
        }
    }
}

fn seen_key() -> String {
    "notify_seen".to_string()
}

fn pending_key() -> String {
    "notify_pending".to_string()
}

/// seen-дедуп: только ДОСТАВЛЕННЫЕ/окончательно отброшенные Message-ID.
pub(crate) fn seen_contains(db: &Db, account: &str, mid: &str) -> bool {
    let list: Vec<String> = kv_json(db, account, &seen_key());
    list.iter().any(|x| x == mid)
}

pub(crate) fn seen_push(db: &Db, account: &str, mid: &str) {
    let mut list: Vec<String> = kv_json(db, account, &seen_key());
    if list.iter().any(|x| x == mid) {
        return;
    }
    list.push(mid.to_string());
    let cut = dedup_cut(list.len(), SEEN_CAP);
    let list = list.split_off(cut);
    kv_save(db, account, &seen_key(), &list);
}

pub(crate) fn pending_list(db: &Db, account: &str) -> Vec<PendingEntry> {
    kv_json(db, account, &pending_key())
}

pub(crate) fn pending_save(db: &Db, account: &str, list: &[PendingEntry]) {
    kv_save(db, account, &pending_key(), &list);
}

pub(crate) fn remove_pending(db: &Db, account: &str, mid: &str) {
    let list = pending_list(db, account);
    let kept: Vec<PendingEntry> = list.into_iter().filter(|e| e.mid != mid).collect();
    pending_save(db, account, &kept);
}

fn call_state_key() -> String {
    "call_state".to_string()
}

/// Загрузить всю таблицу call_state (kv JSON: call_id → CallEntry).
pub(crate) fn calls_load(db: &Db, account: &str) -> std::collections::HashMap<String, CallEntry> {
    kv_json(db, account, &call_state_key())
}

/// Сохранить таблицу call_state c TTL-чисткой надгробий.
pub(crate) fn calls_save(
    db: &Db,
    account: &str,
    calls: &std::collections::HashMap<String, CallEntry>,
) {
    let now = now_ms();
    let live: std::collections::HashMap<String, CallEntry> = calls
        .iter()
        .filter(|(_, c)| {
            call_record::record_survives(&c.state, c.updated_at, now, CALL_TOMBSTONE_MS)
        })
        .map(|(k, c)| (k.clone(), c.clone()))
        .collect();
    kv_save(db, account, &call_state_key(), &live);
}

/// Установить состояние звонка (безусловно — владелец здесь).
pub(crate) fn call_set_state(db: &Db, account: &str, call_id: &str, state: &str, caller: &str) {
    if call_id.is_empty() {
        return;
    }
    let mut calls = calls_load(db, account);
    let entry = calls
        .entry(call_id.to_string())
        .or_insert_with(|| CallEntry {
            state: state.to_string(),
            caller: caller.to_string(),
            email: String::new(),
            updated_at: now_ms(),
        });
    entry.state = state.to_string();
    entry.updated_at = now_ms();
    if !caller.is_empty() {
        entry.caller = caller.to_string();
    }
    calls_save(db, account, &calls);
}

pub(crate) fn call_get_state(db: &Db, account: &str, call_id: &str) -> Option<CallEntry> {
    calls_load(db, account).get(call_id).cloned()
}

/// Новое письмо из fetch_newer: пре-фильтры → pending-очередь.
/// Сообщения от ОДНОГО отправителя при включённом ephemeral не сливаются:
/// Message-ID уникален у каждого письма.
pub(crate) fn ingest(db: &Db, account: &str, m: &EmailMessage) {
    // Дешёвый пре-фильтр по Date: старьё не трогаем вовсе.
    if !date_fresh(&m.date) {
        return;
    }
    let message_id = if m.message_id.is_empty() {
        format!("{}|{}|{}", m.from, m.folder, m.id)
    } else {
        m.message_id.clone()
    };
    // Уже доставляли (или окончательно сдались) — мимо.
    if seen_contains(db, account, &message_id) {
        return;
    }
    let mut list = pending_list(db, account);
    if list.iter().any(|e| e.mid == message_id) {
        return; // уже в очереди
    }
    list.push(PendingEntry {
        mid: message_id,
        // Форма адреса — из ядра: очередь расшифровки и карта контактов
        // должны ключеваться одинаково, иначе письмо от контакта с
        // обрамляющим пробелом («не тот регистр») не находит свой ключ.
        from: identity::normalize(&m.from),
        folder: m.folder.clone(),
        uid: m.id.clone(),
        tries: 0,
    });
    pending_save(db, account, &list);
}

/// Приглашение в группу: тело = НЕзашифрованный urlSafeB64-JSON
/// `{kind:'group-invite', …}`. Конвертом он не является, расшифровка его не
/// берёт, и без этого распознавания письмо молча умирало как нечитаемое —
/// ни уведомления при смахнутом приложении, ни следа.
///
/// Детект ДО расшифровки. Форма тела (переносы транспорта, QP, url-safe
/// алфавит, padding) — правило ЯДРА (`crypto::decode_url_safe_text`): здесь
/// больше нет своей копии. Копия разъезжалась молча — `replace(['-', '_'],
/// "+/")` подставлял ВСЮ строку на каждый символ и портил ровно то тело, ради
/// которого перевод и делался (ADR-005, t_7d2c1bb1).
pub(crate) fn is_group_invite(body: &str) -> bool {
    vault_client::crypto::decode_url_safe_text(body)
        .ok()
        .and_then(|txt| serde_json::from_str::<serde_json::Value>(&txt).ok())
        .map(|v| v.get("kind").and_then(|k| k.as_str()) == Some("group-invite"))
        .unwrap_or(false)
}

/// Публичный ключ, выведенный из приватного (оба — hex). `None`, если приват
/// не читается как 32 байта: монитор тогда не может отличить «письмо от себя»
/// и не обязан угадывать.
///
/// Вывод живёт здесь, потому что он нужен и эхо-защите (не уведомлять о
/// письмах, которые я отправил сам), и диагностике в логе («монитор читает
/// чужой keypair.json»). Две копии этой формулы внутри
/// `#[cfg(target_os = "android")]` модуля не измерялись с хоста ничем.
pub(crate) fn derived_public_hex(private_key_hex: &str) -> Option<String> {
    use x25519_dalek::{PublicKey, StaticSecret};
    let bytes = hex::decode(private_key_hex).ok()?;
    let arr = <[u8; 32]>::try_from(bytes.as_slice()).ok()?;
    Some(
        PublicKey::from(&StaticSecret::from(arr))
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// Префикс ключа для лога: 16 hex-символов. Целый ключ в logcat не печатаем,
/// а обрезок по неправильной границе ломал бы строку (здесь hex — ASCII).
pub(crate) fn key_fingerprint_prefix(hex_key: &str) -> &str {
    &hex_key[..16.min(hex_key.len())]
}

/// Маркер «нашего» конверта: `vault` строго 1. Не-1 — письмо не наше:
/// показывать его как сообщение Vault нельзя, но и тревожить повторной
/// попыткой незачем (оно доставлено «в никуда»).
pub(crate) fn is_vault_envelope(env: &serde_json::Value) -> bool {
    env.get("vault").and_then(|v| v.as_i64()) == Some(1)
}

/// Порядок перебора ключей при расшифровке входящего письма:
/// ключ отправителя → свой ключ (письма себе шифруются своим) → остальные
/// контакты, кроме уже пробованного отправителя. Страховой перебор —
/// подстраховка для нестандартных сценариев (смена ключа у контакта).
///
/// Порядок был написан прямо в monitors-цикле; здесь он измеряется, потому что
/// ошибка в нём — «письмо не расшифровывается, хотя ключ есть», то есть
/// молчаливо пропавшее уведомление.
pub(crate) fn decrypt_order<'a>(
    peers: &'a std::collections::HashMap<String, String>,
    from: &str,
) -> Vec<Option<&'a str>> {
    let mut order: Vec<Option<&'a str>> = Vec::with_capacity(peers.len() + 1);
    if let Some(key) = peers.get(from) {
        order.push(Some(key.as_str()));
    }
    order.push(None);
    for (email, key) in peers {
        if email == from {
            continue;
        }
        order.push(Some(key.as_str()));
    }
    order
}

/// Отправителя нет среди контактов: расшифровка ему недоступна ни при какой
/// удаче, и ретраи только крутят очередь.
pub(crate) fn unknown_sender(
    peers: &std::collections::HashMap<String, String>,
    from: &str,
) -> bool {
    !peers.contains_key(from)
}

/// ─────────────── Что делать с записью после неудачной попытки ───────────────
///
/// Политика «сколько раз пробовать и когда сдаться» жила прямо в
/// `service_monitor.rs`, где с хоста она не компилируется. Цена ошибки на
/// телефоне: сдался раньше — письмо никогда не будет показано; не сдаётся
/// никогда — очередь крутится бесконечно и греет батарею.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetryEffect {
    /// Ещё одна попытка на следующем тике.
    Again,
    /// Попытки исчерпаны: письмо уходит в seen и исчезает из pending.
    GiveUp,
}

/// `tries` — счётчик ПОСЛЕ увеличения (так его ведёт очередь).
pub(crate) fn retry_effect(tries: u32) -> RetryEffect {
    if tries >= MAX_TRIES {
        RetryEffect::GiveUp
    } else {
        RetryEffect::Again
    }
}

/// Файл базы монитора. Правило лежит здесь, потому что в мониторе оно
/// повторялось трижды (старт, цикл, отправка SOS), а расхождение в имени
/// каталога означало бы «две разные базы» — курсоры и дедуп живут в одной.
///
/// `data_local` — `dirs::data_local_dir()` (на Android это каталог приложения,
/// HOME в сервис-процессе недостоверен); если каталога нет — прежний
/// фолбэк `$HOME/monitor.db`.
pub(crate) fn monitor_db_path(
    data_local: Option<std::path::PathBuf>,
    home: &str,
) -> std::path::PathBuf {
    match data_local {
        Some(dir) => dir.join("com.vault.vault").join("monitor.db"),
        None => std::path::Path::new(home).join("monitor.db"),
    }
}

/// Что показать системным уведомлением по разобранному конверту.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Notice {
    pub title: String,
    pub text: String,
}

/// Текст уведомления о групповом приглашении (тело письма не расшифровано,
/// показывать нечего — только объяснение, что открыть).
pub(crate) fn group_invite_notice(from: &str) -> Notice {
    Notice {
        title: from.to_string(),
        text: "приглашение в группу — откройте Vault, чтобы принять".to_string(),
    }
}

/// Текст уведомления о пропущенном звонке. Правило было продублировано в
/// двух местах монитора (таймаут ринга и несостоявшийся показ через JNI), и
/// каждое из них могло разъехаться с другим.
pub(crate) fn missed_call_notice(who: &str) -> Notice {
    Notice {
        title: who.to_string(),
        text: "Пропущенный звонок Vault".to_string(),
    }
}

/// Правило «что именно показать» для доставленного конверта. Жило внутри
/// `service_monitor.rs` — то есть не измерялось ничем, а ошибка в нём
/// выглядит на телефоне как «уведомление пришло пустое» или «SOS пришёл
/// обычным сообщением».
///
/// * `type: "sos"` — заголовок `🚨 SOS: <имя, а если его нет — адрес>`,
///   текст из конверта, а если поля нет — «Телефон не у меня»;
/// * `type: "profile"` или пустой `text` — `None`: уведомление НЕ показываем
///   (квитанции и рассылки профиля доставляются «в никуда»);
/// * остальное — заголовок: имя отправителя, если оно непустое, иначе адрес.
///
/// Две правки поведения относительно прежнего кода (обе — «раньше было
/// пусто»): у SOS с пустым именем (`name: ""` — так шлёт JS) в заголовке
/// теперь адрес отправителя, а не пустое место; у SOS с пустым текстом
/// показывается дефолтная фраза, а не пустое уведомление.
pub(crate) fn notice_for(env: &serde_json::Value, typ: &str, from: &str) -> Option<Notice> {
    let name = env.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let text = env.get("text").and_then(|v| v.as_str()).unwrap_or("");
    if typ == "sos" {
        let who = if name.is_empty() { from } else { name };
        let body = if text.is_empty() {
            "Телефон не у меня"
        } else {
            text
        };
        return Some(Notice {
            title: format!("🚨 SOS: {who}"),
            text: body.to_string(),
        });
    }
    if typ == "profile" || text.is_empty() {
        return None;
    }
    Some(Notice {
        title: if name.is_empty() {
            from.to_string()
        } else {
            name.to_string()
        },
        text: text.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage(dir: &std::path::Path) -> Db {
        Arc::new(Mutex::new(
            crate::storage::sqlite::Storage::open(Some(&dir.join("monitor.db")))
                .expect("тестовая база монитора открыта"),
        ))
    }

    const ME: &str = "me@post.ru";

    /// Тестовая база под ЕДИНЫМ env-замком крейта: каталог БД редиректится,
    /// живая база разработчика не трогается.
    fn with_db<T>(f: impl FnOnce(&Db) -> T) -> T {
        let _guard = crate::env_test_guard();
        let dir = std::env::temp_dir().join(format!("svc-state-{}-{}", std::process::id(), {
            static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        }));
        std::fs::create_dir_all(&dir).expect("каталог создан");
        let db = storage(&dir);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&db)));
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{}", dir.display(), suffix));
        }
        let _ = std::fs::remove_dir_all(&dir);
        match r {
            Ok(v) => v,
            Err(_) => panic!("монитор упал паникой вместо отказа"),
        }
    }

    fn msg(from: &str, mid: &str, date: &str) -> EmailMessage {
        EmailMessage {
            id: "42".to_string(),
            from: from.to_string(),
            to: String::new(),
            subject: String::new(),
            date: date.to_string(),
            is_read: false,
            folder: "INBOX".to_string(),
            message_id: mid.to_string(),
            size: 0,
        }
    }

    fn fresh_date() -> String {
        // Дата в формате письма, которую ядро считает свежей.
        chrono::Utc::now().to_rfc2822()
    }

    #[test]
    fn seen_roundtrip_reads_back_the_key_it_wrote() {
        with_db(|db| {
            assert!(
                !seen_contains(db, ME, "m1"),
                "пустой seen не должен помнить"
            );
            seen_push(db, ME, "m1");
            assert!(
                seen_contains(db, ME, "m1"),
                "записанное читается тем же ключом"
            );
            assert!(!seen_contains(db, ME, "m2"), "чужой mid не подмешивается");
        });
    }

    #[test]
    fn seen_is_per_account() {
        with_db(|db| {
            seen_push(db, ME, "m1");
            assert!(
                !seen_contains(db, OTHER, "m1"),
                "seen другого аккаунта не должен влиять на этот"
            );
        });
    }

    #[test]
    fn seen_push_does_not_repeat_a_message_id() {
        with_db(|db| {
            seen_push(db, ME, "m1");
            seen_push(db, ME, "m1");
            let list: Vec<String> = kv_json(db, ME, &seen_key());
            assert_eq!(list.len(), 1, "повтор не плодит запись");
        });
    }

    #[test]
    fn seen_keeps_the_newest_and_drops_the_oldest() {
        with_db(|db| {
            for i in 0..(SEEN_CAP + 5) {
                seen_push(db, ME, &format!("m{i}"));
            }
            let list: Vec<String> = kv_json(db, ME, &seen_key());
            assert_eq!(list.len(), SEEN_CAP, "отсечка держит ровно лимит");
            assert_eq!(list.last().unwrap(), &format!("m{}", SEEN_CAP + 4));
            assert!(
                !list.contains(&"m0".to_string()),
                "старое должно уходить, а не новое"
            );
        });
    }

    #[test]
    fn broken_seen_row_is_empty_list_not_a_crash() {
        with_db(|db| {
            {
                let g = db.lock().unwrap();
                g.kv_set(ME, &seen_key(), "{ это не json").unwrap();
            }
            assert!(
                !seen_contains(db, ME, "m1"),
                "битая строка = пустой дедуп, а не паника"
            );
            seen_push(db, ME, "m1");
            assert!(seen_contains(db, ME, "m1"), "после записи дедуп жив");
        });
    }

    #[test]
    fn pending_preserves_order_and_tries() {
        with_db(|db| {
            let mut list = vec![entry("m1", 0), entry("m2", 1)];
            pending_save(db, ME, &list);
            let back = pending_list(db, ME);
            assert_eq!(back.len(), 2);
            assert_eq!(back[0].mid, "m1", "очередь читается в том же порядке");
            assert_eq!(back[1].tries, 1, "счётчик попыток сохраняется");
            // порядок — это не косметика: drain берёт ПЕРВУЮ запись
            list.insert(0, entry("m0", 0));
            pending_save(db, ME, &list);
            assert_eq!(pending_list(db, ME)[0].mid, "m0");
        });
    }

    #[test]
    fn remove_pending_drops_only_the_named_message() {
        with_db(|db| {
            pending_save(
                db,
                ME,
                &vec![entry("m1", 0), entry("m2", 0), entry("m3", 0)],
            );
            remove_pending(db, ME, "m2");
            let left: Vec<String> = pending_list(db, ME).into_iter().map(|e| e.mid).collect();
            assert_eq!(left, vec!["m1".to_string(), "m3".to_string()]);
        });
    }

    #[test]
    fn ingest_queues_a_fresh_message_and_counts_no_tries() {
        with_db(|db| {
            ingest(db, ME, &msg("peer@post.ru", "m1", &fresh_date()));
            let list = pending_list(db, ME);
            assert_eq!(list.len(), 1);
            assert_eq!(list[0].mid, "m1");
            assert_eq!(list[0].tries, 0, "новое письмо не наследует попытки");
            assert_eq!(list[0].folder, "INBOX");
        });
    }

    #[test]
    fn ingest_skips_stale_by_date() {
        with_db(|db| {
            ingest(
                db,
                ME,
                &msg("peer@post.ru", "m-old", "Mon, 01 Jan 2024 00:00:00 +0000"),
            );
            assert!(
                pending_list(db, ME).is_empty(),
                "старьё не должно вставать в очередь"
            );
        });
    }

    #[test]
    fn ingest_makes_a_synthetic_key_when_message_id_missing() {
        with_db(|db| {
            let mut m = msg("peer@post.ru", "", &fresh_date());
            m.id = "77".to_string();
            ingest(db, ME, &m);
            let list = pending_list(db, ME);
            assert_eq!(
                list[0].mid, "peer@post.ru|INBOX|77",
                "письмо без Message-ID не должно сливаться с соседним"
            );
        });
    }

    #[test]
    fn ingest_stores_sender_in_canonical_form() {
        with_db(|db| {
            // Форма адреса — из ядра: очередь расшифровки и карта контактов
            // ключуются одинаково, иначе письмо «от контакта с пробелом» не
            // находит свой ключ.
            ingest(db, ME, &msg(" Peer@Post.RU ", "m1", &fresh_date()));
            let list = pending_list(db, ME);
            assert_eq!(list[0].from, identity::normalize(" Peer@Post.RU "));
            assert_eq!(list[0].from, list[0].from.trim(), "пробелов не осталось");
        });
    }

    #[test]
    fn ingest_ignores_seen_and_already_queued() {
        with_db(|db| {
            let date = fresh_date();
            ingest(db, ME, &msg("peer@post.ru", "m1", &date));
            ingest(db, ME, &msg("peer@post.ru", "m1", &date));
            assert_eq!(pending_list(db, ME).len(), 1, "дубль в очередь не встаёт");
            remove_pending(db, ME, "m1");
            seen_push(db, ME, "m1");
            ingest(db, ME, &msg("peer@post.ru", "m1", &date));
            assert!(
                pending_list(db, ME).is_empty(),
                "доставленное письмо не тревожит второй раз"
            );
        });
    }

    #[test]
    fn call_state_roundtrip_and_tombstone() {
        with_db(|db| {
            call_set_state(db, ME, "c1", "ringing", "Петя");
            let c = call_get_state(db, ME, "c1").expect("состояние звонка прочитано");
            assert_eq!(c.state, "ringing");
            assert_eq!(c.caller, "Петя");

            // Решение older-надгробие: rejected живёт tombstone-окно.
            let old = now_ms() - (CALL_TOMBSTONE_MS / 2);
            let mut calls = calls_load(db, ME);
            calls.insert(
                "c2".to_string(),
                CallEntry {
                    state: "rejected".to_string(),
                    caller: "Вася".to_string(),
                    email: String::new(),
                    updated_at: old,
                },
            );
            calls_save(db, ME, &calls);
            assert!(
                call_get_state(db, ME, "c2").is_some(),
                "свежее надгробие обязано пережить позднюю ретрансляцию"
            );

            let dead = now_ms() - CALL_TOMBSTONE_MS - 60_000;
            let mut calls = calls_load(db, ME);
            calls.insert(
                "c3".to_string(),
                CallEntry {
                    state: "ended".to_string(),
                    caller: "Яша".to_string(),
                    email: String::new(),
                    updated_at: dead,
                },
            );
            calls_save(db, ME, &calls);
            assert!(
                call_get_state(db, ME, "c3").is_none(),
                "просроченное надгробие вычищается, иначе таблица растёт вечно"
            );
        });
    }

    #[test]
    fn empty_call_id_creates_no_state() {
        with_db(|db| {
            call_set_state(db, ME, "", "ringing", "Петя");
            assert!(
                calls_load(db, ME).is_empty(),
                "пустой call_id не должен порождать запись"
            );
        });
    }

    #[test]
    fn state_transition_moves_the_clock_of_an_old_record() {
        with_db(|db| {
            // Запись «звонка, который начался давно»: ringing TTL не истекает
            // вовсе (правило в ядре), поэтому время можно отмотать. Переход в
            // завершённое состояние обязан продлить отметку — иначе сохранение
            // тут же чистит запись по просроченному надгробию, и на телефоне
            // это «звонок зазвонил заново после ответа».
            call_set_state(db, ME, "c1", "ringing", "Петя");
            let mut calls = calls_load(db, ME);
            calls.get_mut("c1").expect("ringing записан").updated_at =
                now_ms() - (CALL_TOMBSTONE_MS + 60_000);
            calls_save(db, ME, &calls);
            assert!(
                call_get_state(db, ME, "c1").is_some(),
                "гудящий звонок не чистится по возрасту"
            );

            call_set_state(db, ME, "c1", "ended", "");
            assert!(
                call_get_state(db, ME, "c1").is_some(),
                "переход продлевает жизнь записи, а не чистит её по старому времени"
            );
        });
    }

    #[test]
    fn later_update_without_name_keeps_the_known_caller() {
        with_db(|db| {
            call_set_state(db, ME, "c1", "ringing", "Петя");
            call_set_state(db, ME, "c1", "accepted", "");
            let c = call_get_state(db, ME, "c1").unwrap();
            assert_eq!(c.state, "accepted");
            assert_eq!(
                c.caller, "Петя",
                "имя звонящего не стирается пустой строкой"
            );
        });
    }

    #[test]
    fn group_invite_is_detected_through_folding_and_urlsafe_alphabet() {
        use base64::Engine as _;
        let json = r#"{"kind":"group-invite","group_name":"Клуб","sender_name":"Петя"}"#;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes());
        assert!(is_group_invite(&b64), "приглашение распознаётся");

        // Письмо фолдится по 76 символов с переводами строк.
        let folded = b64
            .as_bytes()
            .chunks(76)
            .map(|c| String::from_utf8_lossy(c).into_owned())
            .collect::<Vec<_>>()
            .join("\r\n ");
        assert!(is_group_invite(&folded), "folding не ломает распознавание");

        // Тело, где urlSafe-алфавит ОТЛИЧАЕТСЯ от стандартного (в конверте встал
        // символ, которым кодируются `+`/`/`), и длина не кратна 4 — без перевода
        // алфавита и без добивки padding декод падает, и приглашение молча
        // гибнет как нечитаемое. Сама фикстура проверена: если её заменить на
        // «удобную», проба станет пустой, а не зелёной.
        let awkward_json = r#"{"kind":"group-invite","to":"Клубок"}"#;
        let awkward = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(awkward_json);
        assert!(
            awkward.contains(['-', '_']),
            "фикстура без urlSafe-символа ничего не меряет"
        );
        assert!(
            awkward.len() % 4 != 0,
            "фикстура без нехватки padding ничего не меряет"
        );
        assert!(
            is_group_invite(&awkward),
            "приглашение читается и в такой форме"
        );

        // Транспорт может QP-кодировать padding (`=` → `=3D`). QP-проход —
        // часть правила ЯДРА; копия «снять пробелы + добить padding» его не
        // читает, и этот кейс ловит возврат копии в модуль.
        let padded = format!("{}{}", awkward, "=".repeat(4 - awkward.len() % 4));
        let qp = padded.replace('=', "=3D");
        assert!(qp.contains("=3D"), "фикстура без QP-экранирования ничего не меряет");
        assert!(
            is_group_invite(&qp),
            "QP-экранирование тела не ломает распознавание"
        );

        assert!(
            !is_group_invite(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(r#"{"kind":"vault-message","text":"привет"}"#)
            ),
            "другой kind — не приглашение"
        );
        assert!(
            !is_group_invite("это не base64 вообще: @@ @@ @@"),
            "мусорное тело не должно считаться приглашением"
        );
        assert!(
            !is_group_invite(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"kind":123}"#)
            ),
            "kind не строка — не приглашение"
        );
    }

    /// Приватный ключ из другого набора проб (channel_signing) — синтетический,
    /// публичная часть замерена один раз и записана литералом.
    const KAT_PRIV: &str =
        "0101010101010101010101010101010101010101010101010101010101010101";
    const KAT_PUB: &str =
        "a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209";
    const PEER_PRIV: &str =
        "aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55aa55";
    const PEER: &str = "petya@post.ru";

    #[test]
    fn public_key_is_derived_by_the_formula_the_echo_guard_relies_on() {
        // Литерал, а не «сравни с самим собой»: эхо-защита сравнивает выведенный
        // публичный ключ с ключом в конверте. Ошибка в выводе (байты наоборот,
        // base16 вместо hex, молчаливый 0-ключ) на телефоне выглядит так: либо
        // «моё письмо показалось чужим» (ложный пуш от себя), либо «чужое
        // письмо показалось своим» (уведомление пропало).
        assert_eq!(derived_public_hex(KAT_PRIV).as_deref(), Some(KAT_PUB));
        let other = derived_public_hex(PEER_PRIV).expect("второй ключ выведен");
        assert_ne!(other, KAT_PUB, "разные приваты дают разные публичные");
        assert_eq!(other.len(), 64, "публичный ключ — 32 байта в hex");
        // Ключ из другой формы (верхний регистр) выводится тем же значением:
        // конверт может прислать hex в любом регистре.
        assert_eq!(
            derived_public_hex(&KAT_PRIV.to_uppercase()).as_deref(),
            Some(KAT_PUB)
        );
    }

    #[test]
    fn unreadable_private_key_derives_nothing() {
        // None, а не паника и не нулевой ключ: монитор без вывода не может
        // отличить письмо от себя и не обязан угадывать.
        assert_eq!(derived_public_hex(""), None);
        assert_eq!(derived_public_hex("не hex!!"), None);
        assert_eq!(
            derived_public_hex(&KAT_PRIV[..62]),
            None,
            "31 байт — не ключ, вывод не должен состояться"
        );
        assert_eq!(
            derived_public_hex(&format!("{KAT_PRIV}00")),
            None,
            "33 байта — тоже не ключ"
        );
    }

    #[test]
    fn log_fingerprint_is_sixteen_chars_and_never_panics_on_short_input() {
        // Логи уходят в logcat: целый ключ печатать нельзя, а обрезок по
        // негранице ломал бы строку. Длина отпечатка — правило, а не косметика.
        assert_eq!(key_fingerprint_prefix(KAT_PUB), &KAT_PUB[..16]);
        assert_eq!(key_fingerprint_prefix(KAT_PUB).len(), 16);
        assert_eq!(key_fingerprint_prefix("abc"), "abc", "короткий вход целым");
        assert_eq!(key_fingerprint_prefix(""), "");
    }

    #[test]
    fn envelope_marker_is_the_integer_one_and_nothing_else() {
        let yes = serde_json::json!({"vault": 1, "text": "привет"});
        let no = serde_json::json!({"vault": 2, "text": "привет"});
        assert!(is_vault_envelope(&yes));
        assert!(!is_vault_envelope(&no), "другой маркер — не наше письмо");
        assert!(
            !is_vault_envelope(&serde_json::json!({"text": "привет"})),
            "без маркера — не наше"
        );
        assert!(
            !is_vault_envelope(&serde_json::json!({"vault": "1"})),
            "строка «1» — не маркер"
        );
        assert!(
            !is_vault_envelope(&serde_json::json!({"vault": 1.0})),
            "вещественный 1.0 не принимаем вслепую"
        );
    }

    #[test]
    fn decrypt_order_tries_sender_then_self_then_the_rest_without_the_sender() {
        // Ошибка в порядке = «письмо не расшифровывается, хотя ключ есть»:
        // уведомление молча пропадает, и на телефоне это не отличить от
        // недоставленного письма.
        let mut peers = std::collections::HashMap::new();
        peers.insert(PEER.to_string(), "pk-peer".to_string());
        peers.insert(OTHER.to_string(), "pk-other".to_string());
        let order = decrypt_order(&peers, PEER);
        assert_eq!(order.len(), 3, "ключ отправителя + свой + один остаток");
        assert_eq!(order[0], Some("pk-peer"), "сначала ключ отправителя");
        assert_eq!(order[1], None, "письма себе шифруются своим ключом");
        assert_eq!(order[2], Some("pk-other"), "остаток — чужой ключ");
        // Отправителя нет среди контактов: первым всё равно идёт свой ключ, но
        // страховой перебор обязан попробовать ВСЕХ контактов — так ведёт себя
        // письмо от контакта, у которого ключ сменился.
        let stranger = decrypt_order(&peers, "guest@post.ru");
        assert_eq!(stranger.len(), 3, "self-ключ плюс оба контакта");
        assert_eq!(stranger[0], None, "незнакомцу первым идёт self-ключ");
        let mut rest: Vec<&str> = stranger[1..].iter().map(|k| k.unwrap()).collect();
        rest.sort_unstable();
        assert_eq!(
            rest,
            vec!["pk-other", "pk-peer"],
            "перебор покрывает оба известных ключа"
        );
        // Пустая карта контактов — тоже ровно одна попытка (self).
        assert_eq!(
            decrypt_order(&std::collections::HashMap::new(), PEER),
            vec![None]
        );
    }

    #[test]
    fn sender_absent_from_contacts_never_retries() {
        let mut peers = std::collections::HashMap::new();
        peers.insert(PEER.to_string(), "pk-peer".to_string());
        assert!(
            !unknown_sender(&peers, PEER),
            "контакт не считается незнакомым"
        );
        assert!(
            unknown_sender(&peers, OTHER),
            "нет в контактах = незнакомый отправитель"
        );
        assert!(
            unknown_sender(&std::collections::HashMap::new(), PEER),
            "пустая карта контактов — отправитель неизвестен"
        );
    }

    #[test]
    fn three_failed_attempts_and_the_letter_is_dropped_for_good() {
        // Литералы, а не MAX_TRIES: «сдался раньше» = письмо никогда не
        // покажем, «не сдаётся никогда» = очередь крутится и греет батарею.
        assert_eq!(MAX_TRIES, 3);
        assert_eq!(retry_effect(1), RetryEffect::Again);
        assert_eq!(retry_effect(2), RetryEffect::Again);
        assert_eq!(retry_effect(3), RetryEffect::GiveUp, "третья — последняя");
        assert_eq!(retry_effect(4), RetryEffect::GiveUp);
    }

    #[test]
    fn monitor_database_is_the_one_file_the_cursor_lives_in() {
        // Три места монитора открывали базу по своей формуле пути. Расхождение в
        // имени каталога = «две разные базы»: курсор IMAP и seen-дедуп живут в
        // одной, и на телефоне это либо повторные уведомления, либо молчание.
        let dir = std::path::PathBuf::from("/data/user/0/com.vault.vault/files");
        assert_eq!(
            monitor_db_path(Some(dir.clone()), "/unused"),
            dir.join("com.vault.vault").join("monitor.db")
        );
        assert_eq!(
            monitor_db_path(None, "/home/anna"),
            std::path::Path::new("/home/anna/monitor.db"),
            "без каталога данных — прежний фолбэк по HOME"
        );
    }

    #[test]
    fn group_invite_notice_names_the_sender_and_the_action() {
        let n = group_invite_notice("petya@post.ru");
        assert_eq!(n.title, "petya@post.ru");
        assert_eq!(
            n.text, "приглашение в группу — откройте Vault, чтобы принять",
            "текст — единственный намёк пользователю, тело не расшифровано"
        );
    }

    #[test]
    fn missed_call_notice_is_one_phrase_for_both_sites() {
        // Правило было продублировано в двух местах монитора; теперь одна
        // функция, и её текст — литерал в пробе.
        let n = missed_call_notice("Вася");
        assert_eq!(n.title, "Вася");
        assert_eq!(n.text, "Пропущенный звонок Vault");
    }

    #[test]
    fn notice_for_an_ordinary_message_prefers_the_name_and_never_shows_empty() {
        let n = notice_for(
            &serde_json::json!({"name": "Петя", "text": "привет"}),
            "",
            "petya@post.ru",
        )
        .expect("письмо с текстом показывается");
        assert_eq!(n.title, "Петя");
        assert_eq!(n.text, "привет");

        let anon = notice_for(
            &serde_json::json!({"name": "", "text": "привет"}),
            "",
            "petya@post.ru",
        )
        .expect("без имени тоже показываем");
        assert_eq!(anon.title, "petya@post.ru", "без имени — адрес");

        assert!(
            notice_for(&serde_json::json!({"text": ""}), "", "petya@post.ru").is_none(),
            "пустое письмо не должно рождать пустое уведомление"
        );
        assert!(
            notice_for(&serde_json::json!({"text": "привет"}), "profile", "a@b.c").is_none(),
            "рассылка профиля — не уведомление"
        );
        assert!(
            notice_for(&serde_json::json!({}), "", "petya@post.ru").is_none(),
            "в конверте ничего нет — молчим"
        );
    }

    #[test]
    fn sos_notice_is_marked_up_even_when_the_sender_sent_holes() {
        let full = notice_for(
            &serde_json::json!({"name": "Мама", "text": "я в порядке, просто проверяю"}),
            "sos",
            "mama@post.ru",
        )
        .expect("SOS показывается всегда");
        assert_eq!(full.title, "🚨 SOS: Мама");
        assert_eq!(full.text, "я в порядке, просто проверяю");

        // Так шлёт JS: name пустое. Раньше в заголовке была пустота.
        let nameless = notice_for(
            &serde_json::json!({"name": "", "text": "помощь"}),
            "sos",
            "mama@post.ru",
        )
        .unwrap();
        assert_eq!(nameless.title, "🚨 SOS: mama@post.ru");
        assert_eq!(nameless.text, "помощь");

        // Пустой текст SOS — не «пустое уведомление», а дефолтная фраза:
        // сам SOS-сигнал терять нельзя, он и есть смысл сигнала.
        let bodiless = notice_for(&serde_json::json!({"name": "Мама"}), "sos", "m@b.c").unwrap();
        assert_eq!(bodiless.title, "🚨 SOS: Мама");
        assert_eq!(bodiless.text, "Телефон не у меня");

        assert_eq!(
            notice_for(&serde_json::json!({}), "sos", "m@b.c").unwrap().title,
            "🚨 SOS: m@b.c",
            "SOS без имени и без текста всё равно виден"
        );
    }

    #[test]
    fn kv_rows_keep_the_names_written_by_the_older_build() {
        // Имена строк — контракт с состоянием, уже лежащим на устройстве:
        // переименовать строку = после обновления потерять доставленные письма,
        // очередь и надгробия звонков. На телефоне это «уведомления пришли
        // заново» и «отклонённый звонок звонит снова».
        with_db(|db| {
            assert_eq!(seen_key(), "notify_seen");
            assert_eq!(pending_key(), "notify_pending");
            assert_eq!(call_state_key(), "call_state");
            seen_push(db, ME, "m1");
            let g = db.lock().unwrap();
            assert!(
                g.kv_get(ME, "notify_seen").unwrap().is_some(),
                "дедуп пишется именно в эту строку"
            );
        });
    }

    fn entry(mid: &str, tries: u32) -> PendingEntry {
        PendingEntry {
            mid: mid.to_string(),
            from: "peer@post.ru".to_string(),
            folder: "INBOX".to_string(),
            uid: "1".to_string(),
            tries,
        }
    }

    const OTHER: &str = "other@post.ru";
}
