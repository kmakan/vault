use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const KEYS_DIR: &str = "keys";
const KEY_FILE: &str = "keypair.json";
const PEER_KEYS_FILE: &str = "peer_keys.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredKeyPair {
    pub public_key: String,
    pub private_key: String,
    pub created_at: String,
    /// Post-quantum: seed ML-KEM-768, hex 64 байта. У старых
    /// keypair.json поля нет → миграция генерирует при load_keypair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_private_key: Option<String>,
    /// Post-quantum: ek ML-KEM-768, base64 1184 байта.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredPeerKey {
    pub email: String,
    pub public_key: String,
    pub label: Option<String>,
    pub added_at: String,
    /// Post-quantum: ek ML-KEM-768 контакта, base64. Нет — контакт
    /// ещё без PQ (миграция), ему уходит legacy X25519-конверт.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStoreMetadata {
    pub version: u32,
    pub key_count: usize,
    pub last_modified: String,
}

fn get_keys_dir() -> anyhow::Result<PathBuf> {
    // Test-only override: проверяется ПЕРВЫМ, чтобы тесты (дедупликация
    // контакта при смене почты) не зависели от VAULT_KEYS_DIR / реального
    // ~/.vault/keys. В проде переменная не задаётся — поведение не меняется.
    if let Ok(p) = std::env::var("VAULT_TEST_KEYS_DIR") {
        return Ok(PathBuf::from(p));
    }
    // Tests (and power users) can redirect the storage dir; keeps the real
    // `~/.vault/keys` untouched.
    if let Ok(p) = std::env::var("VAULT_KEYS_DIR") {
        return Ok(PathBuf::from(p));
    }
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".vault").join(KEYS_DIR))
}

/// RAW-резолв каталога ключей БЕЗ захвата guard (t_12f15e61). Используется
/// операциями импорта/восстановления, которые сначала вычисляют корень, затем
/// сами берут guard (или, в случае recovery-журнала, работают без него).
/// ВАЖНО: публичные операции key_store НЕ должны вызывать это напрямую для
/// последующих записей — путь всегда через guard. Возвращает ошибку, если
/// home не определён.
pub(crate) fn get_keys_dir_raw() -> PathBuf {
    if let Ok(p) = std::env::var("VAULT_TEST_KEYS_DIR") {
        return PathBuf::from(p);
    }
    if let Ok(p) = std::env::var("VAULT_KEYS_DIR") {
        return PathBuf::from(p);
    }
    match dirs::home_dir() {
        Some(home) => home.join(".vault").join(KEYS_DIR),
        // Фолбэк для окружений без home (в проде home всегда есть; здесь лишь
        // чтобы RAW-резолв не паниковал). Guard/операции обработают отсутствие.
        None => PathBuf::from(".vault").join(KEYS_DIR),
    }
}

// ─────────────────────────── guard (t_12f15e61) ──────────────────────────
//
// Сериализация доступа к каталогу ключей в рамках процесса + межпроцессный
// flock на постоянном LOCK_FILE. Reentrant для вложенных вызовов на том же
// потоке (add_peer_key вызывает save_peer_keys/load_* внутри одного захвата).
// Ошибка захвата — Err (не best-effort). Guard НЕ держится через await (всё
// здесь sync). Восстановление журнала выполняется под захватом и открывает
// RAW db_path (не Storage::open(None) — рекурсия).

use std::sync::{Condvar, Mutex};

/// Состояние guard: владелец (ThreadId) + глубина reentrant-захвата.
struct GuardState {
    owner: Option<std::thread::ThreadId>,
    depth: u64,
}

static GUARD_STATE: Mutex<GuardState> = Mutex::new(GuardState {
    owner: None,
    depth: 0,
});
static GUARD_CV: Condvar = Condvar::new();

/// Захват guard каталога ключей. Reentrant для вложенных вызовов на том же
/// потоке; другой поток ждёт на condvar, пока владелец не отпустит. flock на
/// LOCK_FILE (постоянном, не удаляем) — межпроцессный барьер. Ошибка захвата
/// файла блокировки — Err (не best-effort).
pub(crate) struct KeysGuard {
    lock_file: Option<fs::File>,
    reentrant: bool,
}

impl KeysGuard {
    fn acquire(keys_dir: &Path) -> anyhow::Result<Self> {
        let me = std::thread::current().id();
        let mut state = match GUARD_STATE.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // Ждём, пока guard свободен (или мы уже владелец — reentrancy).
        loop {
            match state.owner {
                Some(t) if t == me => {
                    // Вложенный вызов на том же потоке: reentrant, без flock.
                    state.depth += 1;
                    return Ok(Self {
                        lock_file: None,
                        reentrant: true,
                    });
                }
                Some(_) => {
                    state = match GUARD_CV.wait(state) {
                        Ok(g) => g,
                        Err(p) => p.into_inner(),
                    };
                }
                None => break,
            }
        }
        // owner==None: возможна гонка нескольких прошедших проверку потоков —
        // решающий голос у flock. Мьютекс годен ТОЛЬКО для owner-проверки:
        // держать его через flock нельзя (иначе: T2 держит мьютекс, ждёт flock
        // у T1; T1-Drop не может взять мьютекс, чтобы отпустить flock → дедлок).
        drop(state);

        // Межпроцессный flock на постоянном LOCK_FILE — фактический мьютекс.
        fs::create_dir_all(keys_dir)?;
        let lock_path = keys_dir.join(crate::backup_import::LOCK_FILE);
        let lock_file = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)?;
        lock_file
            .lock()
            .map_err(|_| anyhow::anyhow!("keys guard: lock failed"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o600));
        }
        // Публикуем владение, затем recover УЖЕ под flock: конкурентный recover
        // или импорт другого процесса исключены (тот же LOCK_FILE); ошибку
        // recover откатываем: unlock + снять owner + разбудить ожидающих.
        let mut state = match GUARD_STATE.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        state.owner = Some(me);
        state.depth = 1;
        drop(state);
        if let Err(e) = crate::backup_import::recover_pending_dir(keys_dir) {
            log::error!("keys guard: recover_pending_dir failed: {e:?}");
            let _ = lock_file.unlock();
            let mut st = match GUARD_STATE.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if st.owner == Some(me) {
                st.owner = None;
                st.depth = 0;
            }
            drop(st);
            GUARD_CV.notify_all();
            return Err(e);
        }
        Ok(Self {
            lock_file: Some(lock_file),
            reentrant: false,
        })
    }
}

impl Drop for KeysGuard {
    fn drop(&mut self) {
        if self.reentrant {
            let mut state = match GUARD_STATE.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            state.depth = state.depth.saturating_sub(1);
            return;
        }
        if let Some(f) = &self.lock_file {
            let _ = f.unlock();
        }
        let mut state = match GUARD_STATE.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        // Условная очистка: после нашего unlock сменщик owner мог уже прийти —
        // его запись не сносим (owner всегда текущий держатель flock или None).
        if state.owner == Some(std::thread::current().id()) {
            state.owner = None;
            state.depth = 0;
        }
        drop(state);
        GUARD_CV.notify_all();
    }
}

/// Захватить guard для каталога ключей (ошибка — Err, не best-effort).
pub(crate) fn acquire_guard_for_dir(keys_dir: &Path) -> anyhow::Result<KeysGuard> {
    KeysGuard::acquire(keys_dir)
}

fn ensure_keys_dir_at(keys_dir: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(keys_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(keys_dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Записать файл с правами 0600 (best-effort на не-Unix).
fn write_file_0600(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn save_keypair(keypair: &StoredKeyPair) -> anyhow::Result<()> {
    let keys_dir = get_keys_dir_raw();
    let _guard = acquire_guard_for_dir(&keys_dir)?;
    save_keypair_at(&keys_dir, keypair)
}

/// RAW-ядро сохранения keypair (без guard). Каталог 0700, файл 0600.
pub(crate) fn save_keypair_at(keys_dir: &Path, keypair: &StoredKeyPair) -> anyhow::Result<()> {
    ensure_keys_dir_at(keys_dir)?;
    let path = keys_dir.join(KEY_FILE);
    let json = serde_json::to_string_pretty(keypair)?;
    write_file_0600(&path, json.as_bytes())?;
    Ok(())
}

pub fn load_keypair() -> anyhow::Result<Option<StoredKeyPair>> {
    let keys_dir = get_keys_dir_raw();
    let _guard = acquire_guard_for_dir(&keys_dir)?;
    load_keypair_at(&keys_dir)
}

/// RAW-ядро загрузки keypair (без guard) + PQ-миграция (пишет под guard).
pub(crate) fn load_keypair_at(keys_dir: &Path) -> anyhow::Result<Option<StoredKeyPair>> {
    let path = keys_dir.join(KEY_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let data = fs::read_to_string(&path)?;
    let mut keypair: StoredKeyPair = serde_json::from_str(&data)?;
    // PQ-миграция: у аккаунтов, созданных до post-quantum, нет
    // ML-KEM-пары. Генерируем при первой загрузке и сразу сохраняем —
    // конверты v2 начнут уходить автоматически (PQ-3/PQ-4). Пишем под guard.
    if keypair.pq_private_key.is_none() || keypair.pq_public_key.is_none() {
        let pq = crate::crypto_pq::pq_generate();
        keypair.pq_private_key = Some(pq.seed_hex);
        keypair.pq_public_key = Some(pq.ek_b64);
        let json = serde_json::to_string_pretty(&keypair)?;
        write_file_0600(&path, json.as_bytes())?;
    }
    Ok(Some(keypair))
}

/// RAW-ядро сохранения peer-ключей (без guard). Каталог 0700, файл 0600.
pub(crate) fn save_peer_keys_at(keys_dir: &Path, keys: &[StoredPeerKey]) -> anyhow::Result<()> {
    ensure_keys_dir_at(keys_dir)?;
    let path = keys_dir.join(PEER_KEYS_FILE);
    let json = serde_json::to_string_pretty(keys)?;
    write_file_0600(&path, json.as_bytes())?;
    Ok(())
}

pub fn load_peer_keys() -> anyhow::Result<Vec<StoredPeerKey>> {
    let keys_dir = get_keys_dir_raw();
    let _guard = acquire_guard_for_dir(&keys_dir)?;
    load_peer_keys_at(&keys_dir)
}

/// RAW-ядро загрузки peer-ключей (без guard).
pub(crate) fn load_peer_keys_at(keys_dir: &Path) -> anyhow::Result<Vec<StoredPeerKey>> {
    let path = keys_dir.join(PEER_KEYS_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = fs::read_to_string(&path)?;
    let keys: Vec<StoredPeerKey> = serde_json::from_str(&data)?;
    Ok(keys)
}

pub fn add_peer_key(key: StoredPeerKey) -> anyhow::Result<()> {
    let keys_dir = get_keys_dir_raw();
    let _guard = acquire_guard_for_dir(&keys_dir)?;
    add_peer_key_at(&keys_dir, key)
}

/// RAW-ядро добавления peer-ключа (без guard; вызывается внутри захвата).
/// Все внутренние load/save идут через `_at` (без повторного захвата).
pub(crate) fn add_peer_key_at(keys_dir: &Path, key: StoredPeerKey) -> anyhow::Result<()> {
    // ADDRESS GATE: peer_keys индексируется по email — только настоящие
    // адреса. Строки вида fp:<fingerprint> (account-namespace) и прочие
    // идентификаторы создавали «контакт-отпечаток» в списке (живой баг
    // 06.10.2026: запись fp:2b:e1:... в peer_keys, добавленная 27.09).
    // Единая точка ВСЕХ записей (invite-accept, accept, ручная вставка).
    let em = key.email.trim();
    if !em.contains('@') || em.to_lowercase().starts_with("fp:") {
        anyhow::bail!("peer key address must be an email, got: {}", key.email);
    }
    // SELF-KEY GUARD: saving one's own public key as a peer's key silently
    // breaks ECDH in BOTH directions (encrypt-to-self / decrypt mismatch).
    // stale invite sent from a shared-HOME instance carried the sender's own
    // keypair as "their" public key, and the acceptor stored it. Reject at
    // the single choke point all peer-key writes go through (contact invite
    // accept, contact accept, manual paste).
    if let Some(kp) = load_keypair_at(keys_dir)? {
        if kp.public_key == key.public_key {
            anyhow::bail!("Refusing to save your own public key as a peer key");
        }
    }
    let mut keys = load_peer_keys_at(keys_dir)?;
    // DEDUP (IDENTITY = публичный ключ; EMAIL = транспорт): тот же
    // public_key под ДРУГИМ адресом = собеседник сменил почту.
    // Переименовываем СУЩЕСТВУЮЩУЮ запись вместо второй — иначе у
    // получателя появляется дубль-контакт с тем же ключом.
    let existing_by_pubkey = keys.iter().position(|k| k.public_key == key.public_key);
    if let Some(idx) = existing_by_pubkey {
        if !keys[idx].email.eq_ignore_ascii_case(&key.email) {
            keys[idx].email = key.email.clone();
            keys[idx].label = key.label;
            // PQ: новый ek обновляет; None НЕ трогает существующий
            // (контакт без PQ остаётся с PQ-ключом, полученным позже).
            if key.pq_public_key.is_some() {
                keys[idx].pq_public_key = key.pq_public_key;
            }
            save_peer_keys_at(keys_dir, &keys)?;
            return Ok(());
        }
        // email совпадает — существующее поведение (обновление полей) ниже.
    }
    if let Some(existing) = keys.iter_mut().find(|k| k.email == key.email) {
        existing.public_key = key.public_key;
        existing.label = key.label;
        // PQ: новый ключ затирает старый; None НЕ трогает существующий
        // (контакт без PQ остаётся с PQ-ключом, полученным позже из конверта).
        if key.pq_public_key.is_some() {
            existing.pq_public_key = key.pq_public_key;
        }
    } else {
        keys.push(key);
    }
    save_peer_keys_at(keys_dir, &keys)
}

pub fn remove_peer_key(email: &str) -> anyhow::Result<bool> {
    let keys_dir = get_keys_dir_raw();
    let _guard = acquire_guard_for_dir(&keys_dir)?;
    let mut keys = load_peer_keys_at(&keys_dir)?;
    let before = keys.len();
    keys.retain(|k| k.email != email);
    let removed = keys.len() < before;
    if removed {
        save_peer_keys_at(&keys_dir, &keys)?;
    }
    Ok(removed)
}

pub fn export_keys() -> anyhow::Result<String> {
    let keypair = load_keypair()?.ok_or_else(|| anyhow::anyhow!("No keypair found"))?;
    let peer_keys = load_peer_keys()?;
    let export = serde_json::json!({
        "version": 1,
        "keypair": keypair,
        "peer_keys": peer_keys,
        "exported_at": chrono::Utc::now().to_rfc3339(),
    });
    Ok(serde_json::to_string_pretty(&export)?)
}

pub fn import_keys(json_data: &str) -> anyhow::Result<KeyStoreMetadata> {
    let keys_dir = get_keys_dir_raw();
    let _guard = acquire_guard_for_dir(&keys_dir)?;
    let db_path = crate::storage::sqlite::default_db_path()?;
    import_keys_at(&keys_dir, &db_path, json_data)
}

/// RAW-ядро import_keys: вызывается ПОД захватом guard'а (flock уже у держателя,
/// повторный ProcessLock не берётся). Валидация+атомарная запись — движок
/// backup_import (журнал/commit-marker); KV не трогается (keys-only).
pub(crate) fn import_keys_at(
    keys_dir: &Path,
    db_path: &Path,
    json_data: &str,
) -> anyhow::Result<KeyStoreMetadata> {
    // Единый движок backup_import (t_12f15e61): строгий parse всех частей ДО
    // записи (битый поздний peer валит импорт целиком — никакого filter_map),
    // журнал + commit-маркер; keys-only не трогает KV (kv=None).
    let value: serde_json::Value = serde_json::from_str(json_data)
        .map_err(|_| anyhow::anyhow!(crate::backup_import::ERR_MALFORMED_JSON))?;
    let version = value["version"].as_u64().unwrap_or(1) as u32;
    let keys = crate::backup_import::parse_keys_only(json_data)?;
    let key_count =
        keys.keypair.is_some() as usize + keys.peers.as_ref().map(|p| p.len()).unwrap_or(0);

    let cfg = crate::backup_import::Config {
        keys_dir: keys_dir.to_path_buf(),
        db_path: db_path.to_path_buf(),
    };
    let parsed = crate::backup_import::ParsedBackup {
        keys: Some(keys),
        kv: None,
    };
    crate::backup_import::apply_under_guard(&cfg, &parsed)?;

    Ok(KeyStoreMetadata {
        version,
        key_count,
        last_modified: chrono::Utc::now().to_rfc3339(),
    })
}

pub fn get_store_metadata() -> anyhow::Result<Option<KeyStoreMetadata>> {
    let dir = get_keys_dir()?;
    let key_path = dir.join(KEY_FILE);
    let peer_path = dir.join(PEER_KEYS_FILE);

    if !key_path.exists() && !peer_path.exists() {
        return Ok(None);
    }

    let key_count = if key_path.exists() {
        1 + load_peer_keys().map(|k| k.len()).unwrap_or(0)
    } else {
        load_peer_keys().map(|k| k.len()).unwrap_or(0)
    };

    let last_modified = fs::metadata(&key_path)
        .or_else(|_| fs::metadata(&peer_path))
        .and_then(|m| m.modified())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Utc> = t.into();
            dt.to_rfc3339()
        })
        .unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());

    Ok(Some(KeyStoreMetadata {
        version: 1,
        key_count,
        last_modified,
    }))
}

pub fn delete_all_keys() -> anyhow::Result<()> {
    let dir = get_keys_dir()?;
    let _ = fs::remove_file(dir.join(KEY_FILE));
    let _ = fs::remove_file(dir.join(PEER_KEYS_FILE));
    Ok(())
}

/// Удалить только peer-ключи (без ключевой пары) — путь «Удалить аккаунт»
/// (RuStore §5.4). Файл убираем целиком: load_peer_keys() при его
/// отсутствии возвращает []. Повторный вызов / чистая установка — не ошибка.
pub fn delete_all_peer_keys() -> anyhow::Result<()> {
    let path = get_keys_dir()?.join(PEER_KEYS_FILE);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);
    /// Env vars are process-global, so tests that redirect VAULT_KEYS_DIR
    /// must run one at a time (cargo runs tests in parallel by default).
    static TMP_LOCK: Mutex<()> = Mutex::new(());

    /// Point VAULT_KEYS_DIR at a fresh temp dir so tests never touch the
    /// real `~/.vault/keys`.
    fn with_tmp_keys<T>(f: impl FnOnce() -> T) -> T {
        let _guard = TMP_LOCK.lock().unwrap();
        let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("vault-keys-test-{}-{}", std::process::id(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("VAULT_KEYS_DIR", &dir);
        let result = f();
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("VAULT_KEYS_DIR");
        result
    }

    #[test]
    fn test_save_and_load_keypair() {
        with_tmp_keys(|| {
            let kp = StoredKeyPair {
                public_key: "abcd1234".to_string(),
                private_key: "ef567890".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                pq_private_key: None,
                pq_public_key: None,
            };
            save_keypair(&kp).unwrap();
            let loaded = load_keypair().unwrap().unwrap();
            assert_eq!(loaded.public_key, kp.public_key);
            // PQ-миграция: load сгенерировал ML-KEM-пару и сохранил
            assert!(loaded.pq_private_key.is_some());
            assert!(loaded.pq_public_key.is_some());
            // Повторная загрузка НЕ рероллит PQ-пару (стабильный идентификатор)
            let again = load_keypair().unwrap().unwrap();
            assert_eq!(loaded.pq_public_key, again.pq_public_key);
        });
    }

    #[test]
    fn test_delete_all_peer_keys() {
        with_tmp_keys(|| {
            // Ключевая пара есть — её НЕ должен тронуть delete_all_peer_keys.
            let kp = StoredKeyPair {
                public_key: "own-public-key".to_string(),
                private_key: "own-private-key".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                pq_private_key: None,
                pq_public_key: None,
            };
            save_keypair(&kp).unwrap();
            let key = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: "abcd1234".to_string(),
                label: None,
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            add_peer_key(key).unwrap();
            assert_eq!(load_peer_keys().unwrap().len(), 1);

            delete_all_peer_keys().unwrap();
            assert!(load_peer_keys().unwrap().is_empty());
            // Ключевая пара осталась на месте
            assert!(load_keypair().unwrap().is_some());
            // Повторный вызов (файл уже удалён) — не ошибка
            delete_all_peer_keys().unwrap();
        });
    }

    #[test]
    fn test_peer_keys_crud() {
        with_tmp_keys(|| {
            let key = StoredPeerKey {
                email: "test@example.com".to_string(),
                public_key: "aabbccdd".to_string(),
                label: Some("Test User".to_string()),
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            add_peer_key(key.clone()).unwrap();
            let keys = load_peer_keys().unwrap();
            assert_eq!(keys.len(), 1);

            let removed = remove_peer_key("test@example.com").unwrap();
            assert!(removed);
            let keys = load_peer_keys().unwrap();
            assert!(keys.is_empty());
        });
    }

    #[test]
    fn test_add_peer_key_rejects_own_public_key() {
        // SELF-KEY GUARD: saving one's own public key as a peer's key breaks
        // ECDH silently in both directions — must be rejected at the store.
        with_tmp_keys(|| {
            let kp = StoredKeyPair {
                public_key: "abcd1234".to_string(),
                private_key: "ef567890".to_string(),
                created_at: "2024-01-01T00:00:00Z".to_string(),
                pq_private_key: None,
                pq_public_key: None,
            };
            save_keypair(&kp).unwrap();

            let own_as_peer = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: kp.public_key.clone(),
                label: None,
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            let err = add_peer_key(own_as_peer).unwrap_err();
            assert!(err.to_string().contains("own public key"));
            assert!(load_peer_keys().unwrap().is_empty());

            // A genuinely different key still saves fine.
            let real_peer = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: "ffff0000".to_string(),
                label: None,
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: Some("fakepq".to_string()),
            };
            add_peer_key(real_peer).unwrap();
            assert_eq!(load_peer_keys().unwrap().len(), 1);

            // PQ-семантика add_peer_key: None не трогает существующий PQ,
            // валидный новый — обновляет.
            let no_pq_update = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: "ffff0000".to_string(),
                label: None,
                added_at: "2024-01-02T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            add_peer_key(no_pq_update).unwrap();
            let keys = load_peer_keys().unwrap();
            assert_eq!(keys[0].pq_public_key.as_deref(), Some("fakepq"));

            let new_pq = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: "ffff0000".to_string(),
                label: None,
                added_at: "2024-01-03T00:00:00Z".to_string(),
                pq_public_key: Some("newpq".to_string()),
            };
            add_peer_key(new_pq).unwrap();
            let keys = load_peer_keys().unwrap();
            assert_eq!(keys[0].pq_public_key.as_deref(), Some("newpq"));
        });
    }

    /// Дедуп при смене почты: свой tempdir `ks_{pid}-{seq}` + свой env var
    /// VAULT_TEST_KEYS_DIR. Env — процесс-глобальный, поэтому set/remove
    /// под тем же единственным TMP_LOCK, что и остальные env-тесты:
    /// параллельные cargo test не гоняются за переменную.
    fn with_test_keys<T>(f: impl FnOnce() -> T) -> T {
        let _guard = TMP_LOCK.lock().unwrap();
        let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ks_{}-{}", std::process::id(), seq));
        let _ = std::fs::remove_dir_all(&dir);
        std::env::set_var("VAULT_TEST_KEYS_DIR", &dir);
        let result = f();
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("VAULT_TEST_KEYS_DIR");
        result
    }

    #[test]
    fn test_add_peer_key_renames_record_when_email_changes() {
        // (a) Смена почты собеседником при том же публичном ключе:
        // запись ПЕРЕИМЕНОВЫВАЕТСЯ, старый адрес исчезает, дубля нет.
        with_test_keys(|| {
            let old = StoredPeerKey {
                email: "old@x".to_string(),
                public_key: "1122334455667788".to_string(),
                label: Some("Old Label".to_string()),
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: Some("pq-old".to_string()),
            };
            add_peer_key(old).unwrap();

            // Тот же public_key, новый email; pq=None — не должен затирать
            // сохранённый ранее PQ-ключ контакта.
            let renamed = StoredPeerKey {
                email: "new@x".to_string(),
                public_key: "1122334455667788".to_string(),
                label: Some("New Label".to_string()),
                added_at: "2024-01-02T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            add_peer_key(renamed).unwrap();

            let keys = load_peer_keys().unwrap();
            assert_eq!(keys.len(), 1, "после смены почты должна остаться 1 запись");
            assert_eq!(keys[0].email, "new@x");
            assert!(
                keys.iter().all(|k| !k.email.eq_ignore_ascii_case("old@x")),
                "старый адрес не должен остаться в peer_keys.json"
            );
            assert_eq!(keys[0].pq_public_key.as_deref(), Some("pq-old"));
            assert_eq!(keys[0].label.as_deref(), Some("New Label"));

            // email совпадает — прежнее поведение не тронуто: явный pq
            // из того же адреса обновляет существующий.
            let pq_update = StoredPeerKey {
                email: "new@x".to_string(),
                public_key: "1122334455667788".to_string(),
                label: None,
                added_at: "2024-01-03T00:00:00Z".to_string(),
                pq_public_key: Some("pq-new".to_string()),
            };
            add_peer_key(pq_update).unwrap();
            let keys = load_peer_keys().unwrap();
            assert_eq!(keys.len(), 1);
            assert_eq!(keys[0].pq_public_key.as_deref(), Some("pq-new"));
        });
    }

    #[test]
    fn test_add_peer_key_same_email_updates_without_duplicate() {
        // (b) Регрессия: двойной вызов с ОДНИМ email обновляет запись,
        // а не создаёт вторую.
        with_test_keys(|| {
            let v1 = StoredPeerKey {
                email: "same@x".to_string(),
                public_key: "aabbccdd".to_string(),
                label: Some("V1".to_string()),
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            add_peer_key(v1).unwrap();
            let v2 = StoredPeerKey {
                email: "same@x".to_string(),
                public_key: "aabbccdd".to_string(),
                label: Some("V2".to_string()),
                added_at: "2024-01-02T00:00:00Z".to_string(),
                pq_public_key: Some("pq2".to_string()),
            };
            add_peer_key(v2).unwrap();

            let keys = load_peer_keys().unwrap();
            assert_eq!(keys.len(), 1, "дубля быть не должно");
            assert_eq!(keys[0].email, "same@x");
            assert_eq!(keys[0].label.as_deref(), Some("V2"));
            assert_eq!(keys[0].pq_public_key.as_deref(), Some("pq2"));
        });
    }

    #[test]
    fn test_add_peer_key_rejects_non_email_address() {
        // ADDRESS GATE (живой баг 06.10.2026): запись-«отпечаток»
        // fp:<fingerprint> попала в peer_keys и показывалась в UI как
        // контакт. Не-email / fp:-префикс должен отвергаться на записи.
        with_tmp_keys(|| {
            for bad in [
                "fp:2b:e1:c9:30:d1:b9:1b:85:aa:bb".to_string(),
                "  FP:2b:e1:aa  ".to_string(), // регистр + пробелы
                "not-an-email".to_string(),    // без '@'
                "".to_string(),                // пусто
            ] {
                let rec = StoredPeerKey {
                    email: bad.clone(),
                    public_key: "deadbeef".to_string(),
                    label: None,
                    added_at: "2024-01-01T00:00:00Z".to_string(),
                    pq_public_key: None,
                };
                let err = add_peer_key(rec).unwrap_err();
                assert!(
                    err.to_string().contains("must be an email"),
                    "должен отвергнуть {:?}, получил: {}",
                    bad,
                    err
                );
            }
            assert!(
                load_peer_keys().unwrap().is_empty(),
                "ни одна не-email запись не должна сохраниться"
            );

            // Настоящий адрес — проходит.
            let good = StoredPeerKey {
                email: "peer@example.com".to_string(),
                public_key: "ffff0000".to_string(),
                label: None,
                added_at: "2024-01-01T00:00:00Z".to_string(),
                pq_public_key: None,
            };
            add_peer_key(good).unwrap();
            assert_eq!(load_peer_keys().unwrap().len(), 1);
        });
    }
}
