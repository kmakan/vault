// Headless IMAP-монитор для Android-сервиса (29.08).
//
// ПРОБЛЕМА: при свёрнутом Vault пользователь смахивает приложение из
// recents / жмёт «назад» → activity finish + remove-task → процесс умирает
// (logcat 29.08 12:06: wm_finish_activity → am_proc_died). Система
// перезапускает ТОЛЬКО VaultForegroundService в новом пустом процессе,
// где нет ни WebView, ни Tauri-рантайма, ни IMAP-монитора — уведомления
// о новых сообщениях не приходят до открытия приложения.
//
// РЕШЕНИЕ: Kotlin-сервис через JNI вызывает nativeStartMonitor(dataDir):
// внутри поднимается tokio-задача с EmailClient (IMAP IDLE + fetch_newer),
// письма расшифровываются ключами из $dataDir/.vault/keys (HOME ставим на
// dataDir — каталог тот же, что у activity-процесса), и для Vault-сообщений
// показывается системное уведомление через JNI
// VaultForegroundService.showMessage(context, title, text).
//
// ДЕДУП: пока MainActivity жива (JS доставляет всё сам и быстрее), монитор
// стоит на паузе (nativePauseMonitor из MainActivity.onResume/onPause). Если
// процесс мёртв — монитор единственный, дубликатов нет.
//
// НАДЁЖНОСТЬ (29.08, «терялся курсор на письма»): доставка ТРАНЗАКЦИОННАЯ.
// Раньше seen-дедуп писался ДО показа уведомления — любой краш (JNI/
// расшифровка/фетч тела) терял письмо навсегда (курсор уже продвинут,
// Message-ID в seen). Теперь письмо попадает в pending-очередь (kv
// monitor.db) и живёт там, пока уведомление не покажется УСПЕШНО:
//   • fetch тела / расшифровка неудачны → ретрай на следующем тике
//     (до MAX_TRIES, фетч тела бывает разово-битым — 29.08 uid179);
//   • notify через JNI упал → ретрай (Java-exception погашен
//     exception_clear, процесс жив);
//   • 3 неудачи → письмо в seen (отрицательный dedup-ответ), лог;
//   • MainActivity открылась (paused) → JS доставит сам: pending-запись
//     тихо удаляется БЕЗ seen (дедуп JS независим).
// seen-список notify_seen:<account> (последние SEEN_CAP Message-ID) —
// только ДОСТАВЛЕННЫЕ или окончательно отброшенные письма.
// База ОТДЕЛЬНАЯ (monitor.db) — курсоры/дедуп не конфликтуют с JS в vault.db.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::crypto::decrypt_vault_cmd;
use crate::email::{EmailClient, EmailConfig, EmailMessage, IdleOutcome};
use crate::key_store;

// ───────────── Логи в logcat (headless-процесс не имеет stderr) ─────────────
// eprintln! в сервис-процессе (без Tauri) уходит в /dev/null: stderr там
// никуда не подключён, и e2e-тест 29.08 оказался слепым — в logcat не было
// НИ ОДНОЙ строки монитора, работали его уведомления или нет — неизвестно.
// В service-процессе lib.rs run() не вызывается (нет activity) → фасад log
// никем не занят: init_once(android_logger) здесь — первый и главный, все
// log::info! из монитора идут в logcat (тэг VaultRust). В activity-процессе
// инициализация уже сделана в run() — повторный вызов безопасный no-op.
fn init_logcat() {
    let _ = android_logger::init_once(
        android_logger::Config::default()
            .with_max_level(log::LevelFilter::Debug)
            .with_tag("VaultRust"),
    );
}

const IDLE_TICK: Duration = Duration::from_secs(7);
const FRESH_SECS: i64 = 15 * 60; // не уведомлять о письмах старше 15 минут
const CALL_STALE_MS: i64 = 10 * 60 * 1000; // call_request старше 10 мин — мимо
const SEEN_CAP: usize = 200; // дедуп-список: последние 200 Message-ID
const MAX_TRIES: u32 = 3; // попыток доставки письма до отриц. дедупа

/// Глобальное состояние headless-монитора (один на процесс).
struct MonitorState {
    stop: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    paused: Mutex<bool>,
}

static MONITOR: OnceLock<MonitorState> = OnceLock::new();

fn monitor() -> &'static MonitorState {
    MONITOR.get_or_init(|| MonitorState {
        stop: Arc::new(AtomicBool::new(false)),
        running: Arc::new(AtomicBool::new(false)),
        paused: Mutex::new(false),
    })
}

static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn runtime() -> &'static tokio::runtime::Runtime {
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("svc-monitor: tokio runtime")
    })
}

// ─────────────────────── JNI-входы (вызывает Kotlin) ───────────────────────

/// `external fun nativeStartMonitor(dataDir: String)` — экземплярный метод
/// VaultForegroundService (символ без $Companion). Kotlin передаёт
/// dataDir (activity.dataDir.absolutePath == tauri getDataDir) — тот же
/// каталог, где activity-процесс держит .vault/{credentials,keys}.
/// # Safety — вызывается из JVM с валидным JNIEnv/jobject (JNI-контракт).
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_VaultForegroundService_nativeStartMonitor(
    mut env: jni::JNIEnv,
    service: jni::objects::JObject,
    data_dir: jni::objects::JString,
) {
    init_logcat();
    let st = monitor();
    // Идемпотентность: цикл уже крутится и его не просили останавливаться —
    // выходим. Рестарт после stop (сервис перезапущен системой) — через
    // задачу-стартер: ждём выхода старого цикла и поднимаем новый.
    if st.running.load(Ordering::SeqCst) && !st.stop.load(Ordering::SeqCst) {
        log::warn!("[svc-monitor] start requested, already running");
        return;
    }
    // ndk-context: в service-процессе MainActivity.onCreate не звал
    // nativeInitAndroidContext — инициализируем сами (идемпотентно).
    ensure_ndk_context(&mut env, &service);

    let dir: String = match env.get_string(&data_dir) {
        Ok(s) => s.into(),
        Err(e) => {
            log::error!("[svc-monitor] dataDir read failed: {e}");
            return;
        }
    };
    // HOME обязателен: в service-процессе env пуст, dirs::home_dir() → None.
    // Тот же каталог, что lib.rs setup ставит в activity-процессе.
    std::env::set_var("HOME", &dir);
    log::info!("[svc-monitor] HOME={dir}");

    // Старый цикл (если жив) получает stop и завершается; задача-стартер
    // дожидается его и запускает новый. compare_exchange исключает двойной
    // старт при двух подряд JNI-вызовах.
    st.stop.store(true, Ordering::SeqCst);
    let stop_flag = st.stop.clone();
    let running_flag = st.running.clone();

    runtime().spawn(async move {
        for _ in 0..60 {
            if !running_flag.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if running_flag
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            log::warn!("[svc-monitor] another starter won the race");
            return;
        }
        stop_flag.store(false, Ordering::SeqCst);
        run_loop(stop_flag).await;
        running_flag.store(false, Ordering::SeqCst);
        log::info!("[svc-monitor] loop exited");
    });
}

/// `external fun nativeStopMonitor()` — сервис уходит (onDestroy).
/// # Safety — вызывается из JVM с валидным JNIEnv (JNI-контракт).
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_VaultForegroundService_nativeStopMonitor(
    _env: jni::JNIEnv,
    _service: jni::objects::JObject,
) {
    init_logcat();
    monitor().stop.store(true, Ordering::SeqCst);
}

/// `external fun nativePauseMonitor(paused: Boolean)` — вызывается из
/// MainActivity.onResume(true) / onPause(false): пока activity жива, JS
/// доставляет всё сам — монитор молчит и не шлёт уведомлений.
/// # Safety — вызывается из JVM с валидным JNIEnv (JNI-контракт).
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_MainActivity_nativePauseMonitor(
    _env: jni::JNIEnv,
    _activity: jni::objects::JObject,
    paused: jni::sys::jboolean,
) {
    init_logcat();
    if let Ok(mut p) = monitor().paused.lock() {
        *p = paused != 0;
        log::info!("[svc-monitor] paused={}", *p);
    }
}

/// `external fun nativeSendCallSignal(callerEmail: String, callId: String, signal: String)`
/// — нативная кнопка «Отклонить» в уведомлении звонка (CallActionReceiver):
/// WebView может быть мёртв, а собеседник должен узнать об отказе немедленно
/// (29.08: «после отклонения на телефоне десктоп не отключается»). Шифруем
/// call_reject-конверт (peer-ключ из key_store, HOME уже установлен монитором)
/// и отправляем SMTP пустой темой — stealth, тот же путь, что JS sendCallEnvelope.
/// # Safety — вызывается из JVM с валидным JNIEnv (JNI-контракт).
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_VaultForegroundService_nativeSendCallSignal(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    caller_email: jni::objects::JString,
    call_id: jni::objects::JString,
    signal: jni::objects::JString,
) {
    init_logcat();
    let email: String = match env.get_string(&caller_email) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    let cid: String = match env.get_string(&call_id) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    let sig: String = match env.get_string(&signal) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    // Шифрование + SMTP в tokio-рантайме (blocking-потоки JVM не заняты).
    let handle = runtime().spawn(async move {
        let peer_key = match crate::key_store::load_peer_keys() {
            Ok(list) => list
                .into_iter()
                .find(|p| p.email.eq_ignore_ascii_case(&email))
                .map(|p| p.public_key),
            Err(_) => None,
        };
        let Some(peer_key) = peer_key else {
            log::warn!("[svc-monitor] call signal {sig}: no peer key for {email}");
            return;
        };
        let priv_key = match crate::key_store::load_keypair() {
            Ok(Some(k)) => k.private_key,
            _ => {
                log::warn!("[svc-monitor] call signal {sig}: no keypair");
                return;
            }
        };
        let envelope = serde_json::json!({
            "vault": 1,
            "id": format!("{}{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis().to_string())
                .unwrap_or_default(),
                "na"),
            "type": sig,
            "call_id": cid,
            "ts": now_ms(),
        });
        let plain = envelope.to_string();
        let cipher = match crate::crypto::encrypt_vault_cmd(&plain, &priv_key, Some(&peer_key)) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[svc-monitor] call signal {sig}: encrypt failed: {e}");
                return;
            }
        };
        let creds = match crate::credential_store::load_credentials() {
            Ok(Some(c)) => c,
            _ => return,
        };
        let mut client = EmailClient::new(EmailConfig {
            email: creds.email.clone(),
            password: creds.password.clone(),
            imap_server: creds.imap_server.clone(),
            imap_port: creds.imap_port,
            smtp_server: creds.smtp_server.clone(),
            smtp_port: creds.smtp_port,
        });
        // send_email использует SMTP-транспорт, IMAP-сессию не открываем.
        match client.send_email(&email, "", &cipher).await {
            Ok(()) => log::info!("[svc-monitor] call signal {sig} sent to {email}"),
            Err(e) => log::warn!("[svc-monitor] call signal {sig} send failed: {e}"),
        }
    });
    let _ = handle; // fire-and-forget: задача завершится сама
}

/// Инициализация ndk-context из любого JNI-входа (идемпотентно;
/// initialize_android_context assert-ится на повторный вызов — гасим).
/// Вызывается из nativeStartMonitor (этот модуль) и из
/// MainActivity.nativeInitAndroidContext через lib.rs-обёртку: оба входа
/// делят один флаг — иначе открытие приложения после старта монитора
/// паниковало бы на повторной инициализации (panic=abort → смерть процесса).
pub(crate) fn ensure_ndk_context(env: &mut jni::JNIEnv, context: &jni::objects::JObject) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.load(Ordering::SeqCst) {
        return;
    }
    let result =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
            let vm = env.get_java_vm().map_err(|e| format!("vm: {e}"))?;
            let vm_ptr = vm.get_java_vm_pointer() as *mut std::ffi::c_void;
            let global = env
                .new_global_ref(context)
                .map_err(|e| format!("gref: {e}"))?;
            let ctx_ptr = {
                use std::ops::Deref;
                (global.deref() as &jni::objects::JObject).as_raw() as *mut std::ffi::c_void
            };
            std::mem::forget(global); // живёт до конца процесса
                                      // SAFETY: валидные JavaVM/Context указатели из JNI-входа; вызов
                                      // идемпотентен глобально (DONE проверен выше, повтор — assert-паника,
                                      // которую мы ловим снаружи catch_unwind).
            unsafe { ndk_context::initialize_android_context(vm_ptr, ctx_ptr) };
            Ok(())
        }));
    match result {
        Ok(Ok(())) => {
            DONE.store(true, Ordering::SeqCst);
            log::info!("[svc-monitor] ndk-context initialized from service");
        }
        Ok(Err(e)) => log::error!("[svc-monitor] ndk-context init failed: {e}"),
        Err(_) => log::warn!("[svc-monitor] ndk-context already initialized (panic swallowed)"),
    }
}

/// ───────────── Решение пользователя по звонку (фаза 2, 30.08) ─────────────
/// Kotlin (CallActionReceiver) передаёт решение ВЛАДЕЛЬЦУ состояния —
/// монитору. Никакой собственной логики у Kotlin: только транспорт.
/// decision: "accept" | "reject". Монитор:
///   rejected → state=rejected + dismiss + call_reject письмом звонящему;
///   accepted → state=accepted + dismiss + подъём activity (JS сгенерирует
///              answer; state machine знает про accepted и не гаснет по таймауту).
/// # Safety — вызывается из JVM с валидным JNIEnv (JNI-контракт).
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_CallActionReceiver_nativeCallDecision(
    mut env: jni::JNIEnv,
    _receiver: jni::objects::JObject,
    call_id: jni::objects::JString,
    decision: jni::objects::JString,
) {
    init_logcat();
    let cid: String = match env.get_string(&call_id) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    let dec: String = match env.get_string(&decision) {
        Ok(s) => s.into(),
        Err(_) => return,
    };
    log::info!("[svc-monitor] nativeCallDecision {dec} for call {cid}");

    // 1) Смотрим запись звонка (email/caller нужны для письма).
    let creds = crate::credential_store::load_credentials().ok().flatten();
    let Some(creds) = creds else { return };
    let account = creds.email.to_lowercase();
    let db_path = match dirs::data_local_dir() {
        Some(d) => d.join("com.vault.vault").join("monitor.db"),
        None => {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            std::path::PathBuf::from(home).join("monitor.db")
        }
    };
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let db = match crate::storage::sqlite::Storage::open(Some(&db_path)) {
        Ok(s) => Arc::new(Mutex::new(s)),
        Err(e) => {
            log::error!("[svc-monitor] decision: monitor.db open failed: {e}");
            return;
        }
    };
    let Some(entry) = call_get_state(&db, &account, &cid) else {
        log::warn!("[svc-monitor] decision {dec}: unknown call {cid}");
        return;
    };
    // Инвариант: решение принимается ровно один раз (в ringing).
    if entry.state != "ringing" {
        log::info!(
            "[svc-monitor] decision {dec}: call {cid} already {} — ignore",
            entry.state
        );
        return;
    }

    // 2) Гасим нативное уведомление в любом случае.
    crate::audio::audio_android::dismiss_incoming_call_notification();

    match dec.as_str() {
        "reject" => {
            call_set_state(&db, &account, &cid, "rejected", &entry.caller);
            // call_reject звонящему (тот же путь, что nativeSendCallSignal).
            spawn_call_signal_email(entry.email.clone(), cid.clone(), "call_reject");
        }
        "accept" => {
            call_set_state(&db, &account, &cid, "accepted", &entry.caller);
            // Поднимаем activity: живой JS увидит accepted (фаза 3: событие
            // call-state-changed) и сгенерирует answer.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let ctx = ndk_context::android_context();
                let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
                    .map_err(|e| format!("vm: {e}"))?;
                let mut env2 = vm
                    .attach_current_thread()
                    .map_err(|e| format!("attach: {e}"))?;
                let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
                let cls = crate::audio::audio_android::find_app_class(
                    &mut env2,
                    &activity,
                    "com.vault.vault.MainActivity",
                )
                .map_err(|e| format!("find class: {e}"))?;
                let jdec = env2
                    .new_string("accept")
                    .map_err(|e| format!("new_string: {e}"))?;
                env2.call_static_method(
                    &cls,
                    "dispatchCallAction",
                    "(Ljava/lang/String;)V",
                    &[(&jdec).into()],
                )
                .map_err(|e| format!("dispatchCallAction: {e}"))?;
                Ok::<(), String>(())
            }));
            match result {
                Ok(Ok(())) => log::info!("[svc-monitor] accept: activity dispatched"),
                Ok(Err(e)) => log::warn!("[svc-monitor] accept dispatch failed: {e}"),
                Err(_) => log::warn!("[svc-monitor] accept dispatch panicked"),
            }
        }
        _ => log::warn!("[svc-monitor] unknown decision: {dec}"),
    }
}

/// Огне-и-забыть отправка call_* письма звонящему (общий путь для reject).
fn spawn_call_signal_email(email: String, call_id: String, signal: &'static str) {
    let handle = runtime().spawn(async move {
        let peer_key = match crate::key_store::load_peer_keys() {
            Ok(list) => list
                .into_iter()
                .find(|p| p.email.eq_ignore_ascii_case(&email))
                .map(|p| p.public_key),
            Err(_) => None,
        };
        let Some(peer_key) = peer_key else {
            log::warn!("[svc-monitor] {signal}: no peer key for {email}");
            return;
        };
        let priv_key = match crate::key_store::load_keypair() {
            Ok(Some(k)) => k.private_key,
            _ => return,
        };
        let envelope = serde_json::json!({
            "vault": 1,
            "id": format!("{}{}", now_ms(), "na"),
            "type": signal,
            "call_id": call_id,
            "ts": now_ms(),
        });
        let cipher = match crate::crypto::encrypt_vault_cmd(
            &envelope.to_string(),
            &priv_key,
            Some(&peer_key),
        ) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[svc-monitor] {signal}: encrypt failed: {e}");
                return;
            }
        };
        let Some(creds) = crate::credential_store::load_credentials().ok().flatten() else {
            return;
        };
        let mut client = EmailClient::new(EmailConfig {
            email: creds.email.clone(),
            password: creds.password.clone(),
            imap_server: creds.imap_server,
            imap_port: creds.imap_port,
            smtp_server: creds.smtp_server,
            smtp_port: creds.smtp_port,
        });
        match client.send_email(&email, "", &cipher).await {
            Ok(()) => log::info!("[svc-monitor] {signal} sent to {email}"),
            Err(e) => log::warn!("[svc-monitor] {signal} send failed: {e}"),
        }
    });
    let _ = handle;
}

// ─────────────────────────── Основной цикл ───────────────────────────

async fn run_loop(stop: Arc<AtomicBool>) {
    // 1) Креды ($HOME/.vault/credentials/credentials.enc — device-key расшифровка).
    let creds = match crate::credential_store::load_credentials() {
        Ok(Some(c)) => c,
        _ => {
            log::warn!("[svc-monitor] no credentials — exit (нужен один вход в приложение)");
            return;
        }
    };
    // 2) Приватный ключ ($HOME/.vault/keys/keypair.json).
    let keypair = match key_store::load_keypair() {
        Ok(Some(k)) => k,
        _ => {
            log::warn!("[svc-monitor] no keypair — exit");
            return;
        }
    };
    // 3) Контакты ($HOME/.vault/keys/peer_keys.json): email → публичный ключ.
    let mut peers: HashMap<String, String> = HashMap::new();
    if let Ok(list) = key_store::load_peer_keys() {
        for p in list {
            peers.insert(p.email.to_lowercase(), p.public_key);
        }
    }
    let account = creds.email.to_lowercase();
    log::info!("[svc-monitor] peers loaded: {}", peers.len());
    // ДИАГНОСТИКА (29.08, «decrypt failed» на телефоне): выведенный из
    // загруженного привата публичный ключ. Если он != ожидаемому (JS app
    // показывает тот же fingerprint в UI), монитор читает ЧУЖОЙ keypair.json
    // (не тот HOME / не тот каталог) — корень «письмо не расшифровывается
    // монитором, но расшифровывается открытым приложением».
    {
        use x25519_dalek::{PublicKey, StaticSecret};
        if let Ok(pb) = hex::decode(&keypair.private_key) {
            if let Ok(arr) = <[u8; 32]>::try_from(pb) {
                let derived = PublicKey::from(&StaticSecret::from(arr));
                let dhex: String = derived
                    .as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                log::info!(
                    "[svc-monitor] keypair derived pub={}… (priv={}…)",
                    &dhex[..16.min(dhex.len())],
                    &keypair.private_key[..16.min(keypair.private_key.len())]
                );
            }
        }
    }

    // 4) Своя sqlite-база: независимые курсоры + дедуп/pending-очередь.
    let db_path = match dirs::data_local_dir() {
        Some(d) => d.join("com.vault.vault").join("monitor.db"),
        None => {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            std::path::PathBuf::from(home).join("monitor.db")
        }
    };
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let db = match crate::storage::sqlite::Storage::open(Some(&db_path)) {
        Ok(s) => s,
        Err(e) => {
            log::error!("[svc-monitor] sqlite open failed: {e}");
            return;
        }
    };
    // Storage (rusqlite) не Sync — оборачиваем в Arc<Mutex>: таска должна
    // быть Send для tokio::spawn, а обращения короткие (kv/cursors).
    let db = Arc::new(Mutex::new(db));
    let mut cursors: HashMap<String, u32> = match db.lock() {
        Ok(g) => g.load_cursors(&account).unwrap_or_default(),
        Err(_) => HashMap::new(),
    };
    log::info!(
        "[svc-monitor] start acc={account} cursors={} db={}",
        cursors.len(),
        db_path.display()
    );

    let cfg = EmailConfig {
        email: creds.email.clone(),
        password: creds.password.clone(),
        imap_server: creds.imap_server.clone(),
        imap_port: creds.imap_port,
        smtp_server: creds.smtp_server.clone(),
        smtp_port: creds.smtp_port,
    };
    let mut client = EmailClient::new(cfg);
    let ctx = Ctx {
        db: &db,
        account: &account,
        private_key: &keypair.private_key,
        peers: &peers,
    };

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if let Err(e) = client.connect_imap().await {
            log::warn!("[svc-monitor] connect failed: {e}");
            for _ in 0..15 {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            continue;
        }
        // ДОВЕРШИТЬ НЕДОСТАВЛЕННОЕ РАНЬШЕ НОВЫХ ПИСЕМ: pending-очередь
        // пережила рестарт процесса — обрабатываем её первой.
        drain_pending(&ctx, stop.clone()).await;
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // MISSED-ТАЙМАУТ (фаза 1): ringing без решения дольше RING_TIMEOUT_MS
        // → missed + пуш + снять уведомление звонка (по плану 45с; 180с
        // таймаут уведомления Android снимал слишком поздно).
        check_ring_timeouts(&ctx);
        // IDLE-тик 7с (как JS-монитор): серверный push ~1с, тик страхует папки.
        let changed = match client.idle_wait("INBOX", IDLE_TICK).await {
            Ok(o) => o == IdleOutcome::Changed,
            Err(e) => {
                log::warn!("[svc-monitor] idle failed: {e}");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match client.fetch_newer(&cursors).await {
            Ok((msgs, new_cursors)) => {
                cursors = new_cursors;
                if let Ok(json) = serde_json::to_string(&cursors) {
                    if let Ok(g) = db.lock() {
                        let _ = g.save_cursors(&account, &json);
                    }
                }
                if !msgs.is_empty() {
                    log::info!("[svc-monitor] got {} msgs (changed={changed})", msgs.len());
                    for m in &msgs {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        ingest_message(&ctx, m).await;
                    }
                    // Свежедобавленные обрабатываем сразу же этим тиком.
                    drain_pending(&ctx, stop.clone()).await;
                }
            }
            Err(e) => {
                log::warn!("[svc-monitor] fetch_newer failed: {e}");
                let _ = client.disconnect();
            }
        }
    }
    let _ = client.disconnect();
}

// ─────────────────── Транзакционная доставка (pending) ───────────────────

/// Запись pending-очереди: письмо, КОТОРОЕ ЕЩЁ НЕ ДОСТАВЛЕНО.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct PendingEntry {
    mid: String,  // Message-ID (или from|folder|uid для писем без него)
    from: String, // отправитель (lowercase)
    folder: String,
    uid: String,
    tries: u32,
}

struct Ctx<'a> {
    db: &'a Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &'a str,
    private_key: &'a str,
    peers: &'a HashMap<String, String>,
}

enum Outcome {
    /// Уведомление показано (или звонок честно отмечен) — в seen, из pending.
    Delivered,
    /// Ошибка (фетч/расшифровка/JNI) — оставить в pending, tries+1.
    Retry,
    /// Попытки исчерпаны — в seen (больше не тревожить), из pending.
    Dead,
    /// Activity открылась: JS доставляет сам — удалить из pending БЕЗ seen.
    HandledByJs,
}

fn kv_json<T: serde::Serialize + serde::de::DeserializeOwned>(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
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

fn kv_save<T: serde::Serialize>(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &str,
    key: &str,
    val: &T,
) {
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
fn seen_contains(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &str,
    mid: &str,
) -> bool {
    let list: Vec<String> = kv_json(db, account, &seen_key());
    list.iter().any(|x| x == mid)
}

fn seen_push(db: &Arc<Mutex<crate::storage::sqlite::Storage>>, account: &str, mid: &str) {
    let mut list: Vec<String> = kv_json(db, account, &seen_key());
    if list.iter().any(|x| x == mid) {
        return;
    }
    list.push(mid.to_string());
    let cut = list.len().saturating_sub(SEEN_CAP);
    let list = list.split_off(cut);
    kv_save(db, account, &seen_key(), &list);
}

fn pending_list(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &str,
) -> Vec<PendingEntry> {
    kv_json(db, account, &pending_key())
}

fn pending_save(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &str,
    list: &[PendingEntry],
) {
    kv_save(db, account, &pending_key(), &list);
}

/// ─────────── Машина состояний входящего звонка (Фаза 1, 29.08) ───────────
/// Владелец состояния — монитор (call_state в kv monitor.db). call_id —
/// первичный ключ. Инварианты: один call_id = один рингтон за всё время;
/// решение (accepted/rejected) необратимо до ended; ретрансляции call_request
/// того же call_id НЕ перезапускают рингтон и НЕ создают «новых звонков»
/// (корень «телефон звонит заново после отклонения»).
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct CallEntry {
    state: String,   // ringing | accepted | rejected | missed | ended
    caller: String,  // имя звонящего (для уведомления)
    email: String,   // адрес звонящего (для call_accept/reject письма)
    updated_at: i64, // ms, для TTL-чистки
}

const CALL_TOMBSTONE_MS: i64 = 10 * 60 * 1000; // надгробие 10 мин

fn call_state_key() -> String {
    "call_state".to_string()
}

/// Загрузить всю таблицу call_state (kv JSON: call_id → CallEntry).
fn calls_load(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &str,
) -> std::collections::HashMap<String, CallEntry> {
    let raw: std::collections::HashMap<String, CallEntry> = kv_json(db, account, &call_state_key());
    raw
}

/// Сохранить таблицу call_state c TTL-чисткой надгробий.
fn calls_save(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &str,
    calls: &std::collections::HashMap<String, CallEntry>,
) {
    let now = now_ms();
    let live: std::collections::HashMap<String, CallEntry> = calls
        .iter()
        .filter(|(_, c)| c.state == "ringing" || now - c.updated_at < CALL_TOMBSTONE_MS)
        .map(|(k, c)| (k.clone(), c.clone()))
        .collect();
    kv_save(db, account, &call_state_key(), &live);
}

/// Установить состояние звонка (безусловно — владелец здесь).
fn call_set_state(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &str,
    call_id: &str,
    state: &str,
    caller: &str,
) {
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

fn call_get_state(
    db: &Arc<Mutex<crate::storage::sqlite::Storage>>,
    account: &str,
    call_id: &str,
) -> Option<CallEntry> {
    calls_load(db, account).get(call_id).cloned()
}

/// Таймаут звонка без решения (фаза 1): 45с.
const RING_TIMEOUT_MS: i64 = 45 * 1000;

/// ringing дольше RING_TIMEOUT_MS → missed + пуш + dismiss уведомления.
/// Вызывается каждым тиком run_loop (7с) — ретрансляции не сбрасывают
/// updated_at (решение/таймаут по ВРЕМЕНИ ПЕРВОГО рингтона).
fn check_ring_timeouts(ctx: &Ctx<'_>) {
    let calls = calls_load(ctx.db, ctx.account);
    let now = now_ms();
    let mut changed = false;
    for (call_id, c) in calls.iter() {
        if c.state == "ringing" && now - c.updated_at > RING_TIMEOUT_MS {
            // missed: надгробие против поздних ретрансляций.
            call_set_state(ctx.db, ctx.account, call_id, "missed", "");
            log::info!("[svc-monitor] call {call_id}: ring timeout → missed");
            // Снять уведомление звонка (рингтон+вибро) — если висит.
            crate::audio::audio_android::dismiss_incoming_call_notification();
            // Пуш-резюме: юзер должен узнать о пропущенном.
            let _ = notify(&c.caller, "Пропущенный звонок Vault");
            changed = true;
        }
    }
    if changed {
        // TTL-чистка надгробий произойдёт внутри calls_save.
        let calls = calls_load(ctx.db, ctx.account);
        calls_save(ctx.db, ctx.account, &calls);
    }
}

// ─────────────────────── Классификация письма ───────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Свежесть по заголовку Date (RFC 2822). Не распарсился — считаем свежим:
/// окончательно решит ts конверта после расшифровки (CALL_STALE_MS/FRESH_SECS).
fn date_fresh(date_header: &str) -> bool {
    match chrono::DateTime::parse_from_rfc2822(date_header.trim()) {
        Ok(dt) => now_ms() / 1000 - dt.timestamp() < FRESH_SECS,
        Err(_) => true,
    }
}

/// Новое письмо из fetch_newer: пре-фильтры → pending-очередь.
/// Сообщения от ОДНОГО отправителя при включённом ephemeral не сливаются:
/// Message-ID уникален у каждого письма.
async fn ingest_message(ctx: &Ctx<'_>, m: &EmailMessage) {
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
    if seen_contains(ctx.db, ctx.account, &message_id) {
        return;
    }
    let mut list = pending_list(ctx.db, ctx.account);
    if list.iter().any(|e| e.mid == message_id) {
        return; // уже в очереди
    }
    list.push(PendingEntry {
        mid: message_id,
        from: m.from.to_lowercase(),
        folder: m.folder.clone(),
        uid: m.id.clone(),
        tries: 0,
    });
    pending_save(ctx.db, ctx.account, &list);
}

/// Обработать pending-очередь до конца (или до stop).
async fn drain_pending(ctx: &Ctx<'_>, stop: Arc<AtomicBool>) {
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let list = pending_list(ctx.db, ctx.account);
        let Some(mut entry) = list.first().cloned() else {
            return; // очередь пуста
        };
        match deliver_entry(ctx, &mut entry).await {
            Outcome::Delivered => {
                log::info!(
                    "[svc-monitor] delivered: {} (mid={}…)",
                    entry.from,
                    &entry.mid[..entry.mid.len().min(24)]
                );
                seen_push(ctx.db, ctx.account, &entry.mid);
                remove_pending(ctx, &entry.mid);
            }
            Outcome::HandledByJs => {
                log::info!(
                    "[svc-monitor] handled by JS (activity alive): {}",
                    entry.from
                );
                remove_pending(ctx, &entry.mid);
            }
            Outcome::Dead => {
                log::warn!(
                    "[svc-monitor] give up after {} tries: {} mid={}…",
                    entry.tries,
                    entry.from,
                    &entry.mid[..entry.mid.len().min(24)]
                );
                seen_push(ctx.db, ctx.account, &entry.mid);
                remove_pending(ctx, &entry.mid);
            }
            Outcome::Retry => {
                // tries+1, запись назад (первая в очереди — сохраняем порядок).
                let mut list = pending_list(ctx.db, ctx.account);
                if let Some(e) = list.iter_mut().find(|e| e.mid == entry.mid) {
                    e.tries += 1;
                    if e.tries >= MAX_TRIES {
                        log::warn!(
                            "[svc-monitor] give up after {} tries: {} mid={}…",
                            e.tries,
                            e.from,
                            &e.mid[..e.mid.len().min(24)]
                        );
                        seen_push(ctx.db, ctx.account, &e.mid);
                    } else {
                        pending_save(ctx.db, ctx.account, &list);
                        return; // подождём следующего тика
                    }
                }
                // исчерпано: убрать из pending (seen уже записан)
                let mid = entry.mid.clone();
                let kept: Vec<PendingEntry> = list.into_iter().filter(|e| e.mid != mid).collect();
                pending_save(ctx.db, ctx.account, &kept);
                return;
            }
        }
    }
}

fn remove_pending(ctx: &Ctx<'_>, mid: &str) {
    let list = pending_list(ctx.db, ctx.account);
    let kept: Vec<PendingEntry> = list.into_iter().filter(|e| e.mid != mid).collect();
    pending_save(ctx.db, ctx.account, &kept);
}

/// Одна попытка доставки записи: фетч тела → расшифровка → классификация
/// → уведомление. Все ошибки = Retry (транзакционность: side-эффект только
/// после успеха).
async fn deliver_entry(ctx: &Ctx<'_>, e: &mut PendingEntry) -> Outcome {
    // Открыта MainActivity → JS сам доставляет и уведомляет.
    if monitor().paused.lock().map(|p| *p).unwrap_or(false) {
        return Outcome::HandledByJs;
    }
    // Тело письма (отдельная IMAP-сессия — IDLE-сессию не дёргаем).
    let body = match fetch_body(&e.folder, &e.uid).await {
        Ok(b) => b,
        Err(err) => {
            log::warn!(
                "[svc-monitor] body fetch failed (try {}): {err}",
                e.tries + 1
            );
            return Outcome::Retry;
        }
    };
    // ВАЖНО (0.1.88): fetch_message_body УЖЕ декодирует quoted-printable.
    // Повторный декод здесь ПОРТИЛ base64: хвостовой padding "==" и случайные
    // "=XX" во 2-м проходе съедали 2 байта данных (bodylen 8193 при валидном
    // 8088 → len%4=1 → «decrypt failed» → звонок/уведомление молча гибли).
    let body_clean = body;

    // Расшифровка: ключ отправителя → self-ключ (письма себе шифруются своим
    // ключом) → перебор контактов (страховка для нестандартных сценариев).
    let from_lc = e.from.clone();
    let mut plain: Option<String> = None;
    if let Some(pk) = ctx.peers.get(&from_lc) {
        if let Ok(p) = decrypt_vault_cmd(&body_clean, ctx.private_key, Some(pk)) {
            plain = Some(p);
        }
    }
    if plain.is_none() {
        if let Ok(p) = decrypt_vault_cmd(&body_clean, ctx.private_key, None) {
            plain = Some(p);
        }
    }
    if plain.is_none() {
        for (email, pk) in ctx.peers.iter() {
            if *email == from_lc {
                continue;
            }
            if let Ok(p) = decrypt_vault_cmd(&body_clean, ctx.private_key, Some(pk)) {
                plain = Some(p);
                break;
            }
        }
    }
    let plain = match plain {
        Some(p) => p,
        None => {
            // Диагностика (29.08): тело + ключ при неудачной расшифровке —
            // base64 шифротекста, секрета не содержит. Бывает разово-битый
            // фетч (uid179 29.08): ретрай на следующем тике.
            if ctx.peers.is_empty() || !ctx.peers.contains_key(&from_lc) {
                log::info!("[svc-monitor] skip (sender not in peers): {from_lc}");
                // Отправитель не из контактов — ретраи бессмысленны.
                return Outcome::Dead;
            }
            // 30.08: печатаем также очищенную длину (без whitespace) и хвост —
            // определение источника порчи base64 (обрезка Gmail/фолдинг).
            let cleaned_len = body_clean.chars().filter(|c| !c.is_whitespace()).count();
            log::info!(
                "[svc-monitor] decrypt failed (try {}): {from_lc} peer={}… bodylen={} cleanlen={} head={} tail={}",
                e.tries + 1,
                ctx.peers.get(&from_lc).map(|k| k.chars().take(8).collect::<String>()).unwrap_or_default(),
                body_clean.len(),
                cleaned_len,
                body_clean.chars().take(60).collect::<String>(),
                body_clean.chars().rev().take(30).collect::<String>().chars().rev().collect::<String>()
            );
            return Outcome::Retry;
        }
    };

    // Конверт {vault:1, id, type?, text?, name?, ts}.
    let env_json: serde_json::Value = match serde_json::from_str(&plain) {
        Ok(v) => v,
        Err(_) => {
            // Не JSON, но AAD-расшифровка прошла: vault-письмо, legacy-текст.
            return if notify(&from_lc, &plain) {
                Outcome::Delivered
            } else {
                Outcome::Retry
            };
        }
    };
    if env_json.get("vault").and_then(|v| v.as_i64()) != Some(1) {
        return Outcome::Delivered; // расшифровалось, но не конверт: фиксируем, молча
    }
    // ЭХО-ЗАЩИТА (порт из processIncoming, 29.08): конверт с МОИМ публичным
    // ключом — это письмо себе (profile-broadcast / копия в свой ящик) —
    // НЕ уведомляем. Без неё self-письмо давало ложный пуш «от себя».
    if let Some(env_key) = env_json.get("key").and_then(|v| v.as_str()) {
        if let Ok(pb) = hex::decode(ctx.private_key) {
            if let Ok(arr) = <[u8; 32]>::try_from(pb.as_slice()) {
                let my_pub = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(arr));
                let my_pub_hex: String = my_pub
                    .as_bytes()
                    .iter()
                    .map(|b| format!("{b:02x}"))
                    .collect();
                if env_key.eq_ignore_ascii_case(&my_pub_hex) {
                    log::info!("[svc-monitor] echo-guard: letter with my own key, skip");
                    return Outcome::Delivered;
                }
            }
        }
    }
    let typ = env_json
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let env_ts = env_json.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);

    if typ.starts_with("call_") {
        let call_id = env_json
            .get("call_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // ФАЗА 1 (29.08): владелец состояния — call_state (kv). Терминальные
        // сигналы звонящего (cancel/end) = ended (надгробие гасит ретрансляции
        // и зомби). cancel от ЗВОНЯЩЕГО — не от нас: state=ended.
        if typ == "call_cancel" || typ == "call_end" {
            call_set_state(ctx.db, ctx.account, &call_id, "ended", "");
            log::info!("[svc-monitor] call {call_id}: {typ} → ended");
            return Outcome::Delivered;
        }
        if typ == "call_reject" {
            // Отклонил СОБЕСЕДНИК (мы звонили) или дублируем наш reject —
            // фиксируем как ended, чтобы поздние request не звонили.
            call_set_state(ctx.db, ctx.account, &call_id, "ended", "");
            return Outcome::Delivered;
        }
        // Свежий call_request.
        if typ == "call_request" && env_ts > 0 && now_ms() - env_ts < CALL_STALE_MS {
            // Идемпотентность: у call_id уже есть запись?
            match call_get_state(ctx.db, ctx.account, &call_id) {
                Some(existing) => {
                    match existing.state.as_str() {
                        // Уже звонит: ретрансляция — НЕ перезапускаем рингтон,
                        // НЕ обновляем уведомление. Просто фиксируем.
                        "ringing" => {
                            log::info!("[svc-monitor] call {call_id}: retransmission while ringing — ignore");
                            return Outcome::Delivered;
                        }
                        // Решение принято / звонок завершён / пропущен:
                        // надгробие гасит всё навсегда.
                        "accepted" | "rejected" | "missed" | "ended" => {
                            log::info!(
                                "[svc-monitor] call {call_id}: request after {} — silent",
                                existing.state
                            );
                            return Outcome::Delivered;
                        }
                        _ => {}
                    }
                }
                None => {
                    // Первый раз видим этот call_id → ringing + полный показ.
                    let caller = env_json
                        .get("name")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&from_lc)
                        .to_string();
                    call_set_state(ctx.db, ctx.account, &call_id, "ringing", &caller);
                    // email звонящего — для call_accept/reject из решения
                    // (nativeCallDecision, фаза 2): дописываем в запись.
                    let mut calls = calls_load(ctx.db, ctx.account);
                    if let Some(e2) = calls.get_mut(&call_id) {
                        e2.email = from_lc.clone();
                    }
                    calls_save(ctx.db, ctx.account, &calls);
                    let jni_ok =
                        crate::audio::audio_android::show_incoming_call_notification(&caller);
                    log::info!(
                        "[svc-monitor] call {call_id} NEW from {from_lc}: ringing, jni_ok={jni_ok}"
                    );
                    if jni_ok {
                        return Outcome::Delivered;
                    }
                    // JNI-путь не удался — хотя бы пуш «Пропущенный».
                    call_set_state(ctx.db, ctx.account, &call_id, "missed", &caller);
                    return if notify(&from_lc, "Пропущенный звонок Vault") {
                        Outcome::Delivered
                    } else {
                        Outcome::Retry
                    };
                }
            }
        }
        log::info!("[svc-monitor] call signal {typ} (stale or no ts) — silent");
        return Outcome::Delivered;
    }
    // Профиль-конверты/квитанции: текста нет — не уведомляем.
    let text = env_json
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if typ == "profile" || text.is_empty() {
        return Outcome::Delivered;
    }
    let name = env_json
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = if name.is_empty() { from_lc } else { name };
    if notify(&title, &text) {
        Outcome::Delivered
    } else {
        Outcome::Retry
    }
}

// ─────────────────────── Фетч тела (отдельная сессия) ───────────────────────

static BODY_CLIENT: OnceLock<tokio::sync::Mutex<EmailClient>> = OnceLock::new();

async fn fetch_body(folder: &str, uid: &str) -> Result<String, String> {
    let creds = crate::credential_store::load_credentials()
        .map_err(|e| e.to_string())?
        .ok_or("no creds")?;
    let entry = BODY_CLIENT.get_or_init(|| {
        tokio::sync::Mutex::new(EmailClient::new(EmailConfig {
            email: creds.email.clone(),
            password: creds.password.clone(),
            imap_server: creds.imap_server.clone(),
            imap_port: creds.imap_port,
            smtp_server: creds.smtp_server.clone(),
            smtp_port: creds.smtp_port,
        }))
    });
    let mut cl = entry.lock().await;
    // Разово-битый фетч (29.08 uid179): пересоединяемся перед КАЖДОЙ
    // попыткой — сессия IMAP могла рассинхрониться.
    let _ = cl.disconnect();
    cl.connect_imap()
        .await
        .map_err(|e| format!("body connect: {e}"))?;
    cl.fetch_message_body(uid, folder)
        .await
        .map_err(|e| format!("body fetch: {e}"))
}

// ─────────────────────── Уведомление через JNI ───────────────────────

/// Показ уведомления: JNI → static VaultForegroundService.showMessage.
/// context — глобальная ссылка сервиса из ndk-context.
/// Возвращает true только при успехе: Java-exception от вызова гасится
/// exception_clear (иначе pending-exception ронял ВЕСЬ процесс —
/// NoSuchMethodError 29.08 при R8-минификации), и мы честно ретраим.
pub fn notify(title: &str, text: &str) -> bool {
    let log_title = title.to_owned();
    let log_text = text.to_owned();
    let result = std::panic::catch_unwind(move || {
        let ctx = ndk_context::android_context();
        let vm =
            unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("vm: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let jtitle = env.new_string(title).map_err(|e| format!("t: {e}"))?;
        let jtext = env.new_string(text).map_err(|e| format!("x: {e}"))?;
        let cls = crate::audio::audio_android::find_app_class(
            &mut env,
            &activity,
            "com.vault.vault.VaultForegroundService",
        )
        .map_err(|e| format!("find class: {e}"))?;
        let call = env.call_static_method(
            &cls,
            "showMessage",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V",
            &[(&activity).into(), (&jtitle).into(), (&jtext).into()],
        );
        if let Err(err) = call {
            // ГАСИТЬ pending Java-exception ОБЯЗАТЕЛЬНО: брошенное
            // исключение остаётся на потоке и роняет процесс при следующем
            // входе в JVM (FATAL EXCEPTION 29.08 18:22).
            let _ = env.exception_clear();
            return Err(format!("showMessage: {err}"));
        }
        Ok::<(), String>(())
    });
    match result {
        Ok(Ok(())) => {
            log::info!("[svc-monitor] notify: {log_title}: {log_text}");
            true
        }
        Ok(Err(e)) => {
            log::error!("[svc-monitor] notify failed: {e}");
            false
        }
        Err(_) => {
            log::error!("[svc-monitor] notify panicked (JNI)");
            false
        }
    }
}

/// Tauri-команда (фаза 3, 30.08): JS сообщает монитору-владельцу решение/статус
/// звонка: accept/reject/active/ended. Пишет в call_state monitor.db — единую
/// базу с headless-монитором. Без неё монитор ставит missed поверх принятого.
#[tauri::command]
pub fn call_report_state(call_id: String, state: String) -> Result<(), String> {
    if call_id.is_empty() {
        return Err("empty call_id".into());
    }
    // monitor.db — тот же путь, что использует headless-монитор.
    let db_path = match dirs::data_local_dir() {
        Some(d) => d.join("com.vault.vault").join("monitor.db"),
        None => {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            std::path::PathBuf::from(home).join("monitor.db")
        }
    };
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let db = crate::storage::sqlite::Storage::open(Some(&db_path))
        .map_err(|e| format!("monitor.db open: {e}"))?;
    let db = std::sync::Arc::new(std::sync::Mutex::new(db));
    let account = crate::credential_store::load_credentials()
        .ok()
        .flatten()
        .map(|c| c.email.to_lowercase())
        .unwrap_or_default();
    // state от JS: accepted | rejected | ended (активный разговор = accepted)
    let mapped = match state.as_str() {
        "accept" | "accepted" | "active" => "accepted",
        "reject" | "rejected" => "rejected",
        "end" | "ended" | "cancel" | "hangup" => "ended",
        _ => state.as_str(),
    };
    call_set_state(&db, &account, &call_id, mapped, "");
    log::info!("[svc-monitor] JS reported call {call_id} → {mapped}");
    // 30.08: при принятом/отклонённом решении немедленно гасим нативное
    // уведомление звонка (раньше висело до hangup — юзер видел «утечку»).
    if matches!(mapped, "accepted" | "rejected") {
        crate::audio::audio_android::dismiss_incoming_call_notification();
    }
    Ok(())
}
