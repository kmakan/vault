// ── Duress-защита (t_b185e3e2, ТЗ юзера 31.08) ──────────────────────────────
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

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

const DURESS_ITERATIONS: u32 = 10_000;
const SALT_LEN: usize = 16;
const KEY_LEN: usize = 32;

fn pbkdf2_hmac_sha256(secret: &[u8], salt: &[u8], iterations: u32, out: &mut [u8; KEY_LEN]) {
    // PBKDF2-HMAC-SHA256 вручную (без pbkdf2-crate): U1=HMAC(salt||i), Ui=HMAC(prev)...
    type HmacSha256 = Hmac<Sha256>;
    let mut block: [u8; KEY_LEN] = [0; KEY_LEN];
    let mut block_index: u32 = 1;
    let mut filled = 0usize;
    while filled < KEY_LEN {
        let mut mac = HmacSha256::new_from_slice(secret).expect("hmac key");
        mac.update(salt);
        mac.update(&block_index.to_be_bytes());
        let mut u = mac.finalize().into_bytes();
        let mut t = u;
        for _ in 1..iterations {
            let mut mac2 = HmacSha256::new_from_slice(secret).expect("hmac key");
            mac2.update(&u);
            u = mac2.finalize().into_bytes();
            for (tb, ub) in t.iter_mut().zip(u.iter()) {
                *tb ^= ub;
            }
        }
        let take = (KEY_LEN - filled).min(KEY_LEN);
        block[..take].copy_from_slice(&t[..take]);
        out[filled..filled + take].copy_from_slice(&block[..take]);
        filled += take;
        block_index += 1;
    }
}

pub fn hash_secret(secret: &str) -> String {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut out = [0u8; KEY_LEN];
    pbkdf2_hmac_sha256(secret.as_bytes(), &salt, DURESS_ITERATIONS, &mut out);
    let hex_salt: String = salt.iter().map(|b| format!("{b:02x}")).collect();
    let hex_hash: String = out.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex_salt}:{hex_hash}")
}

/// Constant-time сравнение "salt:hash" с введённым секретом.
pub fn verify_secret(secret: &str, stored: &str) -> bool {
    let Some((hex_salt, hex_hash)) = stored.split_once(':') else {
        return false;
    };
    let mut salt = [0u8; SALT_LEN];
    if hex_salt.len() != SALT_LEN * 2 {
        return false;
    }
    for (i, chunk) in hex_salt.as_bytes().chunks(2).enumerate() {
        salt[i] = u8::from_str_radix(std::str::from_utf8(chunk).unwrap_or("00"), 16).unwrap_or(0);
    }
    let mut expected = [0u8; KEY_LEN];
    pbkdf2_hmac_sha256(secret.as_bytes(), &salt, DURESS_ITERATIONS, &mut expected);
    let expected_hex: String = expected.iter().map(|b| format!("{b:02x}")).collect();
    // constant-time
    if expected_hex.len() != hex_hash.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected_hex.bytes().zip(hex_hash.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash_secret("1234");
        assert!(verify_secret("1234", &h));
        assert!(!verify_secret("4321", &h));
        assert!(!verify_secret("1234", "garbage"));
    }

    #[test]
    fn different_salts() {
        assert_ne!(hash_secret("x"), hash_secret("x"));
    }
}

// ── Tauri-команды duress (t_b185e3e2) ───────────────────────────────────────
// Хранение конфига — kv_store('anon', 'duress-config'). Действия по типу ввода
// решает фронт (у него контекст UI); Rust даёт крипту (хэш/проверка) и wipe.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    // Android (0.1.117): дублируем замок в SharedPreferences — Kotlin-замок
    // (LockActivity) читает prefs, а не БД: единый источник конфига для
    // нативного экрана блокировки.
    #[cfg(target_os = "android")]
    {
        let enabled = cfg.lock_enabled && !cfg.lock_hash.is_empty();
        sync_prefs_android(enabled, &cfg.lock_hash, &cfg.duress_hash, &cfg.panic_hash);
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

// ── Android-мост замка (0.1.117): PBKDF2-проверка для LockActivity ─────────
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
pub fn sync_prefs_android(enabled: bool, pin_hash: &str, duress_hash: &str, panic_hash: &str) {
    use jni::objects::JValue;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    let r = catch_unwind(AssertUnwindSafe(|| -> Result<(), String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
            .map_err(|e| format!("vm: {e}"))?;
        let mut env = vm.attach_current_thread().map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let cls = crate::audio::audio_android::find_app_class(
            &mut env,
            &activity,
            "com.vault.vault.VaultForegroundService",
        )
        .map_err(|e| format!("find class: {e}"))?;
        let jenabled = env.new_string(if enabled { "1" } else { "0" }).map_err(|e| e.to_string())?;
        let jhash = env.new_string(pin_hash).map_err(|e| e.to_string())?;
        let jduress = env.new_string(duress_hash).map_err(|e| e.to_string())?;
        let jpanic = env.new_string(panic_hash).map_err(|e| e.to_string())?;
        let call = env.call_static_method(
            &cls,
            "syncLockPrefs",
            "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
            &[(&activity).into(), (&jenabled).into(), (&jhash).into(), (&jduress).into(), (&jpanic).into()],
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


// ── Android: duress/panic из нативного LockActivity (0.1.130) ────────────────

/// Полный вайп при panic-коде: ключи, БД сообщений, конфиг замка (в т.ч. prefs).
#[cfg(target_os = "android")]
#[no_mangle]
pub unsafe extern "C" fn Java_com_vault_vault_VaultForegroundService_00024Companion_nativePanicWipe() {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = crate::groups::delete_all_local();
        match crate::storage::sqlite::Storage::open(None)
            .and_then(|s| s.wipe_user_data())
        {
            Ok(()) => log::info!("[duress] panic wipe: local data wiped"),
            Err(e) => log::error!("[duress] panic wipe failed: {e}"),
        }
        // prefs замка очищаем тоже: после вайпа замок не должен требовать старый PIN.
        let _ = clear_prefs_android();
    }));
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
            log::warn!("[duress] SOS: no recipients configured");
            return Ok(());
        }
        let text = if geo.is_empty() {
            cfg.sos_text.clone()
        } else {
            format!("{} | {}", cfg.sos_text, geo)
        };
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
        let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.map_err(|e| format!("vm: {e}"))?;
        let mut env = vm.attach_current_thread().map_err(|e| format!("attach: {e}"))?;
        let activity = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
        let cls = crate::audio::audio_android::find_app_class(&mut env, &activity, "com.vault.vault.VaultForegroundService")
            .map_err(|e| format!("find class: {e}"))?;
        let call = env.call_static_method(&cls, "clearLockPrefs", "(Landroid/content/Context;)V", &[(&activity).into()]);
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

/// Headless SOS-отправка: plaintext-письмо с маркером [VAULT-SOS] (скорость
/// важнее конфиденциальности — телефон у посторонних). Монитор получателя
/// покажет системное уведомление по маркеру, JS-клиент — как обычное письмо.
#[cfg(target_os = "android")]
pub fn send_sos_headless(recipients: &[String], text: &str) {
    let recipients: Vec<String> = recipients.to_vec();
    let text = text.to_string();
    std::thread::spawn(move || {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::service_monitor::send_sos_mails(&recipients, &text)
        }));
        match r {
            Ok(Ok(())) => log::info!("[duress] SOS sent to {} recipients", recipients.len()),
            Ok(Err(e)) => log::error!("[duress] SOS send failed: {e}"),
            Err(_) => log::error!("[duress] SOS send panicked"),
        }
    });
}
