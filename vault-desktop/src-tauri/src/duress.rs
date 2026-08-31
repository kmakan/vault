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
    .map_err(|e| e.to_string())
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
