// ── Duress-защита ──────────────────────────────
// Замок приложения + panic-PIN (стереть всё) + duress-PIN (SOS-письмо с гео).
//
// Хранение: kv_store (account='anon', key='duress-config'), JSON:
//   { lock_enabled: bool, lock_hash: hex, panic_hash: hex|null,
//     duress_hash: hex|null, sos_recipients: [email], sos_text: string|null }
// Хэш: PBKDF2-HMAC-SHA256, 10_000 итераций, соль 16 байт → "salt:hash" (hex).
// PIN-компаратор — constant-time.
//
// Порядок проверки при разблокировке:
//   1. lock_hash  → нормальный вход;
//   2. duress_hash → SILENT: отправить SOS, открыть приложение в «обычном» виде
//      (чтобы не выдавать), флаг 'duress-open' в kv — фронт после старта шлёт SOS;
//   3. panic_hash  → wipe_all_data() → выход на login с «пустым» видом.
//
// wipe_all_data: ключи (keypair+peer), credentials, groups.json, chat_history,
// tombstones, body_cache, chat-cache/unread-кв, emails — всё локальное. Письма
// на IMAP-сервере не трогаем (там только шифротехст).

// Хэш/проверка — протокол замка (итерации KDF, формат `salt:hash`), поэтому
// живут в ядре (ADR-005 §W4, `t_502b6c90`). Мост только читает/пишет конфиг
// и вызывает эти функции, а JNI-замок Android — тот же `verify_secret`.
pub use vault_client::vault::duress::{hash_secret, verify_secret};

// ── Tauri-команды duress ───────────────────────────────────────
// Хранение конфига — kv_store('anon', 'duress-config'). Действия по типу ввода
// решает фронт (у него контекст UI); Rust даёт крипту (хэш/проверка) и wipe.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DuressConfig {
    #[serde(default)]
    pub lock_enabled: bool,
    #[serde(default)]
    pub lock_hash: String,
    #[serde(default)]
    pub panic_hash: String,
    #[serde(default)]
    pub duress_hash: String,
    #[serde(default)]
    pub sos_recipients: Vec<String>,
    #[serde(default)]
    pub sos_text: String,
    /// Добавлять координаты в SOS (флаг из настроек).
    #[serde(default)]
    pub sos_geo: bool,
    /// Снимать замок по отпечатку (Android, BiometricPrompt). Desktop — no-op.
    #[serde(default)]
    pub bio_enabled: bool,
}

pub fn load_config() -> DuressConfig {
    match crate::storage::sqlite::Storage::open(None) {
        Ok(s) => s
            .kv_get("anon", "duress-config")
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default(),
        Err(_) => DuressConfig::default(),
    }
}

pub fn save_config(cfg: &DuressConfig) -> Result<(), String> {
    let s = crate::storage::sqlite::Storage::open(None).map_err(|e| e.to_string())?;
    s.kv_set(
        "anon",
        "duress-config",
        &serde_json::to_string(cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Android: дублируем замок в SharedPreferences — Kotlin-замок
    // (LockActivity) читает prefs, а не БД: единый источник конфига для
    // нативного экрана блокировки.
    #[cfg(target_os = "android")]
    {
        let enabled = cfg.lock_enabled && !cfg.lock_hash.is_empty();
        sync_prefs_android(
            enabled,
            &cfg.lock_hash,
            &cfg.duress_hash,
            &cfg.panic_hash,
            cfg.bio_enabled,
        );
    }
    Ok(())
}

/// Стирание ВСЕХ локальных данных (panic-PIN). Порядок важен: сначала
/// креды/ключи (секреты), потом история. IMAP-сервер не трогаем.
pub fn wipe_all_data() -> Result<(), String> {
    // 1. Ключи шифрования + peer-ключи
    crate::key_store::delete_all_keys().map_err(|e| e.to_string())?;
    // 2. Креды почты (зашифрованные на устройстве)
    let _ = crate::credential_store::delete_credentials();
    // 3. Группы
    let _ = crate::groups::delete_all_local();
    // 4. Локальная БД: чаты/история/тумбы/кэши/курсоры/kv
    let s = crate::storage::sqlite::Storage::open(None).map_err(|e| e.to_string())?;
    s.wipe_user_data().map_err(|e| e.to_string())
}

// ── Android-мост замка: PBKDF2-проверка для LockActivity ─────────
// Вызывается из Kotlin (external fun nativeVerifyPin). Тот же verify_secret,
// что у JS-замка: один формат хэша —salt:hash hex.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_VaultForegroundService_00024Companion_nativeVerifyPin(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    code: jni::objects::JString,
    hash: jni::objects::JString,
) -> jni::sys::jboolean {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    let r = catch_unwind(AssertUnwindSafe(|| -> Result<bool, String> {
        let code: String = env
            .get_string(&code)
            .map_err(|e| format!("code: {e}"))?
            .into();
        let hash: String = env
            .get_string(&hash)
            .map_err(|e| format!("hash: {e}"))?
            .into();
        Ok(verify_secret(&code, &hash))
    }));
    let ok = matches!(r, Ok(Ok(true)));
    if r.is_err() {
        let _ = env.exception_clear();
    }
    ok as jni::sys::jboolean
}

/// Записать lock_enabled/pin_hash в Android SharedPreferences (дубликат
/// конфига для Kotlin-замка). Вызывается из duress_save_config на Android.
#[cfg(target_os = "android")]
pub fn sync_prefs_android(
    enabled: bool,
    pin_hash: &str,
    duress_hash: &str,
    panic_hash: &str,
    bio: bool,
) {
    use jni::objects::JValue;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let r = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm =
            unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("vm: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let cls = crate::audio::audio_android::find_app_class(
            &mut env,
            &activity,
            "com.vault.vault.VaultForegroundService",
        )
        .map_err(|e| format!("find class: {e}"))?;
        let jenabled = env
            .new_string(if enabled { "1" } else { "0" })
            .map_err(|e| e.to_string())?;
        let jhash = env.new_string(pin_hash).map_err(|e| e.to_string())?;
        let jduress = env.new_string(duress_hash).map_err(|e| e.to_string())?;
        let jpanic = env.new_string(panic_hash).map_err(|e| e.to_string())?;
        let jbio = env
            .new_string(if bio { "1" } else { "0" })
            .map_err(|e| e.to_string())?;
        let call = env.call_static_method(
            &cls,
            "syncLockPrefs",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
            &[(&activity).into(), (&jenabled).into(), (&jhash).into(), (&jduress).into(), (&jpanic).into(), (&jbio).into()],
        );
        if let Err(err) = call {
            let _ = env.exception_clear();
            return Err(format!("syncLockPrefs: {err}"));
        }
        Ok(())
    }));
    match r {
        Ok(Ok(())) => log::info!("[duress] sync_prefs_android: OK (enabled={enabled})"),
        Ok(Err(e)) => log::error!("[duress] sync_prefs_android FAILED: {e}"),
        Err(_) => log::error!("[duress] sync_prefs_android PANICKED"),
    }
}

// ── Android: duress/panic из нативного LockActivity ────────────────

/// Полный вайп при panic-коде: ключи, БД сообщений, конфиг замка (в т.ч. prefs).
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_VaultForegroundService_00024Companion_nativePanicWipe(
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = crate::groups::delete_all_local();
        match crate::storage::sqlite::Storage::open(None).and_then(|s| s.wipe_user_data()) {
            Ok(()) => log::info!("[duress] panic wipe: local data wiped"),
            Err(e) => log::error!("[duress] panic wipe failed: {e}"),
        }
        // prefs замка очищаем тоже: после вайпа замок не должен требовать старый PIN.
        let _ = clear_prefs_android();
    }));
}

/// Текст SOS-письма: правило подстановки координат. Отделено от JNI-обёртки,
/// чтобы жить НЕ под `cfg(target_os = "android")`: внутри обёртки правило
/// недостижимо для проверок с хоста (ни одна правка строки там не измеряется
/// никогда), а ошибка в нём — это письмо без текста или без места, где человек
/// есть.
///
/// Текущий смысл правила (без изменений против того, что было в обёртке):
///   * координат нет — плейсхолдер снимается;
///   * плейсхолдер есть — подставляется на его месте;
///   * плейсхолдера нет, но гео включено и координаты есть — они дописываются
///     в конец через ` | `.
///
/// У ПРАВИЛА ЕСТЬ ВТОРАЯ КОПИЯ — `features/duress.js:166-169` (настольная
/// ветка), и копии РАЗОШЛИСЬ: JS берёт дефолтный текст из локали, когда
/// `sos_text` пуст (здесь остаётся пустой строка), JS меняет только ПЕРВЫЙ
/// `{coords}` (здесь — все), и разделитель хвоста у них разный. Сведение копий
/// — отдельный шаг (канбан), потому что дефолтный текст — решение о том, ЧТО
/// пишет человек под принуждением.
pub fn compose_sos_text(cfg: &DuressConfig, geo: &str) -> String {
    if geo.is_empty() {
        return cfg.sos_text.replace("{coords}", "");
    }
    if cfg.sos_text.contains("{coords}") {
        return cfg.sos_text.replace("{coords}", geo);
    }
    if cfg.sos_geo {
        return format!("{} | {}", cfg.sos_text, geo);
    }
    // Сюда доходят только тексты БЕЗ плейсхолдера (ветка выше его уже сняла),
    // поэтому подстановка здесь была бы проверена на входе, который её никогда
    // не увидит: 25.10 мутант «убрать replace» выжил ровно потому, что на
    // достижимом входе он тождествен. Текст возвращается как есть.
    cfg.sos_text.clone()
}

/// Тихий SOS при duress-коде: headless-отправка письма выбранным контактам
/// (текст + координаты, если включены) без открытия UI.
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_VaultForegroundService_00024Companion_nativeSendDuressSos(
    mut env: jni::JNIEnv,
    _service: jni::objects::JObject,
    geo: jni::objects::JString,
) {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let _ = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        let geo: String = env.get_string(&geo).map_err(|e| e.to_string())?.into();
        let cfg = crate::duress::load_config();
        if cfg.sos_recipients.is_empty() {
            // Громко: это тот случай, когда «SOS не ушёл» неотличим от «SOS ушёл».
            // Ни один экран об отказе не сообщает, а человек под принуждением
            // считает, что сигнал отправлен.
            log::error!("[duress] SOS НЕ ОТПРАВЛЕН: получатели не настроены (замок, скорее всего, не настраивался)");
            return Err("sos: no recipients".into());
        }
        let text = crate::duress::compose_sos_text(&cfg, &geo);
        crate::duress::send_sos_headless(&cfg.sos_recipients, &text);
        Ok(())
    }));
}

/// Очистить prefs замка (после panic-wipe).
#[cfg(target_os = "android")]
pub fn clear_prefs_android() -> Result<(), String> {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let r = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm =
            unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("vm: {e}"))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let cls = crate::audio::audio_android::find_app_class(
            &mut env,
            &activity,
            "com.vault.vault.VaultForegroundService",
        )
        .map_err(|e| format!("find class: {e}"))?;
        let call = env.call_static_method(
            &cls,
            "clearLockPrefs",
            "(Landroid/content/Context;)V",
            &[(&activity).into()],
        );
        if let Err(err) = call {
            let _ = env.exception_clear();
            return Err(format!("clearLockPrefs: {err}"));
        }
        Ok(())
    }));
    match r {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("panic".into()),
    }
}

/// Headless SOS-отправка: письмо выбранным контактам без открытия UI.
///
/// Форма (проверена по коду, 25.10): конверт `{"vault":1,"id":"<ms>sos",
/// "type":"sos","text":…,"ts":…}` шифруется `crypto::encrypt_vault_cmd`, ТЕМА
/// письма пустая (`send_email(rcpt, "", cipher)`). Маркера `[VAULT-SOS]` в
/// открытом тексте НИКОГДА не было — получатель распознаёт SOS по
/// `env.type === "sos"` уже после расшифровки. Если ключ получателя не найден,
/// шифрование идёт на производном от МОЕГО публичного ключа — письмо читает
/// только я (для «доказательства, что сигнал был»), а не адресат.
#[cfg(target_os = "android")]
pub fn send_sos_headless(recipients: &[String], text: &str) {
    let recipients: Vec<String> = recipients.to_vec();
    let text = text.to_string();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::service_monitor::send_sos_mails(&recipients, &text)
        }));
        match r {
            Ok(Ok(())) => log::info!(
                "[duress] SOS: хотя бы одному из {} получателей отправлено",
                recipients.len()
            ),
            Ok(Err(e)) => log::error!("[duress] SOS send failed: {e}"),
            Err(_) => log::error!("[duress] SOS send panicked"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);

    /// `load_config`/`save_config` идут через `Storage::open(None)`, а тот
    /// захватывает keys-guard — поэтому редиректим ОБЕ переменные: и файл БД, и
    /// каталог ключей. Настоящий `~/.local/share/com.vault.vault/vault.db` и
    /// `~/.vault/keys` не открываются вообще.
    fn with_tmp_db<T>(f: impl FnOnce() -> T) -> T {
        let _guard = crate::env_test_guard();
        let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("duress_{}-{}", std::process::id(), seq));
        let _ = std::fs::create_dir_all(&dir);
        let db = dir.join("vault.db");
        crate::set_env_safe("VAULT_TEST_DB_FILE", &db);
        crate::set_env_safe("VAULT_TEST_KEYS_DIR", &dir);
        // Уборка и снятие редиректов — даже когда внутри аSSERTION FAILED:
        // брошенная VAULT_TEST_DB_FILE увела бы остальные тесты в чужой файл.
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(format!("{}{}", db.display(), suffix));
        }
        let _ = std::fs::remove_dir_all(&dir);
        std::env::remove_var("VAULT_TEST_DB_FILE");
        std::env::remove_var("VAULT_TEST_KEYS_DIR");
        match r {
            Ok(v) => v,
            Err(_) => panic!("паника внутри duress-теста"),
        }
    }

    fn raw_kv(account: &str, key: &str) -> Option<String> {
        crate::storage::sqlite::Storage::open(None)
            .ok()
            .and_then(|s| s.kv_get(account, key).ok().flatten())
    }

    fn cfg(lock_hash: &str, text: &str) -> DuressConfig {
        DuressConfig {
            lock_enabled: true,
            lock_hash: lock_hash.into(),
            panic_hash: "aa:bb".into(),
            duress_hash: "cc:dd".into(),
            sos_recipients: vec!["a@x".into(), "b@x".into()],
            sos_text: text.into(),
            sos_geo: true,
            bio_enabled: true,
        }
    }

    #[test]
    fn duress_config_round_trips_through_the_anon_row() {
        with_tmp_db(|| {
            let written = cfg("11:22", "Телефон не у меня");
            save_config(&written).expect("save_config");
            // Запись лежит именно под ('anon','duress-config') — иначе Kotlin-замок
            // и JS-фронт читают другую строку.
            let row = raw_kv("anon", "duress-config").expect("строка конфига не найдена");
            assert!(row.contains("11:22"), "хэш замка не в строке: {row}");
            let read = load_config();
            assert_eq!(read.lock_enabled, written.lock_enabled);
            assert_eq!(read.lock_hash, written.lock_hash);
            assert_eq!(read.panic_hash, written.panic_hash);
            assert_eq!(read.duress_hash, written.duress_hash);
            assert_eq!(read.sos_recipients, written.sos_recipients);
            assert_eq!(read.sos_text, written.sos_text);
            assert_eq!(read.sos_geo, written.sos_geo);
            assert_eq!(read.bio_enabled, written.bio_enabled);
        });
    }

    #[test]
    fn second_save_replaces_the_first_config_whole() {
        with_tmp_db(|| {
            save_config(&cfg("11:22", "первый текст")).expect("save 1");
            let mut changed = cfg("99:88", "второй текст");
            changed.sos_recipients = vec!["only@x".into()];
            changed.sos_geo = false;
            save_config(&changed).expect("save 2");
            let read = load_config();
            assert_eq!(read.lock_hash, "99:88");
            assert_eq!(read.sos_text, "второй текст");
            assert_eq!(read.sos_recipients, vec!["only@x".to_string()]);
            assert_eq!(read.sos_geo, false);
        });
    }

    #[test]
    fn absent_config_row_reads_as_disabled_lock() {
        with_tmp_db(|| {
            // Строки нет вовсе: замок выключен, получателей нет, текст пустой.
            assert_eq!(load_config(), DuressConfig::default());
            assert!(!load_config().lock_enabled);
        });
    }

    /// ХАРАКТЕРИСТИЧЕСКИЙ тест (не одобрение!). Сейчас испорченная строка
    /// конфига читается как «замка нет»: `from_str(...).ok().unwrap_or_default()`.
    /// Fail-open на аварийном канале означает, что человек думает, будто замок с
    /// SOS настроен, а приложение стартует открытым и без получателей.
    /// Перевод в fail-closed — РЕШЕНИЕ ВЛАДЕЛЬЦА (что делать, если конфиг не
    /// читается: открыть экран настройки или сохранить прошлый), поэтому здесь
    /// зафиксировано ФАКТИЧЕСКОЕ поведение, а не желаемое.
    #[test]
    fn broken_config_json_currently_fails_open_to_default() {
        with_tmp_db(|| {
            let s = crate::storage::sqlite::Storage::open(None).expect("open");
            s.kv_set("anon", "duress-config", "{ это не json")
                .expect("kv_set");
            assert_eq!(load_config(), DuressConfig::default());
        });
    }

    #[test]
    fn partial_config_json_fills_absent_fields_with_defaults() {
        with_tmp_db(|| {
            let s = crate::storage::sqlite::Storage::open(None).expect("open");
            s.kv_set("anon", "duress-config", r#"{"lock_enabled":true,"lock_hash":"11:22"}"#)
                .expect("kv_set");
            let read = load_config();
            assert!(read.lock_enabled);
            assert_eq!(read.lock_hash, "11:22");
            // Каждый отсутствующий ключ подставляется дефолтом (по `#[serde(default)]`).
            assert_eq!(read.panic_hash, "");
            assert_eq!(read.duress_hash, "");
            assert!(read.sos_recipients.is_empty());
            assert_eq!(read.sos_text, "");
            assert_eq!(read.sos_geo, false);
            assert_eq!(read.bio_enabled, false);
        });
    }

    #[test]
    fn sos_text_drops_the_placeholder_without_coordinates() {
        let c = cfg("11:22", "Телефон не у меня{coords}");
        assert_eq!(compose_sos_text(&c, ""), "Телефон не у меня");
    }

    #[test]
    fn sos_text_puts_coordinates_at_the_placeholder() {
        let c = cfg("11:22", "Телефон не у меня{coords}, помоги");
        assert_eq!(
            compose_sos_text(&c, ": 55.75, 37.61"),
            "Телефон не у меня: 55.75, 37.61, помоги"
        );
    }

    #[test]
    fn sos_text_appends_coordinates_when_flag_is_on_and_placeholder_is_absent() {
        let mut c = cfg("11:22", "Меня заставляют открыть приложение");
        c.sos_geo = true;
        assert_eq!(
            compose_sos_text(&c, "координаты: 55.75, 37.61"),
            "Меня заставляют открыть приложение | координаты: 55.75, 37.61"
        );
    }

    #[test]
    fn sos_text_keeps_the_text_alone_when_geo_flag_is_off() {
        let mut c = cfg("11:22", "Меня заставляют открыть приложение");
        c.sos_geo = false;
        assert_eq!(compose_sos_text(&c, "координаты: 1, 2"), c.sos_text);
    }

    #[test]
    fn sos_text_without_placeholder_and_without_coordinates_stays_untouched() {
        let c = cfg("11:22", "Просто текст");
        assert_eq!(compose_sos_text(&c, ""), "Просто текст");
    }
}
