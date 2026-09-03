// Smoke-test Key Recovery: генерация мнемоники → wrap → parse escrow → unwrap
// Запуск: cargo test --lib escrow_smoke -- --nocapture
#[cfg(test)]
mod escrow_smoke {
    use crate::key_escrow;

    #[test]
    fn full_cycle_like_app() {
        // 1. Пользователь создаёт ключ восстановления
        let mnemonic = key_escrow::generate_mnemonic().unwrap();
        assert!(key_escrow::validate_mnemonic(&mnemonic).is_ok());

        // 2. Оборачиваем "текущий backup" (как recovery_wrap_backup)
        let backup = r#"{"version":1,"type":"vault-backup","keys":{"keypair":{"public_key":"aabb","private_key":"ccdd"},"peer_keys":[]},"kv_store":[]}"#;
        let wrapped = key_escrow::wrap_backup(backup, &mnemonic).unwrap();
        let wrapped_json = serde_json::to_string(&wrapped).unwrap();

        // 3. Формируем эскроу-письмо (как recovery_build_escrow_email)
        let envelope = serde_json::json!({
            "vault": 1,
            "type": "key_escrow",
            "ts": 0,
            "payload": serde_json::from_str::<serde_json::Value>(&wrapped_json).unwrap(),
        });
        let body = serde_json::to_string(&envelope).unwrap();

        // 4. "Чистое устройство": разбираем тело письма (recovery_parse_escrow_email)
        let parsed = key_escrow_parse_for_test(&body);
        assert!(parsed.is_some(), "escrow envelope must be recognized");

        // 5. Распаковываем словами (recovery_unwrap_backup)
        let backup_json = key_escrow::unwrap_backup(&parsed.unwrap(), &mnemonic).unwrap();

        // 6. Импорт валиден как JSON
        let v: serde_json::Value = serde_json::from_str(&backup_json).unwrap();
        assert_eq!(v["type"], "vault-backup");
    }

    // Повторяет логику tauri-команды recovery_parse_escrow_email без State
    fn key_escrow_parse_for_test(body: &str) -> Option<key_escrow::WrappedBackup> {
        let trimmed = body.trim();
        if !trimmed.contains("key_escrow") {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        if v.get("vault").and_then(|x| x.as_i64()) == Some(1)
            && v.get("type").and_then(|x| x.as_str()) == Some("key_escrow")
        {
            let payload = v.get("payload")?;
            return serde_json::from_value(payload.clone()).ok();
        }
        None
    }

    #[test]
    fn wrong_words_rejected() {
        let mnemonic = key_escrow::generate_mnemonic().unwrap();
        let backup = r#"{"k":1}"#;
        let wrapped = key_escrow::wrap_backup(backup, &mnemonic).unwrap();
        let other = key_escrow::generate_mnemonic().unwrap();
        assert!(key_escrow::unwrap_backup(&wrapped, &other).is_err());
    }
}
