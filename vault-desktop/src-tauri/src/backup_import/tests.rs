//! Тесты атомарного импорта (t_12f15e61). Все пути — явные подкаталоги в
//! TMPDIR (`/home/maksim/.hermes/cache/scratch/...`), НЕ процесс-глобальный env,
//! НЕ реальный HOME. Кейсы «остановка управления» (checkpoint/return) —
//! МОДЕЛЬ обрыва (return-control), не реальный kill -9.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::Result;

use super::ops::{clear_checkpoints, set_checkpoints};
use super::{import_at, recover_pending, Config};

static SEQ: AtomicU32 = AtomicU32::new(0);

/// Уникальный scratch-каталог под TMPDIR (или temp_dir как fallback).
fn scratch(sub: &str) -> PathBuf {
    let base = std::env::var("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let dir = base.join(format!("bi_test-{}-{}-{}", std::process::id(), sub, n));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Прочитать файл как байты (или None, если отсутствует).
fn read_bytes(p: &Path) -> Option<Vec<u8>> {
    fs::read(p).ok()
}

/// Прочитать все KV из БД (account,key,value), отсортированно для стабильного
/// сравнения. Возвращает пустой Vec, если БД/таблицы ещё нет.
fn read_kv(db: &Path) -> Vec<(String, String, String)> {
    let conn = match rusqlite::Connection::open(db) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut stmt = match conn.prepare("SELECT account, key, value FROM kv_store") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    });
    let mut out: Vec<(String, String, String)> = match rows {
        Ok(map) => map.filter_map(|x| x.ok()).collect(),
        Err(_) => return Vec::new(),
    };
    out.sort();
    out
}

/// Наличие активного журнала (каталог .recovery-import с валидным txid-подкат).
fn active_journal_exists(keys_dir: &Path) -> bool {
    let rec = keys_dir.join(super::RECOVERY_DIR);
    match fs::read_dir(&rec) {
        Ok(rd) => rd.filter_map(|e| e.ok()).any(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit())
        }),
        Err(_) => false,
    }
}

/// Синтетический валидный keypair (distinct pub/priv, 64-hex). Не печатается.
fn synth_keypair(pub_byte: char, priv_byte: char) -> String {
    let pubk: String = std::iter::repeat(pub_byte).take(64).collect();
    let prvk: String = std::iter::repeat(priv_byte).take(64).collect();
    format!(
        r#"{{"public_key":"{pubk}","private_key":"{prvk}","created_at":"2024-01-01T00:00:00Z"}}"#
    )
}

/// Синтетический валидный peer.
fn synth_peer(email: &str, pub_byte: char) -> String {
    let pubk: String = std::iter::repeat(pub_byte).take(64).collect();
    format!(r#"{{"email":"{email}","public_key":"{pubk}","added_at":"2024-01-01T00:00:00Z"}}"#)
}

/// Собрать JSON backup с необязательными секциями.
fn backup_json(version: Option<u32>, keys: Option<&str>, kv: Option<&str>) -> String {
    let mut parts = Vec::new();
    if let Some(v) = version {
        parts.push(format!(r#""version":{v}"#));
    }
    if let Some(k) = keys {
        parts.push(format!(r#""keys":{k}"#));
    }
    if let Some(v) = kv {
        parts.push(format!(r#""kv_store":{v}"#));
    }
    format!("{{{}}}", parts.join(","))
}

/// KV-массив JSON из списка троек.
fn kv_json(entries: &[(&str, &str, &str)]) -> String {
    let items: Vec<String> = entries
        .iter()
        .map(|(a, k, v)| format!(r#"["{a}","{k}","{v}"]"#))
        .collect();
    format!("[{}]", items.join(","))
}

/// Изолированный тест-контекст: keys_dir + db_path под scratch.
struct Ctx {
    keys: PathBuf,
    db: PathBuf,
    _guard: PathBuf,
}

impl Ctx {
    fn new(tag: &str) -> Self {
        let root = scratch(tag);
        let keys = root.join("keys");
        let db = root.join("vault.db");
        fs::create_dir_all(&keys).unwrap();
        Ctx {
            keys,
            db,
            _guard: root,
        }
    }
    fn cfg(&self) -> Config {
        Config {
            keys_dir: self.keys.clone(),
            db_path: self.db.clone(),
        }
    }
}

impl Drop for Ctx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self._guard);
    }
}

// ─────────────────────── malformed inputs (fail-closed) ────────────────

/// Повреждённый вход => байт-в-байт старые файлы+KV, 0 target-writes,
/// 0 активный журнал, Err без секретов.
fn assert_malformed_no_write(tag: &str, json: &str) {
    let ctx = Ctx::new(tag);
    fs::write(ctx.keys.join("keypair.json"), b"OLD_KEYPAIR").unwrap();
    fs::write(ctx.keys.join("peer_keys.json"), b"OLD_PEERS").unwrap();
    let kp_before = read_bytes(&ctx.keys.join("keypair.json"));
    let pk_before = read_bytes(&ctx.keys.join("peer_keys.json"));
    let kv_before = read_kv(&ctx.db);

    let res = import_at(&ctx.keys, &ctx.db, json);
    assert!(res.is_err(), "{tag}: ожидался Err");
    let msg = format!("{}", res.unwrap_err());
    assert!(
        !msg.contains("OLD_"),
        "{tag}: утечка старых байтов в ошибке"
    );
    assert_eq!(
        read_bytes(&ctx.keys.join("keypair.json")),
        kp_before,
        "{tag}: keypair изменён"
    );
    assert_eq!(
        read_bytes(&ctx.keys.join("peer_keys.json")),
        pk_before,
        "{tag}: peers изменён"
    );
    assert_eq!(read_kv(&ctx.db), kv_before, "{tag}: KV изменён");
    assert!(
        !active_journal_exists(&ctx.keys),
        "{tag}: появился активный журнал"
    );
    let stray: Vec<_> = fs::read_dir(&ctx.keys)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.starts_with(".recovery-tmp"))
        .collect();
    assert!(stray.is_empty(), "{tag}: остались temp-файлы {stray:?}");
}

#[test]
fn malformed_json() {
    assert_malformed_no_write("malformed-json", "{ not json");
}

#[test]
fn unsupported_version() {
    let kp = format!(r#"{{"keypair":{}}}"#, synth_keypair('a', 'b'));
    assert_malformed_no_write("bad-version", &backup_json(Some(2), Some(&kp), None));
}

#[test]
fn malformed_keypair() {
    let bad = r#"{"public_key":"zz","private_key":"zz","created_at":"x"}"#;
    let keys = format!(r#"{{"keypair":{bad}}}"#);
    assert_malformed_no_write(
        "malformed-keypair",
        &backup_json(Some(1), Some(&keys), None),
    );
}

#[test]
fn malformed_late_peer() {
    let bad = r#"{"email":"p@x.io","public_key":"nothex","added_at":""}"#;
    let kp = synth_keypair('a', 'b');
    let keys = format!(r#"{{"keypair":{kp},"peer_keys":[{bad}]}}"#);
    assert_malformed_no_write(
        "malformed-late-peer",
        &backup_json(Some(1), Some(&keys), None),
    );
}

#[test]
fn malformed_kv_tuple() {
    let kv = r#"[["acc","only-two"]]"#;
    let kp = synth_keypair('a', 'b');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    assert_malformed_no_write("malformed-kv", &backup_json(Some(1), Some(&keys), Some(kv)));
}

// ─────────────────────── happy paths ───────────────────────────────────

#[test]
fn happy_full_import() {
    let ctx = Ctx::new("happy-full");
    let kp = synth_keypair('a', 'b');
    let peers = format!("[{},{}]", synth_peer("x@io", 'c'), synth_peer("y@io", 'd'));
    let keys = format!(r#"{{"keypair":{kp},"peer_keys":{peers}}}"#);
    let kv = kv_json(&[("acc", "k1", "v1"), ("acc", "k2", "v2")]);
    let json = backup_json(Some(1), Some(&keys), Some(&kv));

    let out = import_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert!(out.keypair);
    assert_eq!(out.peers, Some(2));
    assert_eq!(out.kv, Some(2));
    assert!(ctx.keys.join("keypair.json").exists());
    assert!(ctx.keys.join("peer_keys.json").exists());
    assert_eq!(read_kv(&ctx.db).len(), 2);
    assert!(!active_journal_exists(&ctx.keys));
}

#[test]
fn happy_keys_only() {
    let ctx = Ctx::new("happy-keys");
    let kp = synth_keypair('1', '2');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), None);
    let out = import_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert!(out.keypair);
    assert_eq!(out.peers, None);
    assert_eq!(out.kv, None);
    assert!(read_kv(&ctx.db).is_empty());
    assert!(!active_journal_exists(&ctx.keys));
}

#[test]
fn happy_kv_only() {
    let ctx = Ctx::new("happy-kv");
    let kv = kv_json(&[("acc", "k", "v")]);
    let json = backup_json(Some(1), None, Some(&kv));
    let out = import_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert!(!out.keypair);
    assert_eq!(out.kv, Some(1));
    assert!(!ctx.keys.join("keypair.json").exists());
    assert!(!ctx.keys.join("peer_keys.json").exists());
    assert_eq!(read_kv(&ctx.db).len(), 1);
    assert!(!active_journal_exists(&ctx.keys));
}

#[test]
fn happy_empty_peers_and_kv() {
    let ctx = Ctx::new("happy-empty");
    let kp = synth_keypair('3', '4');
    let keys = format!(r#"{{"keypair":{kp},"peer_keys":[]}}"#);
    let json = backup_json(Some(1), Some(&keys), Some("[]"));
    let out = import_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert!(out.keypair);
    assert_eq!(out.peers, Some(0));
    assert_eq!(out.kv, Some(0));
    assert!(read_kv(&ctx.db).is_empty());
    assert!(!active_journal_exists(&ctx.keys));
}

#[test]
fn omitted_sections_preserved() {
    let ctx = Ctx::new("omitted");
    fs::write(ctx.keys.join("peer_keys.json"), b"KEEP_PEERS").unwrap();
    let peers_before = read_bytes(&ctx.keys.join("peer_keys.json"));
    let kp = synth_keypair('5', '6');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), None);
    import_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert_eq!(read_bytes(&ctx.keys.join("peer_keys.json")), peers_before);
}

// ─────────────── fault-injection ДО commit → old + autocommit ───────────
// МОДЕЛЬ обрыва через return-control (checkpoint Err), НЕ реальный kill.

/// Для каждой из фаз ДО commit: старые байты+KV сохранены, ошибка.
fn assert_precommit_fault_preserves_old(tag: &str, phase: &str) {
    let ctx = Ctx::new(tag);
    // Старое состояние.
    fs::write(ctx.keys.join("keypair.json"), b"OLDKP").unwrap();
    fs::write(ctx.keys.join("peer_keys.json"), b"OLDPK").unwrap();
    let kp_before = read_bytes(&ctx.keys.join("keypair.json"));
    let pk_before = read_bytes(&ctx.keys.join("peer_keys.json"));
    let kv_before = read_kv(&ctx.db);

    let kp = synth_keypair('a', 'b');
    let peers = format!("[{}]", synth_peer("z@io", 'c'));
    let keys = format!(r#"{{"keypair":{kp},"peer_keys":{peers}}}"#);
    let kv = kv_json(&[("acc", "newk", "newv")]);
    let json = backup_json(Some(1), Some(&keys), Some(&kv));

    let mut m: HashMap<String, Result<(), ()>> = HashMap::new();
    m.insert(phase.to_string(), Err(()));
    set_checkpoints(m);
    let res = import_at(&ctx.keys, &ctx.db, &json);
    clear_checkpoints();

    // Ошибка до commit => восстановлен OLD (байт-в-байт).
    assert!(res.is_err(), "{tag}/{phase}: ожидался Err");
    assert_eq!(
        read_bytes(&ctx.keys.join("keypair.json")),
        kp_before,
        "{tag}/{phase}: keypair != OLD"
    );
    assert_eq!(
        read_bytes(&ctx.keys.join("peer_keys.json")),
        pk_before,
        "{tag}/{phase}: peers != OLD"
    );
    assert_eq!(read_kv(&ctx.db), kv_before, "{tag}/{phase}: KV изменён");
    // Рестарт безопасен: recovery не ломает, старая восстановленная копия цела.
    recover_pending(&ctx.cfg()).unwrap();
    assert_eq!(read_bytes(&ctx.keys.join("keypair.json")), kp_before);
    assert_eq!(read_kv(&ctx.db), kv_before);
    // После recovery активного журнала нет (откат добран).
    assert!(
        !active_journal_exists(&ctx.keys),
        "{tag}/{phase}: активный журнал остался"
    );
}

#[test]
fn precommit_fault_target1() {
    assert_precommit_fault_preserves_old("pc-t1", "target1");
}

#[test]
fn precommit_fault_target2() {
    assert_precommit_fault_preserves_old("pc-t2", "target2");
}

#[test]
fn precommit_fault_sql_delete() {
    assert_precommit_fault_preserves_old("pc-sd", "sql-delete");
}

#[test]
fn precommit_fault_sql_insert() {
    assert_precommit_fault_preserves_old("pc-si", "sql-insert");
}

// ─────────── симулированный обрыв сразу ПОСЛЕ commit → new ─────────────
// checkpoint("after:commit") возвращает управление БЕЗ cleanup: файлы уже NEW,
// маркер коммита в БД, журнал остаётся. Recovery доводит до NEW (не old).

#[test]
fn crash_after_commit_keeps_new() {
    let ctx = Ctx::new("after-commit");
    fs::write(ctx.keys.join("keypair.json"), b"OLDKP").unwrap();
    let kp_before = read_bytes(&ctx.keys.join("keypair.json"));

    let kp = synth_keypair('a', 'b');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), None);

    let mut m: HashMap<String, Result<(), ()>> = HashMap::new();
    m.insert("after:commit".to_string(), Err(()));
    set_checkpoints(m);
    let res = import_at(&ctx.keys, &ctx.db, &json);
    clear_checkpoints();

    // apply вернул Ok (граница коммита пройдена) — НЕ откат.
    assert!(res.is_ok(), "after-commit: ожидался Ok (граница пройдена)");
    // Файл уже NEW (не OLD).
    assert_ne!(read_bytes(&ctx.keys.join("keypair.json")), kp_before);
    // Журнал остаётся (cleanup оборван моделью).
    assert!(
        active_journal_exists(&ctx.keys),
        "after-commit: журнал должен остаться"
    );
    // Recovery: маркер есть → доводит до NEW, идемпотентно, убирает журнал.
    recover_pending(&ctx.cfg()).unwrap();
    assert!(
        !active_journal_exists(&ctx.keys),
        "after-commit: журнал не убран"
    );
    // Повторный recovery — тоже безопасен (идемпотентно).
    recover_pending(&ctx.cfg()).unwrap();
    assert_ne!(read_bytes(&ctx.keys.join("keypair.json")), kp_before);
}

// ───────────────── recovery: откат при отсутствии маркера ──────────────
// Модель: импорт оставил активный журнал (цели NEW на диске после promote),
// но COMMIT/маркер НЕ прошёл. Симулируем: делаем успешный импорт, затем
// удаляем SQL-маркер (имитируя не-commit) и переносим журнал в active вручную
// невозможно — поэтому проверяем recovery-idempotency через прерванный cleanup.

#[test]
fn recovery_idempotent_no_journal() {
    let ctx = Ctx::new("rec-idem");
    // Нет журнала — recover должен быть безопасным no-op.
    recover_pending(&ctx.cfg()).unwrap();
    recover_pending(&ctx.cfg()).unwrap();
    assert!(!active_journal_exists(&ctx.keys));
}

#[test]
fn cleanup_interrupted_next_startup_safe() {
    // Полный успешный импорт, затем ещё раз recover — идемпотентно Ok.
    let ctx = Ctx::new("cleanup-interrupt");
    let kp = synth_keypair('7', '8');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), None);
    import_at(&ctx.keys, &ctx.db, &json).unwrap();
    let after_import = read_bytes(&ctx.keys.join("keypair.json"));
    // «Прерванный cleanup»: журнал уже убран полным импортом; recover — no-op.
    recover_pending(&ctx.cfg()).unwrap();
    recover_pending(&ctx.cfg()).unwrap();
    assert_eq!(read_bytes(&ctx.keys.join("keypair.json")), after_import);
    assert!(!active_journal_exists(&ctx.keys));
}

// ───────────────────── corrupted manifest fail-closed ──────────────────

#[test]
fn corrupted_manifest_fail_closed() {
    let ctx = Ctx::new("corrupt");
    // Успешный импорт с обрывом ПОСЛЕ commit оставляет активный журнал.
    let kp = synth_keypair('a', 'b');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), None);
    let mut m: HashMap<String, Result<(), ()>> = HashMap::new();
    m.insert("after:commit".to_string(), Err(()));
    set_checkpoints(m);
    let _ = import_at(&ctx.keys, &ctx.db, &json);
    clear_checkpoints();
    assert!(active_journal_exists(&ctx.keys));

    // Портим манифест активного журнала.
    let rec = ctx.keys.join(super::RECOVERY_DIR);
    let txid = fs::read_dir(&rec)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .find(|n| n.len() == 32)
        .unwrap();
    let mpath = rec.join(&txid).join(super::MANIFEST_FILE);
    fs::write(&mpath, b"{ truncated").unwrap();

    // recover на повреждённом манифесте — Err (fail-closed), ничего не удаляем.
    let res = recover_pending(&ctx.cfg());
    assert!(res.is_err(), "corrupt: ожидался Err");
    // Журнал НЕ удалён (fail-closed).
    assert!(
        active_journal_exists(&ctx.keys),
        "corrupt: журнал удалён при ошибке"
    );
}

#[test]
fn symlink_target_rejected() {
    let ctx = Ctx::new("symlink");
    // Цель — симлинк: импорт обязан fail-closed, не проходя по ссылке.
    let outside = scratch("symlink-outside");
    fs::write(outside.join("secret"), b"OUTSIDE").unwrap();
    std::os::unix::fs::symlink(outside.join("secret"), ctx.keys.join("keypair.json")).unwrap();
    let kp = synth_keypair('a', 'b');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), None);
    let res = import_at(&ctx.keys, &ctx.db, &json);
    assert!(res.is_err(), "symlink: ожидался Err (fail-closed)");
    // Внешний файл не тронут.
    assert_eq!(
        read_bytes(&outside.join("secret")),
        Some(b"OUTSIDE".to_vec())
    );
    // Симлинк-цель осталась симлинком (не заменена на файл с байтами).
    assert!(ctx
        .keys
        .join("keypair.json")
        .symlink_metadata()
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(!active_journal_exists(&ctx.keys));
    let _ = fs::remove_dir_all(&outside);
}

// ─────────────────────── flock: второй поток ждёт ──────────────────────
// Модель contention через flock на постоянном LOCK_FILE. Пока main держит
// ProcessLock, поток B (делающий импорт того же keys_dir) блокируется на
// lock() и не может продвинуться. После release — B проходит.

#[test]
fn flock_second_thread_blocks() {
    use super::ops::ProcessLock;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    let ctx = Ctx::new("flock");

    // main захватывает лок ПЕРВЫМ (гарантия отсутствия гонки на старте).
    let held = ProcessLock::acquire(&ctx.keys).unwrap();

    let acquired_b = Arc::new(Mutex::new(false));
    let acquired_c = acquired_b.clone();
    let keys_b = ctx.keys.clone();
    let handle = thread::spawn(move || {
        // Пока main держит flock, этот acquire() обязан блокироваться.
        let _l = ProcessLock::acquire(&keys_b).unwrap();
        *acquired_c.lock().unwrap() = true;
    });

    // Даём B шанс дойти до блокировки на flock; он НЕ может захватить лок.
    thread::sleep(Duration::from_millis(200));
    assert!(
        !*acquired_b.lock().unwrap(),
        "flock: поток B захватил лок под удерживаемым main"
    );

    // Освобождаем — B разблокируется и завершит захват.
    drop(held);
    let start = Instant::now();
    while !*acquired_b.lock().unwrap() {
        if start.elapsed() > Duration::from_secs(5) {
            panic!("flock: поток B не разблокировался после release");
        }
        thread::sleep(Duration::from_millis(5));
    }
    handle.join().unwrap();
}

// ────────── t_12f15e61: KV-сохранность, generic-движок, fail-closed ──────────
// Позиционные проверки дефектов семантического ревью:
// (1) keys-only импорт не должен затирать существующий KV;
// (2) generic key_store::import_keys обязан идти через движок (строгий parse
//     всех peers + атомарность), а не последовательными записями с filter_map;
// (3) recover при нечитаемом маркере обязан fail-closed, а rollback не должен
//     создавать файл, которого никогда не было (old_present=false).

/// Посев KV напрямую (без маркеров коммита).
fn seed_kv(db: &Path, rows: &[(&str, &str, &str)]) {
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv_store (
            account TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY (account, key));",
    )
    .unwrap();
    for (a, k, v) in rows {
        conn.execute(
            "INSERT INTO kv_store (account, key, value) VALUES (?1, ?2, ?3)",
            rusqlite::params![a, k, v],
        )
        .unwrap();
    }
}

#[test]
fn keys_only_preserves_existing_kv() {
    let ctx = Ctx::new("keys-keep-kv");
    seed_kv(&ctx.db, &[("acc", "contacts", "KEEP")]);
    let kp = synth_keypair('7', '8');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), None);
    import_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert_eq!(
        read_kv(&ctx.db),
        vec![(
            "acc".to_string(),
            "contacts".to_string(),
            "KEEP".to_string()
        )],
        "keys-only импорт затёр существующий KV"
    );
    assert!(!active_journal_exists(&ctx.keys));
}

#[test]
fn kv_explicit_empty_clears() {
    let ctx = Ctx::new("kv-clear");
    seed_kv(&ctx.db, &[("acc", "x", "1")]);
    let kp = synth_keypair('9', '0');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), Some("[]"));
    import_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert!(
        read_kv(&ctx.db).is_empty(),
        "явно пустой kv должен очистить KV"
    );
}

#[test]
fn generic_import_keys_rejects_late_peer_without_write() {
    let ctx = Ctx::new("generic-late-peer");
    // Валидный keypair + битый ПОЗДНИЙ peer (public_key не 64-hex): старый
    // последовательный путь молча пропускал его через filter_map.
    let kp = synth_keypair('c', 'd');
    let good = synth_peer("good@x", 'e');
    let bad = r#"{"email":"bad@x","public_key":"zz","added_at":"2024-01-01T00:00:00Z"}"#;
    let json = format!(r#"{{"version":1,"keypair":{kp},"peer_keys":[{good},{bad}]}}"#);
    let res = crate::key_store::import_keys_at(&ctx.keys, &ctx.db, &json);
    assert!(
        res.is_err(),
        "generic: битый late-peer обязан валить импорт"
    );
    assert!(
        !ctx.keys.join("keypair.json").exists(),
        "generic: keypair записан при отклонённом импорте"
    );
    assert!(!active_journal_exists(&ctx.keys));
}

#[test]
fn generic_import_keys_happy_preserves_kv() {
    let ctx = Ctx::new("generic-happy");
    seed_kv(&ctx.db, &[("acc", "k", "keep")]);
    let kp = synth_keypair('f', '1');
    let peer = synth_peer("p@x", '2');
    let json = format!(r#"{{"version":1,"keypair":{kp},"peer_keys":[{peer}]}}"#);
    let meta = crate::key_store::import_keys_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert_eq!(meta.key_count, 2);
    assert!(ctx.keys.join("keypair.json").exists());
    assert!(ctx.keys.join("peer_keys.json").exists());
    assert_eq!(
        read_kv(&ctx.db),
        vec![("acc".to_string(), "k".to_string(), "keep".to_string())]
    );
    assert!(!active_journal_exists(&ctx.keys));
}

#[test]
fn recover_marker_unreadable_fail_closed() {
    let ctx = Ctx::new("marker-unread");
    let kp = synth_keypair('3', '5');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = backup_json(Some(1), Some(&keys), None);
    // Сбой ДО commit (target1): rollback выполняется, журнал остаётся.
    let mut m: HashMap<String, Result<(), ()>> = HashMap::new();
    m.insert("target1".to_string(), Err(()));
    set_checkpoints(m);
    let res = import_at(&ctx.keys, &ctx.db, &json);
    clear_checkpoints();
    assert!(res.is_err(), "ожидался Err на target1");
    assert!(
        active_journal_exists(&ctx.keys),
        "журнал должен остаться после сбоя до commit"
    );
    assert!(
        !ctx.keys.join("keypair.json").exists(),
        "rollback не должен создавать файл, которого никогда не было"
    );

    // Портим БД: маркер нечитаем (не SQLite-файл).
    let _ = fs::remove_file(format!("{}-wal", ctx.db.display()));
    let _ = fs::remove_file(format!("{}-shm", ctx.db.display()));
    fs::write(&ctx.db, b"garbage, not sqlite").unwrap();
    let res = recover_pending(&ctx.cfg());
    assert!(
        res.is_err(),
        "recover обязан fail-closed при нечитаемом маркере"
    );
    assert!(
        active_journal_exists(&ctx.keys),
        "журнал не должен удаляться при нечитаемом маркере"
    );

    // Чиним БД: валидная, с durable-маркером txid => recover доводит до NEW.
    let rec = ctx.keys.join(super::RECOVERY_DIR);
    let txid = fs::read_dir(&rec)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .find(|n| n.len() == 32)
        .unwrap();
    fs::remove_file(&ctx.db).unwrap();
    {
        let conn = rusqlite::Connection::open(&ctx.db).unwrap();
        conn.execute_batch(
            "CREATE TABLE backup_import_commits (txid TEXT PRIMARY KEY, committed_at TEXT NOT NULL);",
        ).unwrap();
        conn.execute(
            "INSERT INTO backup_import_commits (txid, committed_at) VALUES (?1, '2024-01-01T00:00:00Z')",
            rusqlite::params![txid],
        ).unwrap();
    }
    recover_pending(&ctx.cfg()).expect("recover с валидным маркером должен завершиться");
    assert!(
        ctx.keys.join("keypair.json").exists(),
        "при маркере recover доводит до NEW"
    );
    assert!(
        !active_journal_exists(&ctx.keys),
        "журнал должен быть убран"
    );
}
