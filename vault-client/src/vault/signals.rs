//! Wire-форматы сервисных сигналов и data-писем — Rust core.
//!
//! ADR-005 R1 (эпик W4, `t_821261f7`): «решение о протоколе и формате — в
//! Rust». Здесь живут форматы, которые раньше разбирались в JS:
//!
//! * **data-письмо (download-on-demand)** — `{vault_dod_data: 1, ref, data}`.
//!   Тело вложения (десятки МБ) едет отдельным письмом; получатель тянет его
//!   по требованию (клик по карточке), а не автоматически.
//! * **сигнал звонка** — живёт в соседнем модуле `call` (`parse_call_signal`),
//!   потому что у него своя модель (`CallSignal`).
//!
//! Почему формат должен быть в ядре, а не в JS: отправитель и получатель
//! разбирают его на двух разных концах протокола. Пока правило было описано в
//! JS, «что считается data-письмом» знал только фронт — а разбор в Rust
//! (`incoming::classify`) о таком письме не знал вовсе и принимал его за
//! обычный конверт.

use serde::Serialize;

/// Разобранное data-письмо (download-on-demand).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DodData {
    /// Ссылка на исходное вложение (Message-ID мета-карточки).
    #[serde(rename = "ref")]
    pub reference: String,
    /// Содержимое вложения (base64).
    pub data: String,
}

/// Разобрать data-письмо. `None` — это не data-письмо.
///
/// Правила (те же, что были в JS):
///   * `vault_dod_data` строго равно 1 (не «truthy»): `0`/`2` — другой формат;
///   * `ref` — строка (пустая, если нет);
///   * `data` — непустая строка (пустое тело — не payload, а мусор: получатель
///     не сможет подставить файл, и карточка вложения останется битой).
pub fn parse_dod_data(plain: &str) -> Option<DodData> {
    if plain.is_empty() {
        return None;
    }
    let obj: serde_json::Value = serde_json::from_str(plain).ok()?;
    if !obj.is_object() {
        return None;
    }
    if obj.get("vault_dod_data").and_then(|v| v.as_i64()) != Some(1) {
        return None;
    }
    let reference = obj
        .get("ref")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let data = obj.get("data").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if data.is_empty() {
        return None;
    }
    Some(DodData { reference, data })
}

/// Собрать data-письмо.
///
/// Порядок полей прежний (`vault_dod_data`, `ref`, `data`) — тело письма
/// шифруется, и побайтовое отличие из-за переезда формата недопустимо.
pub fn build_dod_data(reference: &str, data: &str) -> String {
    #[derive(Serialize)]
    struct Dod<'a> {
        vault_dod_data: u8,
        #[serde(rename = "ref")]
        reference: &'a str,
        data: &'a str,
    }
    let env = Dod {
        vault_dod_data: 1,
        reference,
        data,
    };
    serde_json::to_string(&env).unwrap_or_else(|_| "{}".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_reads_ref_and_data() {
        let plain = r#"{"vault_dod_data":1,"ref":"vault-abc@x","data":"BASE64"}"#;
        let d = parse_dod_data(plain).expect("data-письмо разобрано");
        assert_eq!(d.reference, "vault-abc@x");
        assert_eq!(d.data, "BASE64");
    }

    #[test]
    fn parse_rejects_not_dod() {
        assert!(parse_dod_data("").is_none());
        assert!(parse_dod_data("не json").is_none());
        assert!(parse_dod_data("[]").is_none());
        assert!(
            parse_dod_data(r#"{"ref":"x","data":"y"}"#).is_none(),
            "без метки vault_dod_data — не data-письмо"
        );
        assert!(
            parse_dod_data(r#"{"vault_dod_data":0,"ref":"x","data":"y"}"#).is_none(),
            "метка не равна 1 — другой формат"
        );
        assert!(
            parse_dod_data(r#"{"vault_dod_data":2,"ref":"x","data":"y"}"#).is_none(),
            "метка не равна 1 — другой формат"
        );
    }

    #[test]
    fn parse_rejects_empty_data() {
        // Пустое тело — не payload: получатель подставит пустой файл, и
        // карточка вложения останется битой.
        assert!(parse_dod_data(r#"{"vault_dod_data":1,"ref":"x","data":""}"#).is_none());
        assert!(parse_dod_data(r#"{"vault_dod_data":1,"ref":"x"}"#).is_none());
    }

    #[test]
    fn parse_missing_ref_is_empty() {
        let d = parse_dod_data(r#"{"vault_dod_data":1,"data":"B"}"#).expect("разобрано");
        assert_eq!(d.reference, "", "нет ref — пустая ссылка");
        assert_eq!(d.data, "B");
    }

    #[test]
    fn build_roundtrips_parse() {
        let json = build_dod_data("vault-abc@x", "BASE64");
        let d = parse_dod_data(&json).expect("собранное разбирается обратно");
        assert_eq!(d.reference, "vault-abc@x");
        assert_eq!(d.data, "BASE64");
    }

    #[test]
    fn build_keeps_field_order() {
        let json = build_dod_data("r", "d");
        let i_ref = json.find("\"ref\"").expect("есть ref");
        let i_data = json.find("\"data\"").expect("есть data");
        assert!(i_ref < i_data, "порядок полей прежний: ref, затем data");
        assert!(json.starts_with("{\"vault_dod_data\":1"), "маркер формата первым");
    }
}
