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

// ═══════════ t_61bd5090 #3: разбор по правилам, писатель, манифест ═══════════
// До этой волны мерился только движок (журнал/атомарность) и горстка
// отказов разбора. Три дыры платят данными:
//  (1) правила разбора были сгруппированы — один тест «битый peer» валил
//      три правила сразу, поэтому снятие ЛЮБОГО из них оставалось зелёным;
//  (2) писатель (`export_backup`) не тестировался вовсе: переименование
//      поля в экспорте дало бы backup, который не читается импортёром;
//  (3) структурная валидация манифеста (allowlist цели, txid, дубли,
//      пустой db_path) не проверялась — «повреждённый манифест» был только
//      как обрезанный JSON.
// Каждое правило теперь отклоняется СВОЕЙ ошибкой (assert_rejected_as):
// «невалидный peer» и «дубль peer» — разные правила, и подмена сообщения
// означает, что сработало не то из них.

/// Fail-closed без записи + ровно это фиксированное сообщение.
fn assert_rejected_as(tag: &str, json: &str, expected: &str) {
    assert_malformed_no_write(tag, json);
    let err = super::parse_backup(json).unwrap_err().to_string();
    assert_eq!(err, expected, "{tag}: отклонено другим правилом");
}

/// Keypair с произвольными строками ключей (для проверок формы, не секретов).
fn keypair_json(pubk: &str, prvk: &str, created_at: &str) -> String {
    format!(
        r#"{{"public_key":"{pubk}","private_key":"{prvk}","created_at":"{created_at}"}}"#
    )
}

/// Peer с произвольными полями.
fn peer_json(email: &str, pubk: &str, added_at: &str) -> String {
    format!(r#"{{"email":"{email}","public_key":"{pubk}","added_at":"{added_at}"}}"#)
}

fn keys_of(keypair: &str, peer_keys: &str) -> String {
    format!(r#"{{"keypair":{keypair},"peer_keys":{peer_keys}}}"#)
}

// ─────────────────────────── разбор: версия/состав ─────────────────────

#[test]
fn version_as_string_rejected() {
    // `"version":"1"` — НЕ то же, что 1: строка не подтверждает формат, и
    // принять её значило бы восстанавливать backup неизвестной версии.
    let kp = synth_keypair('a', 'b');
    let json = format!(r#"{{"version":"1","keys":{{"keypair":{kp}}}}}"#);
    assert_rejected_as("version-string", &json, super::ERR_UNSUPPORTED_VERSION);
}

#[test]
fn backup_with_nothing_to_restore_rejected() {
    // Полностью валидный, но ПУСТОЙ backup: пропустить его означало бы
    // «успешное восстановление», которое ничего не восстановило.
    assert_rejected_as(
        "nothing-to-restore",
        r#"{"version":1,"type":"vault-backup","kv_store":null}"#,
        super::ERR_NOTHING_TO_RESTORE,
    );
}

#[test]
fn empty_keys_object_rejected() {
    // `keys:{}` — секция есть, содержимого нет (старый тихий `{}` в писателе
    // давал ровно этот вид).
    assert_rejected_as(
        "keys-empty-object",
        r#"{"version":1,"keys":{}}"#,
        super::ERR_MALFORMED_KEYPAIR,
    );
}

#[test]
fn peers_only_backup_accepted() {
    // Backup без собственной пары ключей, но с контактами — законная форма
    // (восстанавливают список собеседников). Проверка «есть что
    // восстанавливать» обязана считать peers, а не только keypair.
    let ctx = Ctx::new("peers-only");
    let peer = synth_peer("p@x.io", 'c');
    let keys = format!(r#"{{"peer_keys":[{peer}]}}"#);
    let out = import_at(
        &ctx.keys,
        &ctx.db,
        &backup_json(Some(1), Some(&keys), None),
    )
    .unwrap();
    assert!(!out.keypair, "peers-only импорт создал keypair");
    assert_eq!(out.peers, Some(1), "peers-only backup отклонён как пустой");
    assert!(ctx.keys.join("peer_keys.json").exists());
}

// ─────────────────────────── разбор: форма ключей ───────────────────────

#[test]
fn keypair_pub_equals_priv_rejected() {
    // Один и тот же hex в обеих полях — не пара (ECDH дал бы себя самого).
    let same: String = std::iter::repeat('a').take(64).collect();
    let keys = format!(
        r#"{{"keypair":{}}}"#,
        keypair_json(&same, &same, "2024-01-01T00:00:00Z")
    );
    assert_rejected_as(
        "pub-equals-priv",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_MALFORMED_KEYPAIR,
    );
}

#[test]
fn keypair_blank_created_at_rejected() {
    let kp = keypair_json(
        &"a".repeat(64),
        &"b".repeat(64),
        "   ",
    );
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    assert_rejected_as(
        "blank-created-at",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_MALFORMED_KEYPAIR,
    );
}

#[test]
fn keypair_hex_length_rejected() {
    // 63 символа — не 32 байта. Ключ меньшей длины распадается в неверную
    // точку, и запись его на диск = молча сломанная идентичность.
    let short = "a".repeat(63);
    let keys = format!(
        r#"{{"keypair":{}}}"#,
        keypair_json(&short, &"b".repeat(64), "2024-01-01T00:00:00Z")
    );
    assert_rejected_as(
        "hex-length",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_MALFORMED_KEYPAIR,
    );
}

#[test]
fn keypair_hex_alphabet_rejected() {
    // Плохой символ в ПРИВАТНОМ ключе: проверка публичного тут не при чём
    // (мутант «оставить только проверку публичного» ловится именно здесь).
    let mut not_hex = "a".repeat(64);
    not_hex.replace_range(20..21, "g");
    let keys = format!(
        r#"{{"keypair":{}}}"#,
        keypair_json(&"b".repeat(64), &not_hex, "2024-01-01T00:00:00Z")
    );
    assert_rejected_as(
        "hex-alphabet",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_MALFORMED_KEYPAIR,
    );
}

#[test]
fn keypair_uppercase_hex_accepted() {
    // REG-независимый hex: `is_ascii_hexdigit`, а не «нижний регистр».
    // Мутант, сужающий алфавит, ловится здесь.
    let ctx = Ctx::new("upper-hex");
    let kp = keypair_json(&"AB".repeat(32), &"cd".repeat(32), "2024-01-01T00:00:00Z");
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let out = import_at(&ctx.keys, &ctx.db, &backup_json(Some(1), Some(&keys), None)).unwrap();
    assert!(out.keypair, "uppercase-hex keypair не импортирован");
}

// ─────────────────────────── разбор: peers ──────────────────────────────

#[test]
fn peer_blank_email_rejected() {
    // Только это поле пустое — раньше «битый peer» валил три правила сразу.
    let kp = synth_keypair('a', 'b');
    let peer = peer_json("  ", &"c".repeat(64), "2024-01-01T00:00:00Z");
    let keys = keys_of(&kp, &format!("[{peer}]"));
    assert_rejected_as(
        "peer-blank-email",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_MALFORMED_PEER,
    );
}

#[test]
fn peer_blank_added_at_rejected() {
    let kp = synth_keypair('a', 'b');
    let peer = peer_json("p@x.io", &"c".repeat(64), " ");
    let keys = keys_of(&kp, &format!("[{peer}]"));
    assert_rejected_as(
        "peer-blank-added-at",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_MALFORMED_PEER,
    );
}

#[test]
fn peer_not_an_array_rejected() {
    let kp = synth_keypair('a', 'b');
    let keys = format!(r#"{{"keypair":{kp},"peer_keys":{{"email":"p@x.io"}}}}"#);
    assert_rejected_as(
        "peer-not-array",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_MALFORMED_PEER,
    );
}

#[test]
fn peer_duplicate_email_rejected() {
    // Дубль адреса в одном backup — не «первый победил»: какой именно
    // ключ у контакта, решает пользователь, а не порядок массива.
    let kp = synth_keypair('a', 'b');
    let p1 = peer_json("dup@x.io", &"c".repeat(64), "2024-01-01T00:00:00Z");
    let p2 = peer_json("dup@x.io", &"d".repeat(64), "2024-01-02T00:00:00Z");
    let keys = keys_of(&kp, &format!("[{p1},{p2}]"));
    assert_rejected_as(
        "peer-dup",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_DUPLICATE_PEER,
    );
}

#[test]
fn peer_duplicate_email_different_cyrillic_case_rejected() {
    // Форма адреса одна на проект (`identity::normalize`): `to_ascii_lowercase`
    // кириллицу не понижает, и два написания одного адреса разошлись бы как
    // чужие — дубль не пойман, у контакта «появляется» второй ключ.
    let kp = synth_keypair('a', 'b');
    let p1 = peer_json("Иван@Почта.RU", &"c".repeat(64), "2024-01-01T00:00:00Z");
    let p2 = peer_json("иван@почта.ru", &"d".repeat(64), "2024-01-02T00:00:00Z");
    let keys = keys_of(&kp, &format!("[{p1},{p2}]"));
    assert_rejected_as(
        "peer-dup-cyrillic",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_DUPLICATE_PEER,
    );
}

#[test]
fn peer_framed_email_duplicate_rejected() {
    // Обрамление пробелами — тот же адрес (trim внутри normalize).
    let kp = synth_keypair('a', 'b');
    let p1 = peer_json("a@x.io", &"c".repeat(64), "2024-01-01T00:00:00Z");
    let p2 = peer_json("  a@x.io  ", &"d".repeat(64), "2024-01-02T00:00:00Z");
    let keys = keys_of(&kp, &format!("[{p1},{p2}]"));
    assert_rejected_as(
        "peer-dup-framed",
        &backup_json(Some(1), Some(&keys), None),
        super::ERR_DUPLICATE_PEER,
    );
}

// ─────────────────────────── разбор: KV ─────────────────────────────────

#[test]
fn kv_not_an_array_rejected() {
    let kp = synth_keypair('a', 'b');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    let json = format!(
        r#"{{"version":1,"keys":{keys},"kv_store":{{"acc":"obj"}}}}"#
    );
    assert_rejected_as("kv-not-array", &json, super::ERR_MALFORMED_KV);
}

#[test]
fn kv_tuple_of_four_rejected() {
    // Ровно 3 строки (account,key,value): четвёртая — неизвестный смысл,
    // её молча выбросить = потерять часть записанного состояния.
    let kv = r#"[["acc","k","v","extra"]]"#;
    let json = format!(r#"{{"version":1,"kv_store":{kv}}}"#);
    assert_rejected_as("kv-four-fields", &json, super::ERR_MALFORMED_KV);
}

#[test]
fn kv_tuple_with_non_string_rejected() {
    let kv = r#"[["acc","k",3]]"#;
    let json = format!(r#"{{"version":1,"kv_store":{kv}}}"#);
    assert_rejected_as("kv-non-string", &json, super::ERR_MALFORMED_KV);
}

#[test]
fn kv_duplicate_account_key_rejected() {
    let kv = r#"[["acc","k","one"],["acc","k","two"]]"#;
    let json = format!(r#"{{"version":1,"kv_store":{kv}}}"#);
    assert_rejected_as("kv-dup", &json, super::ERR_DUPLICATE_KV);
}

#[test]
fn kv_same_key_different_account_accepted() {
    // Дубли ключей в РАЗНЫХ аккаунт-namespace'ах — разные записи (ключ
    // пары (account,key)): сводить дедуп к одному `key` значило бы
    // отклонить корректный backup multi-аккаунт-состояния.
    let ctx = Ctx::new("kv-same-key");
    let kv = r#"[["acc","k","one"],["fp:abcd","k","two"]]"#;
    let out = import_at(
        &ctx.keys,
        &ctx.db,
        &format!(r#"{{"version":1,"kv_store":{kv}}}"#),
    )
    .unwrap();
    assert_eq!(out.kv, Some(2), "разные аккаунты с одним ключом отклонены");
    assert_eq!(read_kv(&ctx.db).len(), 2);
}

#[test]
fn kv_alias_field_is_accepted() {
    // Читатель принимает `kv_store` (его пишет export) и `kv` (исторический
    // псевдоним). Отбросить псевдоним = не восстановить старые backup'ы.
    let ctx = Ctx::new("kv-alias");
    let json = r#"{"version":1,"kv":[["acc","k","v"]]}"#;
    let out = import_at(&ctx.keys, &ctx.db, json).unwrap();
    assert_eq!(out.kv, Some(1), "псевдоним kv не принят");
    assert_eq!(
        read_kv(&ctx.db),
        vec![("acc".to_string(), "k".to_string(), "v".to_string())]
    );
}

// ─────────────────────────── писатель (экспорт) ─────────────────────────

/// Настоящий писатель ключей (`vault_core::key_store`) + сборка backup'а,
/// затем разбор и импорт в ЧИСТОЕ место: то, что пользователь скачал,
/// восстанавливается байт-в-байт. Это и есть смысл команды `export_backup`
/// (она сама — тонкий делегат), до этого не измеренного НИЧЕМ.
#[test]
fn writer_roundtrip_restores_what_it_exported() {
    use crate::key_store::{StoredKeyPair, StoredPeerKey};
    let src = Ctx::new("writer-src");
    let dst = Ctx::new("writer-dst");

    let kp = StoredKeyPair {
        public_key: "a".repeat(64),
        private_key: "b".repeat(64),
        created_at: "2024-01-01T00:00:00Z".to_string(),
        pq_private_key: None,
        pq_public_key: None,
    };
    vault_core::key_store::save_keypair_at(&src.keys, &kp).unwrap();
    let peers = vec![
        StoredPeerKey {
            email: "x@io".to_string(),
            public_key: "c".repeat(64),
            label: Some("Икс".to_string()),
            added_at: "2024-01-01T00:00:00Z".to_string(),
            pq_public_key: None,
        },
        StoredPeerKey {
            email: "y@io".to_string(),
            public_key: "d".repeat(64),
            label: None,
            added_at: "2024-01-02T00:00:00Z".to_string(),
            pq_public_key: None,
        },
    ];
    vault_core::key_store::save_peer_keys_at(&src.keys, &peers).unwrap();
    seed_kv(
        &src.db,
        &[
            ("acc", "profile", "{\"name\":\"Жук\"}"),
            ("acc", "tombstones", "[\"1\",\"2\"]"),
            ("fp:abcd", "groups", "[]"),
        ],
    );

    let keys = vault_core::key_store::export_keys_at(&src.keys).unwrap();
    let kv = read_kv(&src.db);
    assert_eq!(kv.len(), 3, "посев KV не сошёлся");
    let json = super::assemble_backup(&keys, &kv).unwrap();

    // Имена полей — часть формата, а не детали реализации: писатель обязан
    // класть KV в `kv_store` (читатель терпит псевдоним `kv`, старые сборки
    // и эскроу-письма — нет) и версию 1.
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["version"], serde_json::json!(1), "писатель сменил версию");
    assert_eq!(v["type"], "vault-backup", "писатель сменил тип");
    assert!(
        v.get("kv_store").is_some(),
        "писатель перенёс KV из `kv_store`: backup не читается вне этого дерева"
    );
    assert!(v["keys"].is_object(), "писатель потерял секцию keys");

    let out = import_at(&dst.keys, &dst.db, &json).unwrap();
    assert!(out.keypair, "экспортированный keypair не восстановлен");
    assert_eq!(out.peers, Some(2), "peer-ключи потеряны при экспорте");
    assert_eq!(out.kv, Some(3), "KV потеряна при экспорте");

    // Тот же keypair на новом месте (PQ-миграция при чтении добавляет поля —
    // сравниваем то, что определяет личность).
    let got = vault_core::key_store::load_keypair_at(&dst.keys, false)
        .unwrap()
        .expect("keypair.json после восстановления нет");
    assert_eq!(got.public_key, kp.public_key, "публичный ключ изменился");
    assert_eq!(got.private_key, kp.private_key, "приватный ключ изменился");
    let got_peers = vault_core::key_store::load_peer_keys_at(&dst.keys).unwrap();
    assert_eq!(got_peers.len(), 2);
    assert_eq!(got_peers[0].email, "x@io");
    assert_eq!(got_peers[0].label.as_deref(), Some("Икс"), "label потерян");
    assert_eq!(got_peers[1].public_key, "d".repeat(64));
    assert_eq!(read_kv(&dst.db), kv, "KV после восстановления иная");

    // Инвариант имени файла: ядро пишет `keypair.json`/`peer_keys.json`,
    // allowlist журнала разрешает ровно эти имена. Расхождение молча делает
    // любой backup невосстановимым (цель не проходит валидацию манифеста).
    assert!(super::ops::is_allowed_target(vault_core::key_store::KEY_FILE));
    assert!(super::ops::is_allowed_target(
        vault_core::key_store::PEER_KEYS_FILE
    ));
}

#[test]
fn writer_rejects_unparseable_keys() {
    // Раньше `unwrap_or({})` тихо выпускал backup БЕЗ ключей. Теперь Err:
    // отсутствие ключей видно только когда старое устройство уже стёрто.
    let err = super::assemble_backup("{ не json", &[]).unwrap_err().to_string();
    assert!(
        err.contains("ключи для экспорта не разобраны"),
        "не та ошибка: {err}"
    );
}

#[test]
fn writer_empty_kv_is_an_explicit_clear() {
    // Пустой KV в backup — НЕ «не трогать»: экспорт отражает состояние цели,
    // и восстановление пустого состояния обязано очистить KV.
    let ctx = Ctx::new("writer-empty-kv");
    seed_kv(&ctx.db, &[("acc", "stale", "1")]);
    let keys = vault_core::key_store::export_keys_at(&seed_keys(&ctx)).unwrap();
    let json = super::assemble_backup(&keys, &[]).unwrap();
    let out = import_at(&ctx.keys, &ctx.db, &json).unwrap();
    assert_eq!(out.kv, Some(0), "пустой KV в backup прочитан как «не трогать»");
    assert!(read_kv(&ctx.db).is_empty(), "пустой KV не очистил KV");
}

/// Пишет валидные ключи в keys-каталог контекста (для тестов писателя).
fn seed_keys(ctx: &Ctx) -> PathBuf {
    use crate::key_store::StoredKeyPair;
    let kp = StoredKeyPair {
        public_key: "e".repeat(64),
        private_key: "f".repeat(64),
        created_at: "2024-01-01T00:00:00Z".to_string(),
        pq_private_key: None,
        pq_public_key: None,
    };
    vault_core::key_store::save_keypair_at(&ctx.keys, &kp).unwrap();
    ctx.keys.clone()
}

// ─────────────────── манифест: структурная валидация ─────────────────────

/// Обрыв ПОСЛЕ commit оставляет активный журнал; возвращаем (контекст, txid,
/// путь манифеста), чтобы тест подменил одно поле манифеста.
fn crash_after_commit(tag: &str, json: &str) -> (Ctx, String, PathBuf) {
    let ctx = Ctx::new(tag);
    let mut m: HashMap<String, Result<(), ()>> = HashMap::new();
    m.insert("after:commit".to_string(), Err(()));
    set_checkpoints(m);
    let _ = import_at(&ctx.keys, &ctx.db, json);
    clear_checkpoints();
    assert!(
        active_journal_exists(&ctx.keys),
        "{tag}: журнал не остался"
    );
    let rec = ctx.keys.join(super::RECOVERY_DIR);
    let txid = fs::read_dir(&rec)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .find(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()))
        .expect("нет txid-каталога");
    let mpath = rec.join(&txid).join(super::MANIFEST_FILE);
    (ctx, txid, mpath)
}

fn leave_active_journal(tag: &str) -> (Ctx, String, PathBuf) {
    let kp = synth_keypair('a', 'b');
    let keys = format!(r#"{{"keypair":{kp}}}"#);
    crash_after_commit(tag, &backup_json(Some(1), Some(&keys), None))
}

/// Манифест, изменённый по одному полю, обязан быть ОТКЛОНЁН recover
/// (fail-closed) — журнал при этом цел, потому что угадывать состояние
/// нельзя.
fn assert_manifest_rejected(tag: &str, tamper: impl FnOnce(&mut serde_json::Value, &str)) {
    let (ctx, txid, mpath) = leave_active_journal(tag);
    let raw = fs::read_to_string(&mpath).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    tamper(&mut v, &txid);
    fs::write(&mpath, serde_json::to_string(&v).unwrap()).unwrap();
    let res = recover_pending(&ctx.cfg());
    assert!(res.is_err(), "{tag}: манифест принят несмотря на аномалию");
    assert!(
        active_journal_exists(&ctx.keys),
        "{tag}: журнал удалён при отказе манифеста"
    );
}

#[test]
fn manifest_version_other_than_one_rejected() {
    assert_manifest_rejected("mf-version", |v, _| v["version"] = serde_json::json!(2));
}

#[test]
fn manifest_txid_not_matching_directory_rejected() {
    // Чужой (но валидный по форме) txid = манифест из другой транзакции:
    // по нему recover доводил бы НЕ то состояние.
    assert_manifest_rejected("mf-txid", |v, _| {
        v["txid"] = serde_json::json!("f".repeat(32))
    });
}

#[test]
fn manifest_without_targets_rejected() {
    assert_manifest_rejected("mf-no-targets", |v, _| {
        v["targets"] = serde_json::json!([])
    });
}

#[test]
fn manifest_foreign_target_rejected() {
    // Allowlist цели: имя вне `keypair.json`/`peer_keys.json` — это путь
    // (в т.ч. `../`), который promote продвинул бы в чужой файл.
    for (i, foreign) in [
        "../keypair.json",
        "keypair.json ",
        "peer_keys.jsonl",
        "",
    ]
    .into_iter()
    .enumerate()
    {
        let name = foreign.to_string();
        assert_manifest_rejected(&format!("mf-foreign-{i}"), move |v, _| {
            v["targets"][0]["name"] = serde_json::json!(name)
        });
    }
}

#[test]
fn manifest_duplicate_target_rejected() {
    // Дубль цели — вторая запись продвигает другой байт в тот же файл.
    assert_manifest_rejected("mf-dup-target", |v, _| {
        let first = v["targets"][0].clone();
        v["targets"] = serde_json::json!([first, first]);
    });
}

#[test]
fn manifest_blank_db_path_rejected() {
    // Пустой db_path = «неизвестно, где маркер коммита» — решение old/new
    // по такому пути было бы гаданием.
    assert_manifest_rejected("mf-blank-db", |v, _| {
        v["db_path"] = serde_json::json!("   ")
    });
}

#[test]
fn manifest_symlink_rejected() {
    // Манифест читаем ТОЛЬКО как обычный файл: подставленный симлинк — это
    // чтение чужого пути (в т.ч. того, что атакой подложили в каталог
    // восстановления) с решением о состоянии ключей по его содержимому.
    let (ctx, _txid, mpath) = leave_active_journal("mf-symlink");
    let outside = scratch("mf-symlink-outside");
    let real = fs::read_to_string(&mpath).unwrap();
    fs::write(outside.join("manifest.json"), &real).unwrap();
    let _ = fs::remove_file(&mpath);
    std::os::unix::fs::symlink(outside.join("manifest.json"), &mpath).unwrap();

    let res = recover_pending(&ctx.cfg());
    assert!(res.is_err(), "симлинк-манифест принят как обычный файл");
    assert!(
        active_journal_exists(&ctx.keys),
        "журнал удалён при отказе манифеста"
    );
    let _ = fs::remove_dir_all(&outside);
}

#[test]
fn journal_with_two_targets_recovers() {
    // Позитивный контроль к allowlist: импорт ключей + контактов оставляет
    // журнал с ДВУМЯ целями, и recover обязан довести обе (иначе «разрешены
    // только keypair.json» — зелёный тест на невосстановимых контактах).
    let kp = synth_keypair('a', 'b');
    let peer = synth_peer("p@x.io", 'c');
    let keys = keys_of(&kp, &format!("[{peer}]"));
    let (ctx, _txid, mpath) = crash_after_commit(
        "mf-two-targets",
        &backup_json(Some(1), Some(&keys), None),
    );
    let raw = fs::read_to_string(&mpath).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        v["targets"].as_array().unwrap().len(),
        2,
        "ожиданный журнал из двух целей"
    );

    recover_pending(&ctx.cfg()).expect("recover не довёл журнал из двух целей");
    assert!(ctx.keys.join("keypair.json").exists(), "keypair не доведён");
    assert!(
        ctx.keys.join("peer_keys.json").exists(),
        "peer_keys не доведён"
    );
    assert!(
        !active_journal_exists(&ctx.keys),
        "журнал не убран после доведения"
    );
}

#[test]
fn stray_directory_is_not_a_journal() {
    // Валидация имени журнала — одно правило на два места (поиск журнала и
    // проверка манифеста). Каталог, чьё имя не 32 hex, — НЕ журнал: recover
    // обязан отработать Ok и не трогать его. Мутанты «снять проверку длины»
    // и «снять проверку алфавита» ловятся здесь же.
    let ctx = Ctx::new("stray-dir");
    let rec = ctx.keys.join(super::RECOVERY_DIR);
    let long_not_hex = "z".repeat(32);
    // Короткое ИМЕННО hex имя: проверка длины меряется только им.
    let short_hex = "abc123";
    for name in ["notes", &long_not_hex, short_hex] {
        fs::create_dir_all(rec.join(name)).unwrap();
        fs::write(
            rec.join(name).join(super::MANIFEST_FILE),
            br#"{"version":1,"txid":"x","mode":"commit","targets":[{"name":"keypair.json","old_present":false}],"db_path":"/tmp/x.db"}"#,
        )
        .unwrap();
    }
    recover_pending(&ctx.cfg()).expect("посторонний каталог принят за журнал");
    assert!(rec.join("notes").exists(), "посторонний каталог удалён");
    assert!(
        rec.join(&long_not_hex).exists(),
        "каталог с не-hex именем 32 символов удалён"
    );
    assert!(
        rec.join(short_hex).exists(),
        "каталог с коротким hex-именем принят за журнал"
    );
}

#[test]
fn recovery_promote_rejects_symlink_target() {
    // Цель могла стать симлинком ПОСЛЕ захвата журнала (пользователь/чужой
    // процесс положил ссылку в каталог ключей). Promote обязан отказаться:
    // rename по такому пути уничтожает ссылку и оставляет обычный файл там,
    // где владелец ждал чужой объект, — а отказ сохраняет и ссылку, и её цель
    // нетронутыми.
    let (ctx, _txid, _mpath) = leave_active_journal("promote-symlink");
    let outside = scratch("promote-symlink-outside");
    fs::write(outside.join("victim"), b"OUTSIDE").unwrap();
    let target = ctx.keys.join("keypair.json");
    let _ = fs::remove_file(&target);
    std::os::unix::fs::symlink(outside.join("victim"), &target).unwrap();

    let res = recover_pending(&ctx.cfg());
    assert!(res.is_err(), "promote прошёл по симлинк-цели");
    assert!(
        target.symlink_metadata().unwrap().file_type().is_symlink(),
        "симлинк-цель заменена regular-файлом"
    );
    assert_eq!(
        read_bytes(&outside.join("victim")),
        Some(b"OUTSIDE".to_vec()),
        "внешний файл изменён восстановлением"
    );
    assert!(
        active_journal_exists(&ctx.keys),
        "журнал удалён при отказе promote"
    );
    let _ = fs::remove_dir_all(&outside);
}
