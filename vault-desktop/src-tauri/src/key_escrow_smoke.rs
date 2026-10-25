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

        // 4. "Чистое устройство": разбираем тело письма НАСТОЯЩЕЙ командой.
        // Раньше здесь была копия предиката ("повторяет логику команды") —
        // копия разошлась с оригиналом: в ней не было вырезания CR/LF, без
        // которого письмо не соберётся, потому что при отправке длинное тело
        // рвётся жёсткими переносами. Копия правила = непроверяемое правило.
        let payload = escrow_command(&body).expect("команда не падает");
        assert!(payload.is_some(), "escrow envelope must be recognized");

        // 5. Распаковываем словами (recovery_unwrap_backup)
        let parsed: key_escrow::WrappedBackup =
            serde_json::from_str(&payload.unwrap()).expect("payload — WrappedBackup");
        let backup_json = key_escrow::unwrap_backup(&parsed, &mnemonic).unwrap();

        // 6. Импорт валиден как JSON
        let v: serde_json::Value = serde_json::from_str(&backup_json).unwrap();
        assert_eq!(v["type"], "vault-backup");
    }

    /// Письмо, порванное при отправке (`fold_lines` рвёт длинные строки
    /// жёсткими переносами ВНУТРИ JSON), — всё равно читается.
    #[test]
    fn folded_escrow_letter_is_still_recognized() {
        let mnemonic = key_escrow::generate_mnemonic().unwrap();
        let backup = r#"{"version":1,"type":"vault-backup","keys":{"keypair":{"public_key":"aabb","private_key":"ccdd"},"peer_keys":[]},"kv_store":[]}"#;
        let wrapped = key_escrow::wrap_backup(backup, &mnemonic).unwrap();
        let body = serde_json::to_string(&serde_json::json!({
            "vault": 1,
            "type": "key_escrow",
            "ts": 0,
            "payload": wrapped,
        }))
        .unwrap();
        // Ровно то, что делает отправка: перенос каждые 76 символов.
        let chars: Vec<char> = body.chars().collect();
        let folded = chars
            .chunks(76)
            .map(|c| c.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("\r\n");
        let payload = escrow_command(&folded).unwrap().expect("порванное письмо читается");
        let parsed: key_escrow::WrappedBackup = serde_json::from_str(&payload).unwrap();
        assert_eq!(
            key_escrow::unwrap_backup(&parsed, &mnemonic).unwrap(),
            backup,
            "после сборки письма воедино читается тот же backup"
        );
    }

    /// Чужое письмо не должно быть принято за эскроу: проверка версии и типа
    /// — единственное, что отличает наше письмо от любого другого JSON.
    #[test]
    fn foreign_letters_are_not_escrow() {
        let not_escrow = [
            // другая версия конверта
            r#"{"vault":2,"type":"key_escrow","payload":{}}"#,
            // чужой тип письма, но метка внутри есть (значение другого поля)
            r#"{"vault":1,"type":"profile","payload":{},"note":"key_escrow"}"#,
            // письмо не нашего формата вовсе
            r#"{"vault":1,"type":"message","text":"ждём key_escrow письмо"}"#,
            // вообще не JSON
            "key_escrow",
        ];
        for body in not_escrow {
            assert_eq!(
                escrow_command(body).unwrap(),
                None,
                "`{}` не эскроу-конверт",
                &body[..body.len().min(48)]
            );
        }
    }

    /// Вызов настоящей команды без Tauri-обвязки: команда не просит State.
    fn escrow_command(body: &str) -> Result<Option<String>, String> {
        crate::recovery_parse_escrow_email(body.to_string())
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
