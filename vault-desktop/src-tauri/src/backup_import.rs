//! Модуль восстановления из backup с гарантией атомарности файлов+SQLite.
//!
//! Fix/recovery-resilience, задача t_12f15e61. Раньше `import_keys`/`import_backup`
//! писали на диск ПОСТЕПЕННО (сначала keypair, потом peers, потом KV), и ошибка
//! на позднем шаге оставляла частично изменённое состояние (файл перезаписан,
//! peers не тронуты). Этот модуль реализует crash-consistent восстановление:
//!
//! 1. ПОЛНЫЙ разбор backup ДО любой записи (валидация всех частей).
//! 2. Файловый журнал в подкаталоге каталога ключей (.recovery-import) с
//!    приватными правами, fsync файлов+каталога ПЕРЕД продвижением цели.
//! 3. Согласование с SQLite через приватную таблицу маркера коммита:
//!    BEGIN IMMEDIATE -> KV DELETE+INSERT + promote файлов (fsync+rename) ->
//!    commit маркера. Сбой ДО коммита -> откат к старым байтам из журнала.
//!
//! Секреты (значения ключей) НИКОГДА не печатаются в ошибках — только
//! структурные сообщения. Журнал-манифест не содержит байтов ключей.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Result};

use crate::key_store::{StoredKeyPair, StoredPeerKey};

/// Имя подкаталога журнала внутри разрешённого каталога ключей.
pub(crate) const RECOVERY_DIR: &str = ".recovery-import";
/// Имя подкаталога подготовки (disposable, только owned-пути).
pub(crate) const PREPARING_DIR: &str = ".recovery-import-preparing";
/// Имя подкаталога завершения (disposable, только owned-пути).
pub(crate) const FINISHED_DIR: &str = ".recovery-import-finished";
/// Имя файла манифеста активного журнала.
pub(crate) const MANIFEST_FILE: &str = "manifest.json";
/// Имя файла блокировки процесса (живёт постоянно, не удаляется).
pub(crate) const LOCK_FILE: &str = ".recovery-import.lock";

/// Фиксированные сообщения об ошибках (без секретов и без байтов ключей).
pub(crate) const ERR_MALFORMED_JSON: &str = "backup: невалидный JSON";
const ERR_UNSUPPORTED_VERSION: &str = "backup: неподдерживаемая версия";
const ERR_NOTHING_TO_RESTORE: &str = "backup: нечего восстанавливать";
const ERR_MALFORMED_KEYPAIR: &str = "backup: невалидный keypair";
const ERR_MALFORMED_PEER: &str = "backup: невалидный peer";
const ERR_MALFORMED_KV: &str = "backup: невалидная KV-запись";
const ERR_DUPLICATE_PEER: &str = "backup: дублирующийся peer";
const ERR_DUPLICATE_KV: &str = "backup: дублирующаяся KV-запись";
pub(crate) const ERR_MALFORMED_JOURNAL: &str = "recovery: повреждённый журнал";
pub(crate) const ERR_IO: &str = "recovery: ошибка ввода-вывода";
/// Разобранный и провалидированный backup. Построение возможно ТОЛЬКО через
/// [`parse_backup`], которое валидирует всё до любых записей на диск.
#[derive(Debug)]
pub(crate) struct ParsedBackup {
    /// Опциональный ключевой набор. `Some` — keypair и/или peers запрошены.
    pub(crate) keys: Option<ParsedKeys>,
    /// Опциональный KV-набор (ровно 3 строки на запись). `Some` — заменить KV.
    pub(crate) kv: Option<Vec<(String, String, String)>>,
}

/// Разобранные ключи. Отсутствие поля в backup => не трогать соответствующую
/// часть (не «очистить»).
#[derive(Debug)]
pub(crate) struct ParsedKeys {
    /// Опциональный keypair (если запрошен — пишем).
    pub(crate) keypair: Option<StoredKeyPair>,
    /// Опциональные peers. `Some(vec)` — заменить список (может быть пустым).
    pub(crate) peers: Option<Vec<StoredPeerKey>>,
}

/// Разбор backup из строки. Полная валидация ДО возврата — вызывающий может
/// быть уверен, что при `Ok` запись на диск не упрётся в структурную ошибку.
///
/// Неизвестные верхнеуровневые поля (`type`, `exported_at` и пр.) допускаются
/// для совместимости формата с `export_backup`.
pub(crate) fn parse_backup(json: &str) -> Result<ParsedBackup> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| sanitize_parse_error(ERR_MALFORMED_JSON, &e))?;

    let obj = value
        .as_object()
        .ok_or_else(|| anyhow!(ERR_MALFORMED_JSON))?;

    // Версия: если присутствует — должна быть 1.
    if let Some(v) = obj.get("version") {
        match v.as_u64() {
            Some(1) => {}
            _ => bail!(ERR_UNSUPPORTED_VERSION),
        }
    }

    let keys = match obj.get("keys") {
        None | Some(serde_json::Value::Null) => None,
        Some(k) => Some(parse_keys(k)?),
    };

    // KV-набор. Реальный export_backup кладёт массив в поле `kv_store`
    // (см. lib.rs export_backup / старый import_backup). Принимаем `kv_store`
    // как основное имя и `kv` как допустимый псевдоним — совместимость формата.
    let kv = match obj.get("kv_store").or_else(|| obj.get("kv")) {
        None | Some(serde_json::Value::Null) => None,
        Some(k) => Some(parse_kv(k)?),
    };

    // Должна быть хотя бы одна часть для восстановления.
    let has_content = match &keys {
        Some(ParsedKeys {
            keypair: Some(_), ..
        }) => true,
        Some(ParsedKeys { peers: Some(_), .. }) => true,
        _ => false,
    } || kv.is_some();
    if !has_content {
        bail!(ERR_NOTHING_TO_RESTORE);
    }

    Ok(ParsedBackup { keys, kv })
}

/// Фильтрует текст ошибки serde, чтобы не утекли байты приватного ключа из
/// входной строки. Наружу отдаём только фиксированную метку.
fn sanitize_parse_error(fixed: &str, _e: &serde_json::Error) -> anyhow::Error {
    // .to_string(): anyhow должен владеть сообщением (иначе заимствование
    // убегает из функции). Наружу — только фиксированная метка, без секретов.
    anyhow!(fixed.to_string())
}

/// Разбор объекта `keys`. Опциональные `keypair` и `peer_keys` внутри.
fn parse_keys(k: &serde_json::Value) -> Result<ParsedKeys> {
    let kobj = k
        .as_object()
        .ok_or_else(|| anyhow!(ERR_MALFORMED_KEYPAIR))?;

    let keypair = match kobj.get("keypair") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => Some(parse_keypair(v)?),
    };

    let peers = match kobj.get("peer_keys") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => Some(parse_peers(v)?),
    };

    if keypair.is_none() && peers.is_none() {
        // `keys` присутствует, но пуст — нечего восстанавливать в ключах.
        bail!(ERR_MALFORMED_KEYPAIR);
    }

    Ok(ParsedKeys { keypair, peers })
}

/// Разбор и валидация одного keypair (64-hex, pub != priv, обязательный
/// created_at). Значения НЕ печатаются при ошибке.
fn parse_keypair(v: &serde_json::Value) -> Result<StoredKeyPair> {
    // Десериализуем через тот же тип, что и на диске — формат не меняем.
    let kp: StoredKeyPair =
        serde_json::from_value(v.clone()).map_err(|_| anyhow!(ERR_MALFORMED_KEYPAIR))?;
    if !is_hex64(&kp.public_key) || !is_hex64(&kp.private_key) {
        bail!(ERR_MALFORMED_KEYPAIR);
    }
    if kp.public_key == kp.private_key {
        bail!(ERR_MALFORMED_KEYPAIR);
    }
    if kp.created_at.trim().is_empty() {
        bail!(ERR_MALFORMED_KEYPAIR);
    }
    Ok(kp)
}

/// Разбор списка peers. Пустой массив допустим (явная очистка). Каждый peer:
/// 64-hex public, непустой email, обязательный added_at. Дубли email
/// отвергаются.
fn parse_peers(v: &serde_json::Value) -> Result<Vec<StoredPeerKey>> {
    let arr = v.as_array().ok_or_else(|| anyhow!(ERR_MALFORMED_PEER))?;
    let mut out: Vec<StoredPeerKey> = Vec::with_capacity(arr.len());
    let mut seen_emails: std::collections::HashSet<String> = std::collections::HashSet::new();
    for item in arr {
        let peer: StoredPeerKey =
            serde_json::from_value(item.clone()).map_err(|_| anyhow!(ERR_MALFORMED_PEER))?;
        if !is_hex64(&peer.public_key) {
            bail!(ERR_MALFORMED_PEER);
        }
        if peer.email.trim().is_empty() {
            bail!(ERR_MALFORMED_PEER);
        }
        if peer.added_at.trim().is_empty() {
            bail!(ERR_MALFORMED_PEER);
        }
        let norm = peer.email.to_ascii_lowercase();
        if !seen_emails.insert(norm) {
            bail!(ERR_DUPLICATE_PEER);
        }
        out.push(peer);
    }
    Ok(out)
}

/// Разбор KV-массива. Каждая запись — ровно 3 строки (account,key,value).
/// Дубли (account,key) отвергаются.
fn parse_kv(v: &serde_json::Value) -> Result<Vec<(String, String, String)>> {
    let arr = v.as_array().ok_or_else(|| anyhow!(ERR_MALFORMED_KV))?;
    let mut out: Vec<(String, String, String)> = Vec::with_capacity(arr.len());
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for item in arr {
        let tuple = item.as_array().ok_or_else(|| anyhow!(ERR_MALFORMED_KV))?;
        if tuple.len() != 3 {
            bail!(ERR_MALFORMED_KV);
        }
        let account = tuple[0]
            .as_str()
            .ok_or_else(|| anyhow!(ERR_MALFORMED_KV))?
            .to_string();
        let key = tuple[1]
            .as_str()
            .ok_or_else(|| anyhow!(ERR_MALFORMED_KV))?
            .to_string();
        let value = tuple[2]
            .as_str()
            .ok_or_else(|| anyhow!(ERR_MALFORMED_KV))?
            .to_string();
        if !seen.insert((account.clone(), key.clone())) {
            bail!(ERR_DUPLICATE_KV);
        }
        out.push((account, key, value));
    }
    Ok(out)
}

/// Проверка: строка — ровно 64 шестнадцатеричных символа (32 байта).
fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Разрешённая конфигурация операций импорта: RAW-каталог ключей и путь БД.
/// Разделение «разбор» (parse_backup — чистая функция) и «применение»
/// (Config+ParsedBackup) позволяет тестировать разбор без трогания диска и
/// без default-путей.
#[derive(Debug, Clone)]
pub(crate) struct Config {
    /// RAW-разрешённый (без симлинк-траверса) каталог ключей.
    pub(crate) keys_dir: PathBuf,
    /// Путь к SQLite-базе (может не существовать — создаётся по требованию).
    pub(crate) db_path: PathBuf,
}

/// Публичная сводка импорта (без секретов) — для сообщения вызывающему.
#[derive(Debug, Clone)]
pub(crate) struct ImportOutcome {
    pub(crate) keypair: bool,
    pub(crate) peers: Option<usize>,
    pub(crate) kv: Option<usize>,
}

impl std::fmt::Display for ImportOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut parts = Vec::new();
        if self.keypair {
            parts.push("keypair".to_string());
        }
        if let Some(n) = self.peers {
            parts.push(format!("peers={n}"));
        }
        if let Some(n) = self.kv {
            parts.push(format!("kv={n}"));
        }
        write!(f, "восстановлено: {}", parts.join(", "))
    }
}

/// Генерирует случайный txid (16 байт → 32 hex) без повторов. txid никогда не
/// переиспользуется; используется как метка коммита и имя каталога журнала.
pub(crate) fn gen_txid() -> String {
    let mut buf = [0u8; 16];
    // rand 0.8 — уже в зависимостях. fill_bytes на [u8].
    use rand::RngCore as _;
    rand::thread_rng().fill_bytes(&mut buf);
    let mut s = String::with_capacity(32);
    for b in buf {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Разрешение/канонизация каталога ключей. Возвращает сырой путь для
/// построения журнала/замка. Не создаёт каталог.
pub(crate) fn raw_keys_dir() -> PathBuf {
    crate::key_store::get_keys_dir_raw()
}

/// Точка входа команды `import_backup` (тонкий делегат из lib.rs). Использует
/// default RAW-каталог ключей и default-путь БД. Возвращает человекочитаемую
/// сводку (без секретов).
pub(crate) fn import_backup(json: &str) -> Result<String> {
    let keys_dir = raw_keys_dir();
    let db_path = crate::storage::sqlite::default_db_path()?;
    // Единый путь через import_at (тот же движок + изолированное ТЗ-API тестов).
    let outcome = import_at(&keys_dir, &db_path, json)?;
    Ok(outcome.to_string())
}

/// Явный импорт с заданными root/db — изолированный API для тестов/PM и общее
/// ядро публичной команды import_backup (один и тот же движок apply).
pub(crate) fn import_at(keys_dir: &Path, db_path: &Path, json: &str) -> Result<ImportOutcome> {
    let parsed = parse_backup(json)?;
    let cfg = Config {
        keys_dir: keys_dir.to_path_buf(),
        db_path: db_path.to_path_buf(),
    };
    ops::apply(&cfg, &parsed)
}

/// Разбор keys-подструктуры ({keypair, peer_keys}) для generic-импорта
/// key_store: та же строгая валидация, что и в backup-формате — битый поздний
/// peer валит ВЕСЬ импорт (никакого filter_map-пропуска).
pub(crate) fn parse_keys_only(json: &str) -> Result<ParsedKeys> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| sanitize_parse_error(ERR_MALFORMED_JSON, &e))?;
    parse_keys(&value)
}

/// Применение под УЖЕ захваченным вызывающим ключевым guard'ом (key_store:
/// тот же LOCK_FILE flock + reentrancy). ProcessLock здесь НЕ берётся —
/// вложенный flock того же файла дедлокнул бы текущий поток.
pub(crate) fn apply_under_guard(cfg: &Config, parsed: &ParsedBackup) -> Result<ImportOutcome> {
    ops::apply_locked(cfg, parsed)
}

/// Восстановление ОЖИДАЮЩЕГО журнала на старте/перед операцией. Вызывается под
/// уже захваченным guard'ом (или до него на старте). RAW-открытие БД без
/// рекурсии в Storage::open(None). Возвращает Ok, если ожидающего журнала нет.
pub(crate) fn recover_pending(cfg: &Config) -> Result<()> {
    // Обёртка для вызовов БЕЗ KeysGuard (тесты, PM): сериализация с apply —
    // через ProcessLock (тот же LOCK_FILE). Под KeysGuard используется
    // recover_pending_dir — flock уже у вызывающего, второй flock = дедлок.
    let _lock = ops::ProcessLock::acquire(&cfg.keys_dir)?;
    ops::recover_pending(cfg)
}

/// Восстановление ОЖИДАЮЩЕГО журнала для конкретного каталога ключей (без
/// Config). Используется guard'ом key_store (который уже держит захват) —
/// открывает RAW db_path, рекурсии в Storage::open(None) нет. БД-путь
/// вычисляется дефолтно (для единственного реального HOME). В тестах с явным
/// путём используется recover_pending(&Config) напрямую. Синхронизация: flock
/// KeysGuard УЖЕ у вызывающего — второй лок здесь НЕ берётся.
pub(crate) fn recover_pending_dir(keys_dir: &Path) -> Result<()> {
    let cfg = Config {
        keys_dir: keys_dir.to_path_buf(),
        db_path: crate::storage::sqlite::default_db_path()
            .unwrap_or_else(|_| PathBuf::from("vault.db")),
    };
    ops::recover_pending(&cfg)
}

/// Точка входа барьера восстановления на старте (lib.rs). Строит Config из
/// RAW-каталога ключей и default-пути БД, затем восстанавливает журнал.
/// RAW-resolve + recover НЕ вызывают публичные guarded-функции key_store —
/// рекурсии/дедлока нет.
pub(crate) fn recover_pending_default() -> Result<()> {
    let cfg = Config {
        keys_dir: raw_keys_dir(),
        db_path: crate::storage::sqlite::default_db_path()?,
    };
    // Стартовый барьер идёт через обёртку (ProcessLock): однопоточный старт,
    // но flock сериализует с возможным импортом другого процесса.
    recover_pending(&cfg)
}

mod ops;
#[cfg(test)]
mod tests;
