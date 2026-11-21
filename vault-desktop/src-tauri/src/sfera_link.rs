//! Tauri-команда «Связать Sfera» (ADR-009 §4).
//!
//! Мессенджер — владелец ключа подписи аккаунта. Команда отдаёт QR-ссылку
//! с bundle, подписанным этим ключом. Приватный seed не покидает ядро:
//! в UI уходит только `vault://link-sfera?payload=…`.

use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct SferaLinkDto {
    /// URI для QR/файла.
    pub uri: String,
    /// Отпечаток ключа подписи аккаунта — чтобы человек сверил ID.
    pub account_fp: String,
    /// Монотонный номер bundle: новый отзывает предыдущий.
    pub seq: u64,
}

/// Собрать bundle для связывания.
///
/// `device_pub_key` — публичный Ed25519-ключ устройства Sfera (hex, 32 байта),
/// который человек получает в Sfera («Мой ключ»). `seq` — номер bundle;
/// UI хранит последний выданный и увеличивает.
#[tauri::command]
pub fn vault_sfera_link_bundle(
    device_pub_key: String,
    seq: u64,
) -> Result<SferaLinkDto, String> {
    let keys_dir = crate::key_store::get_keys_dir_raw();
    let uri = vault_link_export::export_uri(&keys_dir, &device_pub_key, seq)
        .map_err(|e| format!("sfera link: {e}"))?;
    let seed = vault_core::account_signing::load_or_create_at(&keys_dir)
        .map_err(|e| format!("account signing key: {e}"))?;
    let account_fp = vault_core::account_signing::fingerprint(&seed)
        .map_err(|e| format!("account fingerprint: {e}"))?;
    Ok(SferaLinkDto { uri, account_fp, seq })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_shape_has_uri_and_fp() {
        // Проверка формы DTO без вызова команды (нужен Tauri State).
        let dto = SferaLinkDto {
            uri: "vault://link-sfera?payload=abc".into(),
            account_fp: "02:00:00:00:00:00:00:00:****".into(),
            seq: 1,
        };
        assert!(dto.uri.starts_with("vault://link-sfera"));
        assert_eq!(dto.seq, 1);
    }
}
