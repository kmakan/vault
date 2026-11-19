//! Канонический JSON (JCS, RFC 8785) — протокольное решение, поэтому в Rust.
//!
//! Подпись поста считается по канонической форме, а не по «как записали»:
//! перестановка полей, пробелы и порядок ключей не должны ломать проверку.
//! Реализация — `serde_jcs`; JS-сторона обязана использовать ту же форму.

use serde::Serialize;

/// Канонические байты значения для подписи/хэша.
pub fn canonical_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    serde_jcs::to_vec(value).map_err(|e| format!("canonical json failed: {e}"))
}

/// Канонический JSON в виде строки (для отладки и фикстур).
pub fn canonical_string<T: Serialize>(value: &T) -> Result<String, String> {
    let bytes = canonical_bytes(value)?;
    String::from_utf8(bytes).map_err(|e| format!("canonical json is not utf8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_order_does_not_change_canonical_form() {
        let a = json!({ "b": 1, "a": 2 });
        let b = json!({ "a": 2, "b": 1 });
        assert_eq!(canonical_string(&a).unwrap(), canonical_string(&b).unwrap());
    }

    #[test]
    fn whitespace_does_not_change_canonical_form() {
        // Загруженный из разных мест JSON с разными пробелами даёт одну форму.
        let parsed_a: serde_json::Value = serde_json::from_str(r#"{"x": 1, "y": "a"}"#).unwrap();
        let parsed_b: serde_json::Value = serde_json::from_str("{\"y\":\"a\",\"x\":1}").unwrap();
        assert_eq!(canonical_string(&parsed_a).unwrap(), canonical_string(&parsed_b).unwrap());
    }

    #[test]
    fn different_values_give_different_canonical_form() {
        let a = json!({ "a": 1 });
        let b = json!({ "a": 2 });
        assert_ne!(canonical_string(&a).unwrap(), canonical_string(&b).unwrap());
    }

    #[test]
    fn canonical_form_is_compact() {
        let v = json!({ "b": 1, "a": 2 });
        assert_eq!(canonical_string(&v).unwrap(), r#"{"a":2,"b":1}"#);
    }
}
