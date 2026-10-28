// Smoke: форма тела письма — одно правило в ядре (ADR-005, t_7d2c1bb1).
//
// ЗАЧЕМ. Правило «снять переносы, раскодировать QP, вернуть url-safe
// алфавит, восстановить padding» жило в ядре, мосте и JS. Копия в JS уже
// разъезжалась с ядром молча, а после переноса в JS не осталось ни одной
// строки правила: адаптеры зовут команды моста. Этот смоук проверяет
// НАСТОЯЩИЕ команды (не копии) по общей фикстуре
// `vault-client/tests/fixtures/body-decode-contract.json` — той же, что читает
// ядро. Если из команды вернётся локальная копия без QP или padding,
// приглашение в группу перестанет читаться на одной из сторон.
//
// Запуск: cargo test -p vault-desktop --lib body_decode_smoke
#[cfg(test)]
mod body_decode_smoke {
    fn fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../vault-client/tests/fixtures/body-decode-contract.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("фикстура {} недоступна: {e}", path.display()));
        serde_json::from_str(&raw).expect("фикстура — валидный JSON")
    }

    /// Настоящие команды моста, без Tauri-обвязки: State им не нужен.
    fn decode_url_safe(body: &str) -> Result<String, String> {
        crate::vault_decode_url_safe_body(body.to_string())
    }
    fn kid(token: &str) -> Result<String, String> {
        crate::channel_kid_hex(token.to_string())
    }

    #[test]
    fn url_safe_body_contract_matches_shared_fixture() {
        let f = fixture();
        let cases = f["url_safe"].as_array().expect("поле url_safe");
        assert!(!cases.is_empty(), "фикстура без url_safe-кейсов");
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let got = decode_url_safe(c["input"].as_str().unwrap_or(""))
                .unwrap_or_else(|e| panic!("[{name}] команда отказала: {e}"));
            assert_eq!(got, c["text"].as_str().unwrap(), "[{name}] url_safe");
        }
    }

    #[test]
    fn channel_kid_contract_matches_shared_fixture() {
        let f = fixture();
        let cases = f["kid"].as_array().expect("поле kid");
        assert!(!cases.is_empty(), "фикстура без kid-кейсов");
        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let got = kid(c["token"].as_str().unwrap_or(""))
                .unwrap_or_else(|e| panic!("[{name}] команда отказала: {e}"));
            assert_eq!(got, c["kid"].as_str().unwrap(), "[{name}] kid");
        }
    }

    #[test]
    fn junk_body_is_an_error_not_empty_text() {
        // Пустая строка вместо ошибки выглядела бы как «тело разобрано»:
        // приглашение молча потерялось бы, а не попало в лог.
        assert!(decode_url_safe("это не base64 вообще: @@ @@ @@").is_err());
        assert!(kid("").is_err());
        assert!(kid("AQID").is_err(), "токен короче 8 байт — не kid");
    }
}
