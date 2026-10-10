//! Движок применения (state-machine) и восстановления журнала.
//!
//! Принимает ТОЛЬКО провалидированный [`ParsedBackup`] (разбор сделан снаружи).
//! Здесь — вся работа с диском и SQLite. Секреты/байты ключей НИКОГДА не
//! попадают в лог/Err: наружу отдаются структурные сообщения. Манифест журнала
//! НЕ содержит байтов ключей — только структуру (пути/флаги/txid/режим).
//!
//! Жизненный цикл одного импорта (txid = имя подкаталога журнала):
//!   PREPARING ( disposable ) --persist+fsync+rename--> ACTIVE ( durable )
//!   ACTIVE + BEGIN IMMEDIATE: promote target1/2 (fsync+rename+parent fsync),
//!   KV DELETE+INSERT + маркер коммита в ОДНОЙ транзакции -> COMMIT.
//!   Пост-COMMIT: ACTIVE -> FINISHED (rename+fsync parent), удалить FINISHED,
//!   снять SQL-маркер. Ошибка ДО COMMIT: rollback + restore OLD из журнала.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::{
    Config, ImportOutcome, ParsedBackup, ERR_IO, ERR_MALFORMED_JOURNAL, FINISHED_DIR, LOCK_FILE,
    MANIFEST_FILE, PREPARING_DIR, RECOVERY_DIR,
};

/// Фиксированное имя файла keypair (allowlist).
const TARGET_KEYPAIR: &str = "keypair.json";
/// Фиксированное имя файла peers (allowlist).
const TARGET_PEERS: &str = "peer_keys.json";

/// Режим завершения транзакции журнала (сериализуется в манифест).
/// `commit` — маркер коммита уже в БД, цели = NEW. `rollback` — маркера нет,
/// цели = OLD. `pending` — записано в журнал, но COMMIT ещё не разрешился
/// (неоднозначность): recovery читает durable-маркер и решает.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TxMode {
    Commit,
    Rollback,
    Pending,
}

/// Цель в манифесте: allowlist-имя + был ли старый файл присутствующим.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct JournalTarget {
    pub(crate) name: String,
    pub(crate) old_present: bool,
}

/// Манифест активного журнала. БЕЗ байтов ключей. txid = имя каталога журнала.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) version: u32,
    pub(crate) txid: String,
    pub(crate) mode: TxMode,
    pub(crate) targets: Vec<JournalTarget>,
    pub(crate) db_path: String,
}

/// Проверка allowlist целевого имени (fail-closed на неизвестное).
pub(crate) fn is_allowed_target(name: &str) -> bool {
    matches!(name, TARGET_KEYPAIR | TARGET_PEERS)
}

// ─────────────────────────── пути журнала ───────────────────────────────

/// Каталог активного/готового журнала для txid.
fn journal_dir(keys_dir: &Path, txid: &str) -> PathBuf {
    keys_dir.join(RECOVERY_DIR).join(txid)
}
/// Файл манифеста активного журнала.
fn manifest_path(keys_dir: &Path, txid: &str) -> PathBuf {
    journal_dir(keys_dir, txid).join(MANIFEST_FILE)
}
/// Имя файла старого состояния цели в журнале.
fn old_name(name: &str) -> String {
    format!("old-{name}")
}
/// Имя файла нового состояния цели в журнале.
fn new_name(name: &str) -> String {
    format!("new-{name}")
}

/// Путь к постоянному файлу блокировки (НЕ удаляется).
pub(crate) fn lock_path(keys_dir: &Path) -> PathBuf {
    keys_dir.join(LOCK_FILE)
}

/// ensure_dir_0700: создать каталог и (best-effort) выставить 0700.
fn ensure_dir_0700(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| ERR_IO)?;
    set_mode(path, 0o700);
    Ok(())
}

/// set_mode: best-effort выставление прав (Unix). На не-Unix — no-op.
fn set_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

/// fsync каталога (best-effort; некоторые ФС не позволяют — не критично).
fn fsync_dir(path: &Path) {
    if let Ok(d) = File::open(path) {
        let _ = d.sync_all();
    }
}

/// Постоянный процесс-lock (flock). Guard в этом модуле — тонкая обёртка:
/// std::fs::File::lock (flock) на постоянном LOCK_FILE. Блокирует другие
/// потоки/процессы до unlock. Ошибка захвата — Err (не best-effort).
pub(crate) struct ProcessLock {
    file: File,
}

impl ProcessLock {
    /// Заблокировать процесс на время импорта. LOCK_FILE создаётся 0600 и
    /// НИКОГДА не удаляется (живёт постоянно).
    pub(crate) fn acquire(keys_dir: &Path) -> Result<Self> {
        ensure_dir_0700(keys_dir)?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(lock_path(keys_dir))
            .with_context(|| ERR_IO)?;
        set_mode(&lock_path(keys_dir), 0o600);
        // flock: блокирует до освобождения другим владельцем. Ошибка — Err.
        file.lock().map_err(|_| anyhow!(ERR_IO))?;
        Ok(Self { file })
    }
}

impl Drop for ProcessLock {
    fn drop(&mut self) {
        // Разблокировка (файл остаётся на диске — не удаляем).
        let _ = self.file.unlock();
    }
}

// ─────────────────────────── манифест ──────────────────────────────────

/// Записать манифест в preparing-каталог и fsync файла+родителя.
fn write_manifest(prep_dir: &Path, manifest: &Manifest) -> Result<()> {
    let bytes = serde_json::to_vec(manifest).map_err(|_| anyhow!(ERR_MALFORMED_JOURNAL))?;
    let mpath = prep_dir.join(MANIFEST_FILE);
    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&mpath)
        .with_context(|| ERR_IO)?;
    f.write_all(&bytes).with_context(|| ERR_IO)?;
    f.sync_all().with_context(|| ERR_IO)?;
    set_mode(&mpath, 0o600);
    fsync_dir(prep_dir);
    Ok(())
}

/// Прочитать и провалидировать манифест активного журнала. Fail-closed:
/// повреждённый/усечённый/неизвестная цель/битый txid -> Err, ничего не удаляем.
fn read_manifest(keys_dir: &Path, txid: &str) -> Result<Manifest> {
    let mpath = manifest_path(keys_dir, txid);
    // Защита от симлинка на манифест: читаем ТОЛЬКО обычный файл.
    let meta = fs::symlink_metadata(&mpath).map_err(|_| anyhow!(ERR_MALFORMED_JOURNAL))?;
    if !meta.is_file() {
        bail!(ERR_MALFORMED_JOURNAL);
    }
    let data = fs::read(&mpath).map_err(|_| anyhow!(ERR_MALFORMED_JOURNAL))?;
    let m: Manifest = serde_json::from_slice(&data).map_err(|_| anyhow!(ERR_MALFORMED_JOURNAL))?;
    // Структурная валидация (fail-closed на любую аномалию).
    if m.version != 1 {
        bail!(ERR_MALFORMED_JOURNAL);
    }
    if !is_valid_txid(&m.txid) || m.txid != txid {
        bail!(ERR_MALFORMED_JOURNAL);
    }
    if m.targets.is_empty() {
        bail!(ERR_MALFORMED_JOURNAL);
    }
    let mut seen = std::collections::HashSet::new();
    for t in &m.targets {
        if !is_allowed_target(&t.name) {
            bail!(ERR_MALFORMED_JOURNAL);
        }
        if !seen.insert(t.name.clone()) {
            bail!(ERR_MALFORMED_JOURNAL);
        }
    }
    if m.db_path.trim().is_empty() {
        bail!(ERR_MALFORMED_JOURNAL);
    }
    Ok(m)
}

/// Проверка: txid = ровно 32 hex (как gen_txid). Иначе — посторонний каталог.
fn is_valid_txid(txid: &str) -> bool {
    txid.len() == 32 && txid.bytes().all(|b| b.is_ascii_hexdigit())
}

// ───────────────────── durable writes + promote ────────────────────────

/// Атомарно перезаписать файл: пишем в sibling-temp, fsync файла, rename,
/// fsync родителя. Отвергаем симлинк-цель (fail-closed, не проходим по ссылке).
fn durable_write(target: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    if let Ok(meta) = fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() {
            bail!(ERR_IO);
        }
    }
    let parent = target.parent().ok_or_else(|| anyhow!(ERR_IO))?;
    // Уникальный temp-имя рядом с целью (тот же ФС — rename атомарен).
    let tmp = parent.join(format!(
        ".recovery-tmp-{}-{}",
        std::process::id(),
        unique_nonce()
    ));
    {
        let mut f = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp)
            .with_context(|| ERR_IO)?;
        f.write_all(bytes).with_context(|| ERR_IO)?;
        f.sync_all().with_context(|| ERR_IO)?;
        set_mode(&tmp, mode);
    }
    fs::rename(&tmp, target).with_context(|| ERR_IO)?;
    fsync_dir(parent);
    Ok(())
}

/// Прочитать целевой файл, если он есть. Симлинк — Err (fail-closed).
fn read_target(target: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(target) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                bail!(ERR_IO);
            }
            if !meta.is_file() {
                bail!(ERR_IO);
            }
            let bytes = fs::read(target).with_context(|| ERR_IO)?;
            Ok(Some(bytes))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => bail!(ERR_IO),
    }
}

/// Небольшой nonce для уникальности temp-имён (не секрет, только имя).
fn unique_nonce() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // Добавляем адрес стековой переменной как дополнительный источник уникальности.
    let marker = 0u8;
    t ^ ((&marker as *const u8 as u128) << 16)
}

/// Сохранить staged-байты в preparing-каталог (old-*/new-*). fsync файла+родителя.
fn stage_bytes(prep_dir: &Path, file_name: &str, bytes: &[u8]) -> Result<()> {
    let path = prep_dir.join(file_name);
    let mut f = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .with_context(|| ERR_IO)?;
    f.write_all(bytes).with_context(|| ERR_IO)?;
    f.sync_all().with_context(|| ERR_IO)?;
    set_mode(&path, 0o600);
    fsync_dir(prep_dir);
    Ok(())
}

/// Прочитать staged-байты из журнала (old-*/new-*). Отсутствие файла -> None.
fn read_staged(journal: &Path, file_name: &str) -> Result<Option<Vec<u8>>> {
    let path = journal.join(file_name);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => Ok(Some(fs::read(&path).with_context(|| ERR_IO)?)),
        _ => Ok(None),
    }
}

/// Продвижение одной цели: new-байты из журнала -> целевой файл (durable).
/// old-present=true, но new-файла нет (аномалия) — fail-closed.
fn promote_target(keys_dir: &Path, journal: &Path, name: &str, old_present: bool) -> Result<()> {
    let target = keys_dir.join(name);
    match read_staged(journal, &new_name(name))? {
        Some(new_bytes) => durable_write(&target, &new_bytes, 0o600),
        None => {
            if old_present {
                // Журнал обещал старое состояние, но new отсутствует — не трогаем.
                bail!(ERR_MALFORMED_JOURNAL);
            }
            Ok(())
        }
    }
}

/// Восстановление старого состояния цели из журнала: old-байты -> цель, либо
/// (old отсутствовал) удалить целевой файл. Идемпотентно.
fn restore_target(keys_dir: &Path, journal: &Path, name: &str, old_present: bool) -> Result<()> {
    let target = keys_dir.join(name);
    if !old_present {
        // Старого файла НЕ было (манифест это фиксирует): staged old- содержит
        // пустой placeholder — писать его как «старые байты» нельзя, rollback
        // создал бы файл, которого никогда не было. Убираем цель, если она
        // появилась. Ошибка удаления (кроме NotFound) — fail-closed Err.
        return match fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(anyhow!(ERR_IO)),
        };
    }
    match read_staged(journal, &old_name(name))? {
        Some(old_bytes) => durable_write(&target, &old_bytes, 0o600),
        // Журнал обещал старые байты, но их нет — восстановление невозможно.
        None => bail!(ERR_MALFORMED_JOURNAL),
    }
}

// ─────────────────────── fault-injection checkpoints ───────────────────
//
// Детерминированные точки останова для тестов. Тест задаёт ЗАРАНЕЕ набор
// (фаза -> Err). checkpoint() возвращает Err, если текущая фаза в наборе —
// моделирует «ошибку на этом шаге». Фаза вида "after:commit" — особый маркер
// границы коммита (см. commit_boundary): возврат управления БЕЗ cleanup
// моделирует обрыв сразу ПОСЛЕ COMMIT. Хук изолирован (thread-local), не
// процесс-глобальный env.

type Cp = std::cell::RefCell<std::collections::HashMap<String, Result<(), ()>>>;

thread_local! {
    static CHECKPOINTS: Cp = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// Программная точка останова. Ok — продолжить; Err — смоделировать сбой фазы.
fn checkpoint(phase: &str) -> Result<()> {
    CHECKPOINTS.with(|c| {
        // Значение: Ok(()) — пройти, Err(()) — смоделировать сбой (без секретов).
        match c.borrow().get(phase) {
            Some(Ok(())) => Ok(()),
            Some(Err(())) => Err(anyhow!(ERR_IO)),
            None => Ok(()),
        }
    })
}

/// Настроить fault-injection (тесты). Заменяет текущий набор точек.
/// Значение фазы: Ok(()) — пройти, Err(()) — смоделировать сбой (без секретов).
#[cfg(test)]
pub(crate) fn set_checkpoints(map: std::collections::HashMap<String, Result<(), ()>>) {
    CHECKPOINTS.with(|c| *c.borrow_mut() = map);
}

/// Очистить точки (тесты).
#[cfg(test)]
pub(crate) fn clear_checkpoints() {
    CHECKPOINTS.with(|c| c.borrow_mut().clear());
}

// ─────────────────────────── apply ─────────────────────────────────────

/// Применение валидированного backup. Parse сделан снаружи. Вся работа с
/// диском/БД — здесь, под процесс-локом. Возвращает Ok только если цели
/// durable + маркер коммита в БД (граница коммита пройдена).
pub(crate) fn apply(cfg: &Config, parsed: &ParsedBackup) -> Result<ImportOutcome> {
    // Процесс-lock: сериализует импорты (и нормальные ключ-операции идут через
    // тот же lock в key_store на этом же keys_dir). Ошибка захвата — Err.
    let _lock = ProcessLock::acquire(&cfg.keys_dir)?;
    apply_locked(cfg, parsed)
}

/// Ядро apply БЕЗ ProcessLock — для вызывающего, который УЖЕ держит исключение
/// на этом keys_dir (KeysGuard: тот же LOCK_FILE flock). Вложенный flock того
/// же файла через другой дескриптор заблокировал бы сам себя (дедлок).
pub(crate) fn apply_locked(cfg: &Config, parsed: &ParsedBackup) -> Result<ImportOutcome> {
    // 0. Не начинать новый импорт поверх чужого ожидающего журнала: если активный
    //    журнал остался от прерванного импорта — это ошибка состояния (recover
    //    должен был отработать на барьере). Fail-closed.
    if find_active_journal(&cfg.keys_dir)?.is_some() {
        bail!("recovery: ожидающий журнал blocking новый импорт");
    }

    // Preparing-каталог disposable: подчищаем возможный мусор прошлого раза.
    let prep_parent = cfg.keys_dir.join(RECOVERY_DIR);
    ensure_dir_0700(&prep_parent)?;
    let preparing = cfg.keys_dir.join(PREPARING_DIR);
    let _ = fs::remove_dir_all(&preparing);
    ensure_dir_0700(&preparing)?;

    // 1. txid + план (какие цели трогаем, были ли старые).
    let txid = super::gen_txid();
    let plan = build_plan(parsed);
    // KV-only импорт валиден (целей-файлов 0, но kv Some). Иначе — нечего делать.
    if plan.is_empty() && parsed.kv.is_none() {
        bail!(super::ERR_NOTHING_TO_RESTORE);
    }

    // 2. Staging old/new байтов в preparing (fsync файла+родителя) ДО manifest.
    checkpoint("stage-write")?;
    for name in &plan {
        let target = cfg.keys_dir.join(name);
        let old = read_target(&target)?;
        let new_bytes = new_bytes_for(parsed, name)?;
        stage_bytes(&preparing, &old_name(name), &old.unwrap_or_default())?;
        stage_bytes(&preparing, &new_name(name), &new_bytes)?;
    }
    checkpoint("stage-fsync")?;

    // 3. Публикуем активный журнал: manifest -> fsync -> rename preparing->active.
    let mut targets: Vec<JournalTarget> = Vec::with_capacity(plan.len());
    for name in &plan {
        let old_present = read_target(&cfg.keys_dir.join(name))?.is_some();
        targets.push(JournalTarget {
            name: name.clone(),
            old_present,
        });
    }
    let manifest = Manifest {
        version: 1,
        txid: txid.clone(),
        mode: TxMode::Pending,
        targets,
        db_path: cfg.db_path.to_string_lossy().to_string(),
    };
    write_manifest(&preparing, &manifest)?;
    let journal = journal_dir(&cfg.keys_dir, &txid);
    checkpoint("active-publish")?;
    fs::rename(&preparing, &journal).with_context(|| ERR_IO)?;
    fsync_dir(&prep_parent);

    // 4. Коммит-граница: promote цели -> SQL (KV+маркер) в одной транзакции.
    match commit_boundary(cfg, &journal, &manifest, &parsed.kv)? {
        Boundary::PreCommitFailure => {
            // Сбой ДО commit: restore OLD (для всех целей). Отсутствовавший
            // старый — удалить. Журнал сохраняем для recover (идемпотентно).
            // Если сам restore падает по I/O — Err fail-closed (не «успех»).
            rollback_after_failure(&cfg.keys_dir, &journal, &manifest)?;
            return Err(anyhow!(ERR_IO));
        }
        Boundary::CrashedAfterCommit => {
            // Обрыв сразу ПОСЛЕ COMMIT (модель): маркер durable, файлы уже
            // валидны, но cleanup НЕ выполнен. По ТЗ (f) граница пройдена —
            // возвращаем Ok, НЕ откатываем. Журнал остаётся, добирается recover.
            return Ok(outcome_for(parsed));
        }
        Boundary::Committed => {
            // Граница коммита пройдена штатно. Cleanup — best-effort (любая
            // ошибка -> Ok, журнал добирается recover).
            best_effort_cleanup(cfg, &journal, &manifest);
            Ok(outcome_for(parsed))
        }
    }
}

// ─────────────────────── вспомогательные для apply ─────────────────────

/// Список целей (allowlist-имён), которые затрагивает backup.
fn build_plan(parsed: &ParsedBackup) -> Vec<String> {
    let mut v = Vec::new();
    if let Some(k) = &parsed.keys {
        if k.keypair.is_some() {
            v.push(TARGET_KEYPAIR.to_string());
        }
        if k.peers.is_some() {
            v.push(TARGET_PEERS.to_string());
        }
    }
    // KV-only не трогает файлы, но это валидный план (целей 0). Обрабатывается
    // отдельно: apply не баит «нечего восстанавливать», т.к. kv может быть Some.
    v
}

/// Новые байты для целевого файла (сериализация валидированной структуры).
fn new_bytes_for(parsed: &ParsedBackup, name: &str) -> Result<Vec<u8>> {
    let k = parsed
        .keys
        .as_ref()
        .ok_or_else(|| anyhow!(ERR_MALFORMED_JOURNAL))?;
    let s = if name == TARGET_KEYPAIR {
        serde_json::to_string_pretty(
            k.keypair
                .as_ref()
                .ok_or_else(|| anyhow!(ERR_MALFORMED_JOURNAL))?,
        )
    } else if name == TARGET_PEERS {
        serde_json::to_string_pretty(
            k.peers
                .as_ref()
                .ok_or_else(|| anyhow!(ERR_MALFORMED_JOURNAL))?,
        )
    } else {
        bail!(ERR_MALFORMED_JOURNAL);
    };
    s.map(|v| v.into_bytes())
        .map_err(|_| anyhow!(ERR_MALFORMED_JOURNAL))
}

/// Сводка исхода (без секретов) — для сообщения вызывающему.
fn outcome_for(parsed: &ParsedBackup) -> ImportOutcome {
    ImportOutcome {
        keypair: parsed
            .keys
            .as_ref()
            .map(|k| k.keypair.is_some())
            .unwrap_or(false),
        peers: parsed
            .keys
            .as_ref()
            .and_then(|k| k.peers.as_ref().map(|p| p.len())),
        kv: parsed.kv.as_ref().map(|v| v.len()),
    }
}

/// Найти единственный активный журнал (валидный txid-каталог с манифестом).
/// Возвращает Some(txid) либо None. Ошибка чтения каталога recovery — Err.
fn find_active_journal(keys_dir: &Path) -> Result<Option<String>> {
    let rec = keys_dir.join(RECOVERY_DIR);
    let entries = match fs::read_dir(&rec) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    for ent in entries {
        let ent = ent.with_context(|| ERR_IO)?;
        let name = ent.file_name().to_string_lossy().to_string();
        if is_valid_txid(&name) {
            // Это кандидат активного журнала.
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// Результат коммит-границы: где именно оборвалось управление.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Boundary {
    /// Сбой ДО COMMIT (checkpoint/promote/SQL) — нужен rollback к OLD.
    PreCommitFailure,
    /// Обрыв сразу ПОСЛЕ COMMIT (checkpoint after:commit): маркер durable,
    /// файлы валидны, но cleanup не выполнен — граница пройдена, НЕ откатываем.
    CrashedAfterCommit,
    /// COMMIT прошёл штатно и cleanup можно выполнять.
    Committed,
}

/// Коммит-граница: promote цели (durable) ДО SQL, затем KV+маркер в одной
/// транзакции. Различает сбой ДО COMMIT (rollback) и обрыв сразу ПОСЛЕ COMMIT
/// (граница пройдена, откат запрещён). checkpoint-фазы:
///   target1/target2 — перед/между promote (PreCommitFailure);
///   sql-delete/sql-insert — перед SQL-транзакцией (PreCommitFailure);
///   after:commit — ПОСЛЕ успешного COMMIT (CrashedAfterCommit).
fn commit_boundary(
    cfg: &Config,
    journal: &Path,
    manifest: &Manifest,
    kv: &Option<Vec<(String, String, String)>>,
) -> Result<Boundary> {
    // (c) promote целевых файлов ДО SQL commit. fsynced temp+rename+parent fsync.
    for (i, t) in manifest.targets.iter().enumerate() {
        if checkpoint(&format!("target{}", i + 1)).is_err() {
            return Ok(Boundary::PreCommitFailure);
        }
        if promote_target(&cfg.keys_dir, journal, &t.name, t.old_present).is_err() {
            return Ok(Boundary::PreCommitFailure);
        }
    }
    // Сбои на шагах SQL ДО COMMIT тоже требуют rollback.
    if checkpoint("sql-delete").is_err() {
        return Ok(Boundary::PreCommitFailure);
    }
    if checkpoint("sql-insert").is_err() {
        return Ok(Boundary::PreCommitFailure);
    }

    // KV+маркер в ОДНОЙ транзакции (kv None — KV не трогаем, но маркер коммита
    // всё равно ставим, т.к. файлы уже продвинуты).
    let db_path = Path::new(&manifest.db_path);
    let commit_res = crate::storage::sqlite::Storage::commit_kv_and_marker_raw(
        db_path,
        &manifest.txid,
        kv.as_deref(),
    );
    match commit_res {
        Ok(()) => {
            // Модель обрыва сразу ПОСЛЕ COMMIT: маркер durable, файлы валидны,
            // но управление уходит БЕЗ cleanup. Возвращаем CrashedAfterCommit
            // (не Err) — граница коммита пройдена, откат запрещён (ТЗ g).
            if checkpoint("after:commit").is_err() {
                return Ok(Boundary::CrashedAfterCommit);
            }
            Ok(Boundary::Committed)
        }
        // Err COMMIT неоднозначен: транзакция МОГЛА успеть закоммититься, а
        // ошибка прийти после. Решаем по durable-маркеру, а не слепым откатом
        // (ТЗ g). Маркер нечитаем/нет → откат; журнал остаётся, recover
        // разберётся fail-closed при нечитаемости (см. recover_pending).
        Err(_) => {
            match crate::storage::sqlite::Storage::marker_present_raw(db_path, &manifest.txid) {
                Ok(true) => Ok(Boundary::CrashedAfterCommit),
                _ => Ok(Boundary::PreCommitFailure),
            }
        }
    }
}

/// Rollback после сбоя ДО commit: restore OLD для всех целей. Идемпотентно.
/// Возвращает Ok, если все цели восстановлены (или журнал остаётся + Err при
/// невозможности restore по I/O — fail-closed, НЕ «успех»).
fn rollback_after_failure(keys_dir: &Path, journal: &Path, manifest: &Manifest) -> Result<()> {
    for t in &manifest.targets {
        restore_target(keys_dir, journal, &t.name, t.old_present)?;
    }
    Ok(())
}

// ─────────────────────── cleanup (best-effort, post-commit) ────────────

/// Cleanup ПОСЛЕ commit (граница пройдена). Любая ошибка — игнорируется (Ok на
/// стороне apply): журнал добирается recover. Идемпотентно.
///   1) active -> finished (rename + fsync родителя);
///   2) удалить finished;
///   3) снять SQL-маркер.
fn best_effort_cleanup(cfg: &Config, journal: &Path, manifest: &Manifest) {
    let rec = cfg.keys_dir.join(RECOVERY_DIR);
    let finished = cfg.keys_dir.join(FINISHED_DIR);
    // (1) active -> finished
    let _ = fs::remove_dir_all(&finished); // подчистить прошлый finished
    if fs::rename(journal, &finished).is_ok() {
        fsync_dir(&rec);
    } else {
        // rename не удался (напр. finished и journal на разных ФС) — копируем.
        // Здесь оба в пределах keys_dir, поэтому это маловероятно; best-effort.
        return;
    }
    // (2) удалить finished
    let _ = fs::remove_dir_all(&finished);
    fsync_dir(&rec);
    // (3) снять SQL-маркер (idempotent)
    let db_path = Path::new(&manifest.db_path);
    let _ = crate::storage::sqlite::Storage::clear_marker_raw(db_path, &manifest.txid);
}

// ─────────────────────── recover_pending ───────────────────────────────

/// Восстановление ОЖИДАЮЩЕГО журнала. Идемпотентно: если активного журнала нет
/// — Ok (ничего не делаем). Если есть — читаем манифест, по durable-маркеру в БД
/// решаем old/new, доводим состояние, чистим. Повреждённый манифест ИЛИ
/// нечитаемый маркер — Err (fail-closed, НЕ удаляем и НЕ угадываем).
/// Может вызываться многократно (посреди cleanup).
///
/// СИНХРОНИЗАЦИЯ — на вызывающем: функция сама ProcessLock НЕ берёт, т.к.
/// вызывается (а) под захваченным KeysGuard (тот же LOCK_FILE flock) — из
/// guard'а key_store, (б) под ProcessLock — из обёртки recover_pending()
/// (тесты/PM) и стартового барьера. Вложенный flock того же файла здесь был
/// бы дедлоком на том же потоке.
pub(crate) fn recover_pending(cfg: &Config) -> Result<()> {
    let Some(txid) = find_active_journal(&cfg.keys_dir)? else {
        return Ok(());
    };
    // Читаем и валидируем манифест (fail-closed при любой аномалии).
    let manifest = read_manifest(&cfg.keys_dir, &txid)?;
    let journal = journal_dir(&cfg.keys_dir, &txid);
    let db_path = Path::new(&manifest.db_path);

    // (g) Неоднозначность коммита: решаем по durable-маркеру в БД.
    //   маркер есть -> новые файлы уже валидны, доводим до NEW (не откат);
    //   маркера нет -> откат к OLD.
    // Fail-closed: ошибку чтения маркера НЕ трактуем как «маркер нет» —
    // иначе можно откатить уже закоммиченный импорт. Журнал сохраняем, Err
    // наружу; после восстановления БД повторная попытка решит однозначно.
    let committed = match crate::storage::sqlite::Storage::marker_present_raw(db_path, &txid) {
        Ok(v) => v,
        Err(_) => bail!(ERR_IO),
    };

    if committed {
        // Доводим до NEW (на случай обрыва между promote и commit, либо посреди).
        for t in &manifest.targets {
            promote_target(&cfg.keys_dir, &journal, &t.name, t.old_present)?;
        }
    } else {
        // Откат к OLD (сбой ДО commit).
        for t in &manifest.targets {
            restore_target(&cfg.keys_dir, &journal, &t.name, t.old_present)?;
        }
    }

    // Cleanup (best-effort): active -> finished -> удалить -> снять маркер.
    best_effort_cleanup(cfg, &journal, &manifest);
    Ok(())
}
