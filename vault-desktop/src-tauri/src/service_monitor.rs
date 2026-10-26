// Headless IMAP-монитор для Android-сервиса.
//
// ПРОБЛЕМА: при свёрнутом Vault пользователь смахивает приложение из
// recents / жмёт «назад» → activity finish + remove-task → процесс умирает
// Система
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
//
// НАДЁЖНОСТЬ: доставка ТРАНЗАКЦИОННАЯ.
// расшифровка/фетч тела) терял письмо навсегда (курсор уже продвинут,
// Message-ID в seen). Теперь письмо попадает в pending-очередь (kv
// monitor.db) и живёт там, пока уведомление не покажется УСПЕШНО:
//   • notify через JNI упал → ретрай (Java-exception погашен
//     exception_clear, процесс жив);
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
use crate::email::{EmailClient, EmailConfig, IdleOutcome};
use crate::key_store;

// ───────────── Логи в logcat (headless-процесс не имеет stderr) ─────────────
// eprintln! в сервис-процессе (без Tauri) уходит в /dev/null: stderr там
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

// Состояние монитора (pending-очередь, seen-дедуп, машина состояний звонка,
// пре-фильтр и классификация письма) живёт в `crate::monitor_state` — там же
// его пробы, которые с хоста не видны, если всё осталось под `cfg(android)`.
// Здесь остаются только JNI, IMAP-цикл и показ уведомлений.
use crate::monitor_state::{
    call_get_state, call_set_state, calls_load, calls_save, decrypt_order, derived_public_hex,
    group_invite_notice, ingest, is_group_invite, is_vault_envelope, key_fingerprint_prefix,
    missed_call_notice, monitor_db_path, notice_for, pending_list, pending_save, remove_pending,
    retry_effect, seen_push, unknown_sender, PendingEntry, RetryEffect,
};

// Таймауты, лимиты и предикат свежести — в ядре (`vault::timings`): это числа
// протокола, и, пока они лежали во мосту, их не мерил ни один гейт
// (`rust-mutation-gate` считает наборы по крейту `vault-client`). Форма адреса
// и переходы журнала звонков — там же (ADR-005 §W4, партии 2-3).
use vault_client::vault::call;
use vault_client::vault::call_record::{self, Incoming, RecordState};
use vault_client::vault::identity;
use vault_client::vault::timings::{now_ms, CALL_STALE_MS, RING_TIMEOUT_MS};

// ───────────── Адрес контакта: решение в ядре, обход — в peer_index ─────────────
// Поиск ключа собеседника (сигнал звонка, письмо-отказ, SOS) и карта контактов
// для расшифровки входящих вынесены в `crate::peer_index`: там же и их пробы.
use crate::peer_index::{is_own_public_key, peer_key_for, peer_map};

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
    crate::set_env_safe("HOME", &dir);
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
/// Шифруем
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
            Ok(list) => peer_key_for(&list, &email),
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
        let plain = call::build_service_call_signal(&sig, &cid, now_ms());
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

/// ───────────── Решение пользователя по звонку ─────────────
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
    let Some(account) = identity::ledger_key(&creds.email) else {
        log::warn!("[svc-monitor] decision: пустой адрес аккаунта — записи звонка не найдём");
        return;
    };
    let db_path = monitor_db_path(
        dirs::data_local_dir(),
        &std::env::var("HOME").unwrap_or_else(|_| ".".into()),
    );
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
    if entry.state != RecordState::Ringing.as_str() {
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
            call_set_state(
                &db,
                &account,
                &cid,
                RecordState::Rejected.as_str(),
                &entry.caller,
            );
            // call_reject звонящему (тот же путь, что nativeSendCallSignal).
            spawn_call_signal_email(entry.email.clone(), cid.clone(), "call_reject");
        }
        "accept" => {
            call_set_state(
                &db,
                &account,
                &cid,
                RecordState::Accepted.as_str(),
                &entry.caller,
            );
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
            Ok(list) => peer_key_for(&list, &email),
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
        let plain = call::build_service_call_signal(signal, &call_id, now_ms());
        let cipher = match crate::crypto::encrypt_vault_cmd(
            &plain,
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
    let peers: HashMap<String, String> = match key_store::load_peer_keys() {
        Ok(list) => peer_map(&list),
        Err(_) => HashMap::new(),
    };
    let Some(account) = identity::ledger_key(&creds.email) else {
        // Пустой адрес аккаунта — нечего ни мониторить, ни писать в БД:
        // пространство имён «ни от кого» позже совпадало бы с любым письмом.
        log::warn!("[svc-monitor] пустой адрес аккаунта — монитор не стартует");
        return;
    };
    log::info!("[svc-monitor] peers loaded: {}", peers.len());
    // выведенный из
    // загруженного привата публичный ключ. Если он != ожидаемому (JS app
    // показывает тот же fingerprint в UI), монитор читает ЧУЖОЙ keypair.json
    // (не тот HOME / не тот каталог) — корень «письмо не расшифровывается
    // монитором, но расшифровывается открытым приложением».
    {
        if let Some(dhex) = derived_public_hex(&keypair.private_key) {
            log::info!(
                "[svc-monitor] keypair derived pub={}… (priv={}…)",
                key_fingerprint_prefix(&dhex),
                key_fingerprint_prefix(&keypair.private_key)
            );
        }
    }

    // 4) Своя sqlite-база: независимые курсоры + дедуп/pending-очередь.
    let db_path = monitor_db_path(
        dirs::data_local_dir(),
        &std::env::var("HOME").unwrap_or_else(|_| ".".into()),
    );
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
        // Подключаемся ТОЛЬКО если сессии нет (ensure_connected) + backoff.
        // Безусловный connect_imap() здесь создавал новое TCP+TLS-соединение
        // на КАЖДОЙ итерации цикла (раз в 7с) — постоянный шторм подключений
        // в logcat при живом ящике.
        if let Err(e) = client.ensure_connected().await {
            let wait = client.backoff_delay().min(Duration::from_secs(2));
            log::warn!("[svc-monitor] connect backoff {}s: {e}", wait.as_secs());
            for _ in 0..((wait.as_millis() as u64) / 100).max(1) {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            continue;
        }
        // pending-очередь
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
                // Пауза по лестнице backoff (idle_wait уже переподключился
                // внутри): при устойчивом сбое не крутим цикл вхолостую.
                let wait = client.backoff_delay().min(Duration::from_secs(5));
                for _ in 0..((wait.as_millis() as u64) / 100).max(1) {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
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
                        ingest(ctx.db, ctx.account, m);
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
// Очередь и её персистентность — в `crate::monitor_state` (там и пробы); здесь
// только контекст цикла и решение, что с записью делать после попытки.

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

// Таймаут звонка без решения (фаза 1): 45 с — в ядре (`vault::timings`,
// `RING_TIMEOUT_MS`), сам переход — там же (`call_record::ring_expired`).

/// ringing дольше RING_TIMEOUT_MS → missed + пуш + dismiss уведомления.
/// Вызывается каждым тиком run_loop (7 с) — ретрансляции не сбрасывают
/// updated_at (решение/таймаут по ВРЕМЕНИ ПЕРВОГО рингтона).
fn check_ring_timeouts(ctx: &Ctx<'_>) {
    let calls = calls_load(ctx.db, ctx.account);
    let now = now_ms();
    let mut changed = false;
    for (call_id, c) in calls.iter() {
        if call_record::ring_expired(&c.state, c.updated_at, now, RING_TIMEOUT_MS) {
            // missed: надгробие против поздних ретрансляций.
            call_set_state(
                ctx.db,
                ctx.account,
                call_id,
                RecordState::Missed.as_str(),
                "",
            );
            log::info!("[svc-monitor] call {call_id}: ring timeout → missed");
            // Снять уведомление звонка (рингтон+вибро) — если висит.
            crate::audio::audio_android::dismiss_incoming_call_notification();
            // Пуш-резюме: юзер должен узнать о пропущенном.
            let notice = missed_call_notice(&c.caller);
            let _ = notify(&notice.title, &notice.text);
            changed = true;
        }
    }
    if changed {
        // TTL-чистка надгробий произойдёт внутри calls_save.
        let calls = calls_load(ctx.db, ctx.account);
        calls_save(ctx.db, ctx.account, &calls);
    }
}

// ─────────────────────── Пре-фильтр и дедуп ───────────────────────
// Классификация входящего (свежесть по Date, Message-ID, форма адреса,
// распознавание приглашений) — в `crate::monitor_state`: там же пробы,
// которые не могут жить под `cfg(target_os = "android")`.

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
                remove_pending(ctx.db, ctx.account, &entry.mid);
            }
            Outcome::HandledByJs => {
                log::info!(
                    "[svc-monitor] handled by JS (activity alive): {}",
                    entry.from
                );
                remove_pending(ctx.db, ctx.account, &entry.mid);
            }
            Outcome::Dead => {
                log::warn!(
                    "[svc-monitor] give up after {} tries: {} mid={}…",
                    entry.tries,
                    entry.from,
                    &entry.mid[..entry.mid.len().min(24)]
                );
                seen_push(ctx.db, ctx.account, &entry.mid);
                remove_pending(ctx.db, ctx.account, &entry.mid);
            }
            Outcome::Retry => {
                // tries+1, запись назад (первая в очереди — сохраняем порядок).
                let mut list = pending_list(ctx.db, ctx.account);
                if let Some(e) = list.iter_mut().find(|e| e.mid == entry.mid) {
                    e.tries += 1;
                    if retry_effect(e.tries) == RetryEffect::GiveUp {
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
                remove_pending(ctx.db, ctx.account, &entry.mid);
                return;
            }
        }
    }
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
    // ВАЖНО: fetch_message_body УЖЕ декодирует quoted-printable.
    // Повторный декод здесь ПОРТИЛ base64: хвостовой padding "==" и случайные
    // "=XX" во 2-м проходе съедали 2 байта данных (bodylen 8193 при валидном
    // 8088 → len%4=1 → «decrypt failed» → звонок/уведомление молча гибли).
    let body_clean = body;

    // Групп-приглашение: распознавание тела — в `monitor_state::is_group_invite`
    // (там и его пробы). Здесь только реакция: системный пуш, письмо остаётся в
    // ящике для JS.
    if is_group_invite(&body_clean) {
        let notice = group_invite_notice(&e.from);
        return if notify(&notice.title, &notice.text) {
            log::info!("[svc-monitor] group invite notified from {}", e.from);
            Outcome::Delivered
        } else {
            Outcome::Retry
        };
    }

    // Расшифровка: порядок перебора — в `monitor_state::decrypt_order`
    // (ключ отправителя → self-ключ → остальные контакты). Правило живёт не
    // здесь, потому что этот модуль с хоста не компилируется и проверить его
    // мутациями нельзя; здесь только исполнение.
    let from_lc = e.from.clone();
    let mut plain: Option<String> = None;
    for candidate in decrypt_order(&ctx.peers, &from_lc) {
        if let Ok(p) = decrypt_vault_cmd(&body_clean, ctx.private_key, candidate) {
            plain = Some(p);
            break;
        }
    }
    let plain = match plain {
        Some(p) => p,
        None => {
            // base64 шифротекста, секрета не содержит. Бывает разово-битый
            // фетч: ретрай на следующем тике.
            if unknown_sender(&ctx.peers, &from_lc) {
                log::info!("[svc-monitor] skip (sender not in peers): {from_lc}");
                // Отправитель не из контактов — ретраи бессмысленны.
                return Outcome::Dead;
            }
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
    if !is_vault_envelope(&env_json) {
        return Outcome::Delivered;
    }
    // ЭХО-ЗАЩИТА: конверт с МОИМ публичным
    // ключом — это письмо себе (profile-broadcast / копия в свой ящик) —
    // НЕ уведомляем. Без неё self-письмо давало бы ложный пуш «от себя».
    if let Some(env_key) = env_json.get("key").and_then(|v| v.as_str()) {
        if let Some(my_pub_hex) = derived_public_hex(ctx.private_key) {
            if is_own_public_key(env_key, &my_pub_hex) {
                log::info!("[svc-monitor] echo-guard: letter with my own key, skip");
                return Outcome::Delivered;
            }
        }
    }
    let typ = env_json
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let env_ts = env_json.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);

    if call_record::is_call_signal(&typ) {
        let call_id = env_json
            .get("call_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        // ВЛАДЕЛЕЦ ПРАВИЛА — ядро (`vault_client::vault::call_record`): там живёт
        // порядок переходов и там его ловят мутации (`rust-call-record`). Здесь
        // остаётся ровно исполнение: чтение и запись kv, JNI-уведомление, пуш.
        // Раньше правило было написано отсюда, а модуль целиком под
        // #[cfg(target_os = "android")] — то есть на хосте его тесты не
        // компилировались вообще, и проверка сводилась к живой приёмке.
        let name = env_json.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let existing = call_get_state(ctx.db, ctx.account, &call_id).map(|e| e.state);
        return match call_record::decide_incoming(
            &typ,
            env_ts,
            now_ms(),
            CALL_STALE_MS,
            existing.as_deref(),
            name,
            &from_lc,
        ) {
            // Терминальные сигналы звонящего (cancel/end) и reject от собеседника
            // = ended: надгробие гасит ретрансляции и зомби.
            Incoming::Terminate => {
                call_set_state(
                    ctx.db,
                    ctx.account,
                    &call_id,
                    RecordState::Ended.as_str(),
                    "",
                );
                log::info!("[svc-monitor] call {call_id}: {typ} → ended");
                Outcome::Delivered
            }
            // Уже гудим: ретрансляция call_request — НЕ перезапускаем рингтон и
            // НЕ обновляем уведомление.
            Incoming::Retransmission => {
                log::info!("[svc-monitor] call {call_id}: retransmission while ringing — ignore");
                Outcome::Delivered
            }
            // Решение принято / звонок завершён / пропущен: молча гасим навсегда.
            Incoming::Settled(state) => {
                log::info!(
                    "[svc-monitor] call {call_id}: request after {} — silent",
                    state.as_str()
                );
                Outcome::Delivered
            }
            // Первый раз видим этот call_id → ringing + полный показ.
            Incoming::Ring { caller } => {
                call_set_state(
                    ctx.db,
                    ctx.account,
                    &call_id,
                    RecordState::Ringing.as_str(),
                    &caller,
                );
                // email звонящего — для call_accept/reject из решения
                // (nativeCallDecision, фаза 2): дописываем в запись.
                let mut calls = calls_load(ctx.db, ctx.account);
                if let Some(e2) = calls.get_mut(&call_id) {
                    e2.email = from_lc.clone();
                }
                calls_save(ctx.db, ctx.account, &calls);
                let jni_ok = crate::audio::audio_android::show_incoming_call_notification(&caller);
                log::info!(
                    "[svc-monitor] call {call_id} NEW from {from_lc}: ringing, jni_ok={jni_ok}"
                );
                if jni_ok {
                    Outcome::Delivered
                } else {
                    // JNI-путь не удался — хотя бы пуш «Пропущенный».
                    call_set_state(
                        ctx.db,
                        ctx.account,
                        &call_id,
                        RecordState::Missed.as_str(),
                        &caller,
                    );
                    let notice = missed_call_notice(&from_lc);
                    if notify(&notice.title, &notice.text) {
                        Outcome::Delivered
                    } else {
                        Outcome::Retry
                    }
                }
            }
            // Не опознан, устарел или пришёл без ts.
            Incoming::Silent => {
                log::info!("[svc-monitor] call signal {typ} (stale or no ts) — silent");
                Outcome::Delivered
            }
        };
    }
    // SOS («телефон не у меня») и обычный конверт: что показать — правило
    // `monitor_state::notice_for` (там и его пробы). Профиль-конверты и
    // квитанции возвращают None: текста нет, уведомлять нечем.
    let notice = match notice_for(&env_json, &typ, &from_lc) {
        Some(n) => n,
        None => return Outcome::Delivered,
    };
    let delivered = notify(&notice.title, &notice.text);
    if delivered && typ == "sos" {
        log::info!("[svc-monitor] SOS delivered from {from_lc}");
    }
    if delivered {
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
    // Разово-битый фетч: пересоединяемся перед КАЖДОЙ
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
            // входе в JVM.
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

/// Tauri-команда: JS сообщает монитору-владельцу решение/статус
/// звонка: accept/reject/active/ended. Пишет в call_state monitor.db — единую
/// базу с headless-монитором. Без неё монитор ставит missed поверх принятого.
#[tauri::command]
pub fn call_report_state(call_id: String, state: String) -> Result<(), String> {
    if call_id.is_empty() {
        return Err("empty call_id".into());
    }
    // monitor.db — тот же путь, что использует headless-монитор.
    let db_path = monitor_db_path(
        dirs::data_local_dir(),
        &std::env::var("HOME").unwrap_or_else(|_| ".".into()),
    );
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let db = crate::storage::sqlite::Storage::open(Some(&db_path))
        .map_err(|e| format!("monitor.db open: {e}"))?;
    let db = std::sync::Arc::new(std::sync::Mutex::new(db));
    let account = crate::credential_store::load_credentials()
        .ok()
        .flatten()
        // Пространство имён журнала звонков — форма адреса из ядра: иначе
        // дубли записей на аккаунте с обрамляющими пробелами.
        .and_then(|c| identity::ledger_key(&c.email))
        .unwrap_or_default();
    // state от JS: глагол действия (accept | reject | end), а журнал хранит
    // состояние; активный разговор = accepted. Отображение — правило ядра
    // (`vault_client::vault::call_record::report_state`).
    let mapped = call_record::report_state(&state);
    call_set_state(&db, &account, &call_id, mapped, "");
    log::info!("[svc-monitor] JS reported call {call_id} → {mapped}");
    // уведомление звонка.
    if call_record::dismisses_ring(mapped) {
        crate::audio::audio_android::dismiss_incoming_call_notification();
    }
    Ok(())
}

/// Duress-SOS: зашифрованные письма выбранным контактам из headless
/// контекста. Тело
/// Vault-конверт type:"sos", как sendDuressSos JS — получатели видят сообщение
/// в чате от нас + системное уведомление от своего монитора.
///
/// Возвращает Err, если НЕ отправлено ни одного письма: тихий `Ok(())`
/// при сломанной цепочке (нет keypair, нет кредов, зашифрование не удалось)
/// делал аварийный канал невидимо мёртвым. Вызывается с обычной std-нити
/// (`duress::send_sos_headless`), поэтому `block_on` здесь безопасен.
pub fn send_sos_mails(recipients: &[String], text: &str) -> Result<(), String> {
    let recipients: Vec<String> = recipients.to_vec();
    let text = text.to_string();
    runtime().block_on(async move {
        let priv_key = match crate::key_store::load_keypair() {
            Ok(Some(k)) => k.private_key,
            Ok(None) => {
                return Err(
                    "SOS не отправлен: нет моей пары ключей (аккаунт не восстановлен на этом устройстве)"
                        .into(),
                )
            }
            Err(e) => return Err(format!("SOS не отправлен: не удалось прочитать мою пару ключей: {e}")),
        };
        let peers = crate::key_store::load_peer_keys().unwrap_or_default();
        let Some(creds) = crate::credential_store::load_credentials().ok().flatten() else {
            return Err("SOS не отправлен: нет сохранённых почтовых кредов".into());
        };
        if recipients.is_empty() {
            return Err("SOS не отправлен: список получателей пуст".into());
        }
        let mut client = EmailClient::new(EmailConfig {
            email: creds.email.clone(),
            password: creds.password.clone(),
            imap_server: creds.imap_server,
            imap_port: creds.imap_port,
            smtp_server: creds.smtp_server,
            smtp_port: creds.smtp_port,
        });
        let mut sent = 0usize;
        let mut failures: Vec<String> = Vec::new();
        for rcpt in &recipients {
            let peer_key = peer_key_for(&peers, rcpt);
            let plain = vault_client::vault::duress::build_sos_envelope(&text, now_ms());
            let cipher = match crate::crypto::encrypt_vault_cmd(
                &plain,
                &priv_key,
                peer_key.as_deref(),
            ) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("[duress] SOS encrypt failed for {rcpt}: {e}");
                    failures.push(format!("{rcpt}: зашифрование не удалось ({e})"));
                    continue;
                }
            };
            match client.send_email(rcpt.as_str(), "", &cipher).await {
                Ok(()) => {
                    log::info!("[duress] SOS sent to {rcpt}");
                    sent += 1;
                }
                Err(e) => {
                    log::warn!("[duress] SOS send failed for {rcpt}: {e}");
                    failures.push(format!("{rcpt}: отправка не удалась ({e})"));
                }
            }
        }
        if sent == 0 {
            return Err(format!(
                "SOS не дошёл ни до одного получателя из {} ({}): {}",
                recipients.len(),
                failures.len(),
                failures.join("; ")
            ));
        }
        if !failures.is_empty() {
            log::warn!(
                "[duress] SOS дошёл до {sent}, не дошёл до {}: {}",
                failures.len(),
                failures.join("; ")
            );
        }
        Ok(())
    })
}
