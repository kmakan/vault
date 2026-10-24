// Подпись постов канала владельцем (ADR-002) — Ed25519, вся логика в Rust.
//
// ЗАЧЕМ. Канальный токен — bearer-credential, который релей проверить не может:
// он выводится клиентом из broadcast-ключа, а ключа у релея нет
// (docs/design/channels-protocol.md §4.1). И broadcast-ключ ЕСТЬ у подписчика
// (ссылка приглашения содержит `k=`, он нужен ему для дешифрования), поэтому
// подписчик вычисляет write-токен легитимно. Значит разделение «публикует
// только владелец» держится лишь на клиенте. Подпись закрывает эту дыру: у
// подписчика нет приватного ключа владельца.
//
// ЧТО ПОДПИСЫВАЕМ. Не конверт целиком (он шифруется и подписчик всё равно его
// не прочитает), а канонический байтовый поток — иначе клиент и релей разойдутся
// в разборке строк, а это молча ломает всю подпись:
//
//     "channel-post:v2\0" ‖ kid_be_u64 ‖ env_id ‖ body
//
// kid — тот же, что в канальных токенах (первые 8 байт read-MAC), то есть
// адрес очереди: подпись привязана к конкретному каналу и её нельзя перенести
// в другой.
//
// ГДЕ ЖИВЁТ ПРИВАТНЫЙ КЛЮЧ. В ~/.vault/keys/channel_signing.json рядом с
// основной ключевой парой. Сознательно там же, а не в channels.json:
//  • channels.json канала можно перенести/экспортировать, и секрет уехал бы
//    вместе с каналом (владелец шлёт ссылку подписки — это полупубличное
//    место; там секрета быть не должно тем более);
//  • delete_all_keys() (duress-wipe) удаляет ключи поимённо — файл добавлен в
//    список явно, и на это есть тест. Забыть = утёкший ключ после panic-ветки.
//
// ОГРАНИЧЕНИЕ (осознанное, не скрытое). key_store хранит секреты ОТКРЫТЫМ hex —
// так же, как основная ключевая пара. Здесь тот же уровень: файл приватный по
// правам, но не зашифрован. Шифрование key_store — отдельная задача, здесь не
// решается молча, потому что оно меняет формат хранения существующих ключей
// и миграцию.

use anyhow::{anyhow, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

const DOMAIN: &[u8] = b"channel-post:v2\0";

/// Канонический поток для подписи. Единственное место, где он собирается —
/// релей обязан собирать ровно так же (см. ADR-002 §4).
pub fn signing_input(kid: u64, env_id: &str, body: &str) -> Vec<u8> {
    let mut buf = Vec::with_capacity(DOMAIN.len() + 8 + env_id.len() + body.len());
    buf.extend_from_slice(DOMAIN);
    buf.extend_from_slice(&kid.to_be_bytes());
    buf.extend_from_slice(env_id.as_bytes());
    buf.extend_from_slice(body.as_bytes());
    buf
}

/// Подписать конверт. seed/32 — приватный ключ (hex), возвращаем base64url
/// подписи (64 байта) для поля `sig` в PubRequest.
pub fn sign_post(private_key_hex: &str, kid: u64, env_id: &str, body: &str) -> Result<String> {
    let seed = hex_to_32(private_key_hex)?;
    let sk = SigningKey::from_bytes(&seed);
    let sig = sk.sign(&signing_input(kid, env_id, body));
    Ok(b64url(&sig.to_bytes()))
}

/// Публичный ключ из приватного (hex 32 байта) — для регистрации на релее.
pub fn public_key_hex(private_key_hex: &str) -> Result<String> {
    let seed = hex_to_32(private_key_hex)?;
    let sk = SigningKey::from_bytes(&seed);
    Ok(hex::encode(sk.verifying_key().to_bytes()))
}

/// Проверка подписи — тем же кодом, что и на релее, иначе проверка на клиенте
/// ничего не значила бы.
pub fn verify(public_key_hex: &str, sig_b64: &str, kid: u64, env_id: &str, body: &str) -> bool {
    let Ok(pk) = hex::decode(public_key_hex) else {
        return false;
    };
    if pk.len() != 32 {
        return false;
    }
    let Ok(vk) = VerifyingKey::from_bytes(&pk.try_into().expect("32")) else {
        return false;
    };
    let Some(sig_raw) = b64url_decode(sig_b64) else {
        return false;
    };
    if sig_raw.len() != 64 {
        return false;
    }
    let Ok(sig) = Signature::from_slice(&sig_raw) else {
        return false;
    };
    vk.verify_strict(&signing_input(kid, env_id, body), &sig)
        .is_ok()
}

/// Сгенерировать пару: (private_hex, public_hex).
pub fn generate() -> Result<(String, String)> {
    let mut seed = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut seed);
    let sk = SigningKey::from_bytes(&seed);
    Ok((
        hex::encode(seed),
        hex::encode(sk.verifying_key().to_bytes()),
    ))
}

fn hex_to_32(s: &str) -> Result<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("bad channel signing key: expected 64 hex chars"));
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out).map_err(|e| anyhow!("bad channel signing key: {e}"))?;
    Ok(out)
}

fn b64url(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .ok()
}

use rand::RngCore;

#[cfg(test)]
mod tests {
    use super::*;

    // seed = 0x01..0x20 (32 байта) — фиксированный, вектор воспроизводим.
    const SEED_HEX: &str = "0101010101010101010101010101010101010101010101010101010101010101";

    #[test]
    fn sign_then_verify_roundtrip() {
        let (priv_h, pub_h) = public_key_hex(SEED_HEX)
            .map(|p| (SEED_HEX.to_string(), p))
            .unwrap();
        let sig = sign_post(&priv_h, 0x0102030405060708, "env-1", "CIPHER").expect("sign");
        assert!(verify(&pub_h, &sig, 0x0102030405060708, "env-1", "CIPHER"));
    }

    #[test]
    fn signature_is_bound_to_channel_and_payload() {
        let (_, pub_h) = ((), public_key_hex(SEED_HEX).unwrap());
        let kid = 0x1122334455667788u64;
        let sig = sign_post(SEED_HEX, kid, "env-1", "CIPHER").unwrap();
        // другой канал
        assert!(!verify(&pub_h, &sig, kid ^ 1, "env-1", "CIPHER"));
        // другой env_id
        assert!(!verify(&pub_h, &sig, kid, "env-2", "CIPHER"));
        // другое тело (подмена контента)
        assert!(!verify(&pub_h, &sig, kid, "env-1", "ДРУГОЕ"));
    }

    #[test]
    fn rejects_malformed_inputs() {
        let (_, pub_h) = ((), public_key_hex(SEED_HEX).unwrap());
        assert!(!verify(&pub_h, "не-base64", 1, "e", "b"));
        assert!(!verify(&pub_h, "AAAA", 1, "e", "b"), "короткая подпись");
        assert!(!verify(
            "zz",
            &sign_post(SEED_HEX, 1, "e", "b").unwrap(),
            1,
            "e",
            "b"
        ));
        assert!(
            sign_post("abc", 1, "e", "b").is_err(),
            "плохой приватный ключ"
        );
        assert!(
            sign_post(&"z".repeat(64), 1, "e", "b").is_err(),
            "64 символа, но не hex"
        );
    }

    #[test]
    fn domain_separates_signatures_from_other_protocols() {
        // Тот же kid/env/body, но другой доменный префикс — входной поток
        // обязан отличаться, иначе подпись канала была бы переиспользуема
        // в любом другом месте протокола.
        let real = signing_input(1, "e", "b");
        let mut alt = b"other-ctx\0".to_vec();
        alt.extend_from_slice(&1u64.to_be_bytes());
        alt.extend_from_slice(b"e");
        alt.extend_from_slice(b"b");
        assert_ne!(real, alt);
        assert!(real.starts_with(DOMAIN), "домен должен быть префиксом");
    }

    #[test]
    fn generated_keys_are_unique_and_usable() {
        let (p1, pub1) = generate().expect("gen1");
        let (p2, pub2) = generate().expect("gen2");
        assert_ne!(p1, p2, "два ключа подряд не совпадают");
        assert_ne!(pub1, pub2);
        let sig = sign_post(&p1, 7, "e", "b").unwrap();
        assert!(verify(&pub1, &sig, 7, "e", "b"));
        assert!(!verify(&pub2, &sig, 7, "e", "b"), "чужой ключ не подходит");
    }

    /// Вектор для сверки с релеем: клиент и релей должны подписать одно и то же
    /// и получить БАЙТ-в-байт одну строку. Значение пересчитать, если сменится
    /// домен или формат (тогда тест упадёт — и это правильно).
    #[test]
    fn shared_vector_with_relay() {
        let sig = sign_post(SEED_HEX, 0xAABBCCDDEEFF0011, "env-42", "body").expect("sign");
        assert_eq!(sig, "NHE134KLpo62R751EV6odt33b6Y1rdHZOL_d_f8GD3ogFQVQZWVyMSSXm5QJdUqMMJxVxNlvhe_h74dMlv7yAw");
    }
}
