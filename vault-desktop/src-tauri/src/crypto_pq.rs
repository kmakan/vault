//! Post-quantum hybrid encryption (ML-KEM-768 + X25519), Vault PQ-V1.
//!
//! Схема (docs/security/POST-QUANTUM-PLAN.md):
//! - Каждый аккаунт: X25519 пара + ML-KEM-768 seed/dekapair.
//! - Ключ диалога: K = HKDF-SHA256(ikm = x25519_ss ‖ mlkem_ss,
//!   salt = "VAULT-PQ-V1", info = ...pubkeys) — гибрид: подделка
//!   ЛЮБОГО из двух обменов не даёт ключа.
//! - Отправитель кладёт в JSON-конверт {pq: <ek_b64>, kemct: <ct_b64>}:
//!   инкапсуляция против PQ-ключа получателя. Получатель декапсулирует
//!   своим seed'ом. Нет PQ-данных — чистый X25519 (legacy-путь).
//! - Seed (64 байта) — приватная сериализация ML-KEM: hex в keypair.json
//!   (pq_private_key), ek (1188 байт) — b64 (pq_public_key). Ciphertext —
//!   1088 байт.

use base64::Engine as _;
use chacha20poly1305::aead::Payload;
use ml_kem::kem::{Decapsulate, Encapsulate, Kem, KeyExport, TryKeyInit};
use ml_kem::ml_kem_768::{
    Ciphertext as KemCt768, DecapsulationKey as Dk768, EncapsulationKey as Ek768,
};
use ml_kem::{MlKem768, Seed};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::crypto::NONCE_LEN;

/// Соль-домен гибридного KDF (версия схемы — при смене формата менять и её).
pub const PQ_SALT: &[u8] = b"VAULT-PQ-V1";

/// Размеры ML-KEM-768 (FIPS 203, wire-сериализация крейта ml-kem 0.3):
/// ek 1184, ct 1088, shared secret 32, seed 64.
/// ВАЖНО: 1188 — это размер pkcs8/«полный» формат; здесь — байтовая
/// кодировка модуля, которую возвращает KeyExport::to_bytes (проверено
/// При апгрейде крейта проверить тестом
/// test_ek_len_wire_format.
pub const PQ_EK_LEN: usize = 1184;
pub const PQ_CT_LEN: usize = 1088;
pub const PQ_SEED_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Сериализация PQ-ключей
// ---------------------------------------------------------------------------

/// PQ-пара: seed (приватный, hex) + ek (публичный, base64). Совместима с
/// StoredKeyPair (serde Option-поля), CLI и QR-обменом.
#[derive(Debug, Clone, PartialEq)]
pub struct PqKeyPair {
    pub seed_hex: String,
    pub ek_b64: String,
}

/// Сгенерировать ML-KEM-768 пару. Seed — каноническая приватная
/// сериализация (64 байта, стабильна между версиями крейта).
pub fn pq_generate() -> PqKeyPair {
    let (dk, ek) = MlKem768::generate_keypair();
    let seed = dk.to_seed().expect("seed-backed keypair");
    PqKeyPair {
        seed_hex: hex::encode(seed.as_slice()),
        ek_b64: base64::engine::general_purpose::STANDARD.encode(ek.to_bytes().as_slice()),
    }
}

/// Восстановить dk/ek из seed (hex). None → битый seed.
pub fn pq_from_seed(seed_hex: &str) -> Option<(Dk768, Ek768)> {
    let seed_bytes = hex::decode(seed_hex).ok()?;
    if seed_bytes.len() != PQ_SEED_LEN {
        return None;
    }
    let arr: [u8; PQ_SEED_LEN] = seed_bytes.try_into().ok()?;
    let seed: Seed = arr.into();
    let dk = Dk768::from_seed(seed);
    let ek = dk.encapsulation_key().clone();
    Some((dk, ek))
}

/// Восстановить ek из base64 (публичный ключ контакта). None → битый ключ.
pub fn pq_ek_from_b64(ek_b64: &str) -> Option<Ek768> {
    let cleaned: String = ek_b64
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let ek_bytes = base64::engine::general_purpose::STANDARD
        .decode(cleaned)
        .ok()?;
    if ek_bytes.len() != PQ_EK_LEN {
        return None;
    }
    Ek768::new_from_slice(&ek_bytes).ok()
}

// ---------------------------------------------------------------------------
// Гибридный вывод ключа
// ---------------------------------------------------------------------------

/// HKDF-SHA256 над конкатенацией X25519- и ML-KEM-общих секретов.
/// info связывает ключ с диалогом (оба X25519-публичных ключа);
/// key-confirmation — через Poly1305 AAD="VAULT".
/// ВАЖНО: info одинаков у обеих сторон (никаких «односторонних»
/// элементов вроде ek получателя — иначе ключи не сойдутся).
pub fn hybrid_key(
    x25519_ss: &[u8; 32],
    mlkem_ss: &[u8; 32],
    my_pub: &[u8; 32],
    peer_pub: &[u8; 32],
) -> [u8; 32] {
    use hkdf::Hkdf;
    use sha2::Sha256;
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(x25519_ss);
    ikm.extend_from_slice(mlkem_ss);
    let mut info = Vec::with_capacity(64);
    info.extend_from_slice(b"VAULT-PQ-V1-hybrid");
    // Канонический порядок: ключи сортируются, чтобы обе стороны получали
    // одинаковый info (порядок my‖peer у отправителя/получателя ПРОТИВОПОЛОЖЕН).
    let (first, second) = if my_pub <= peer_pub {
        (my_pub, peer_pub)
    } else {
        (peer_pub, my_pub)
    };
    info.extend_from_slice(first);
    info.extend_from_slice(second);
    let hk = Hkdf::<Sha256>::new(Some(PQ_SALT), &ikm);
    let mut okm = [0u8; 32];
    hk.expand(&info, &mut okm).expect("32-byte OKM");
    okm
}

// ---------------------------------------------------------------------------
// Медиа-ключ звонков (PQ): тот же гибрид, но ct едет в call-конверте
// ---------------------------------------------------------------------------

/// Звонящий: гибридный медиа-ключ из x25519_ss (DH) + инкапсуляции против
/// ek принимающего. Возвращает (key, kemct_b64, my_ek_b64) — kemct фронт
/// кладёт в call-конверт (sendCallEnvelope), my_ek — чтобы принимающий
/// сохранил контакт.
pub fn media_hybrid_key_out(
    x25519_ss: &[u8; 32],
    my_pq_seed_hex: &str,
    peer_pq_ek_b64: &str,
) -> anyhow::Result<([u8; 32], String, String)> {
    let (dk, my_ek) =
        pq_from_seed(my_pq_seed_hex).ok_or_else(|| anyhow::anyhow!("Invalid ML-KEM seed"))?;
    let my_ek_b64 = base64::engine::general_purpose::STANDARD.encode(my_ek.to_bytes().as_slice());
    let peer_ek =
        pq_ek_from_b64(peer_pq_ek_b64).ok_or_else(|| anyhow::anyhow!("Invalid peer ML-KEM key"))?;
    let (ct, mlkem_ss) = peer_ek.encapsulate();
    let mlkem_arr: [u8; 32] = mlkem_ss.as_slice().try_into().expect("ML-KEM ss 32 bytes");
    let my_pub = my_ek.to_bytes();
    // Медиа-ключ: HKDF с симметричным (сортированным) info; my_pub/peer_pub
    // X25519-ключи у звонка уже связаны AAD-конвертом, поэтому здесь —
    // упрощённый домен (без pub-байтов: их у медиа-пути нет в сигнатуре).
    let key = media_hybrid_kdf(x25519_ss, &mlkem_arr);
    let kemct_b64 = base64::engine::general_purpose::STANDARD.encode(ct.as_slice());
    let _ = dk; // dk нужен только для my_ek-восстановления
    let _ = my_pub;
    Ok((key, kemct_b64, my_ek_b64))
}

/// Принимающий: декапсуляция kemct своим seed → тот же гибридный медиа-ключ.
pub fn media_hybrid_key_in(
    x25519_ss: &[u8; 32],
    my_pq_seed_hex: &str,
    kemct_b64: &str,
) -> anyhow::Result<[u8; 32]> {
    let (dk, _) =
        pq_from_seed(my_pq_seed_hex).ok_or_else(|| anyhow::anyhow!("Invalid ML-KEM seed"))?;
    let cleaned: String = kemct_b64
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let ct_bytes = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .map_err(|e| anyhow::anyhow!("Invalid kemct base64: {e}"))?;
    if ct_bytes.len() != PQ_CT_LEN {
        anyhow::bail!("kemct must be {PQ_CT_LEN} bytes, got {}", ct_bytes.len());
    }
    let ct: KemCt768 = KemCt768::try_from(ct_bytes.as_slice())
        .map_err(|_| anyhow::anyhow!("kemct import failed"))?;
    let mlkem_ss = dk.decapsulate(&ct);
    let mlkem_arr: [u8; 32] = mlkem_ss.as_slice().try_into().expect("ML-KEM ss 32 bytes");
    Ok(media_hybrid_kdf(x25519_ss, &mlkem_arr))
}

/// HKDF-домен медиа-ключа (отдельный от чатового PQ_SALT-info: звонок и
/// чат никогда не делят ключи). Обе стороны вычисляют идентично:
/// ikm = x25519_ss ‖ mlkem_ss, salt = PQ_SALT, info = "VAULT-PQ-V1-media".
fn media_hybrid_kdf(x25519_ss: &[u8; 32], mlkem_ss: &[u8; 32]) -> [u8; 32] {
    use hkdf::Hkdf;
    use sha2::Sha256;
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(x25519_ss);
    ikm.extend_from_slice(mlkem_ss);
    let hk = Hkdf::<Sha256>::new(Some(PQ_SALT), &ikm);
    let mut okm = [0u8; 32];
    hk.expand(b"VAULT-PQ-V1-media", &mut okm)
        .expect("32-byte OKM");
    okm
}

// ---------------------------------------------------------------------------
// Конверт v2 (гибрид) — внутри существующего wire-формата base64(nonce‖ct)
// ---------------------------------------------------------------------------

/// PQ-метаданные JSON-конверта (публичные данные, как поле `key` сейчас):
/// pq — ek отправителя (получатель может сразу ответить гибридом),
/// kemct — инкапсуляция против ek ПОЛУЧАТЕЛЯ.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HybridHeader {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pq: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kemct: Option<String>,
}

/// Зашифровать payload гибридом. Требует: свою X25519-пару, X25519-pub
/// получателя, PQ-ek получателя (обязателен — иначе legacy
/// encrypt_vault_cmd). Свой PQ-seed опционален (для `pq`-поля конверта).
///
/// base64(nonce ‖ ct) с AAD="VAULT", но ключ — гибридный KDF;
/// hybrid_meta — pq/kemct для JSON-конверта.
pub fn hybrid_encrypt_vault(
    plaintext: &str,
    private_key_hex: &str,
    peer_public_key_hex: &str,
    my_pq_seed_hex: Option<&str>,
    peer_pq_ek_b64: &str,
) -> anyhow::Result<(String, HybridHeader)> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};

    // --- X25519 leg ---
    let priv_arr: [u8; 32] = hex::decode(private_key_hex)
        .map_err(|e| anyhow::anyhow!("Invalid private key: {e}"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
    let private = StaticSecret::from(priv_arr);
    let my_pub = PublicKey::from(&private);

    let peer_arr: [u8; 32] = hex::decode(peer_public_key_hex)
        .map_err(|e| anyhow::anyhow!("Invalid peer key: {e}"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Peer key must be 32 bytes"))?;
    let peer_pub = PublicKey::from(peer_arr);

    let x25519_ss = private.diffie_hellman(&peer_pub);

    // --- ML-KEM leg ---
    let peer_ek = pq_ek_from_b64(peer_pq_ek_b64)
        .ok_or_else(|| anyhow::anyhow!("Invalid peer ML-KEM key (bad b64/len)"))?;
    let (ct, mlkem_ss) = peer_ek.encapsulate();

    // --- Hybrid key + encrypt ---
    let mlkem_arr: [u8; 32] = mlkem_ss.as_slice().try_into().expect("ML-KEM ss 32 bytes");
    let key = hybrid_key(
        x25519_ss.as_bytes(),
        &mlkem_arr,
        my_pub.as_bytes(),
        peer_pub.as_bytes(),
    );
    let cipher = XChaCha20Poly1305::new((&key).into());
    let nonce_bytes: [u8; NONCE_LEN] = rand::random();
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_bytes(),
                aad: b"VAULT",
            },
        )
        .map_err(|e| anyhow::anyhow!("Hybrid encryption failed: {e}"))?;

    let mut wire = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    wire.extend_from_slice(&nonce_bytes);
    wire.extend_from_slice(&ciphertext);
    let wire_b64 = base64::engine::general_purpose::STANDARD.encode(&wire);

    // --- PQ-метаданные для JSON-конверта ---
    let my_ek_b64 = my_pq_seed_hex
        .and_then(pq_from_seed)
        .map(|(_, ek)| base64::engine::general_purpose::STANDARD.encode(ek.to_bytes().as_slice()));

    Ok((
        wire_b64,
        HybridHeader {
            pq: my_ek_b64,
            kemct: Some(base64::engine::general_purpose::STANDARD.encode(ct.as_slice())),
        },
    ))
}

/// Расшифровать гибридный конверт. Если у получателя нет PQ-ключа или
/// decrypt_vault_cmd, см. POST-QUANTUM-PLAN «fallback»).
pub fn hybrid_decrypt_vault(
    ciphertext: &str,
    private_key_hex: &str,
    peer_public_key_hex: &str,
    my_pq_seed_hex: &str,
    kemct_b64: &str,
) -> anyhow::Result<String> {
    use chacha20poly1305::aead::{Aead, KeyInit};
    use chacha20poly1305::{XChaCha20Poly1305, XNonce};

    // SMTP-переносы (fold ≤76) — игнорируем whitespace перед base64.
    let cleaned: String = ciphertext.chars().filter(|c| !c.is_whitespace()).collect();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .map_err(|e| anyhow::anyhow!("Invalid base64: {e}"))?;
    if decoded.len() < NONCE_LEN {
        anyhow::bail!("Ciphertext too short");
    }

    let priv_arr: [u8; 32] = hex::decode(private_key_hex)
        .map_err(|e| anyhow::anyhow!("Invalid private key: {e}"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Private key must be 32 bytes"))?;
    let private = StaticSecret::from(priv_arr);
    let my_pub = PublicKey::from(&private);

    let peer_arr: [u8; 32] = hex::decode(peer_public_key_hex)
        .map_err(|e| anyhow::anyhow!("Invalid peer key: {e}"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Peer key must be 32 bytes"))?;
    let peer_pub = PublicKey::from(peer_arr);

    let x25519_ss = private.diffie_hellman(&peer_pub);

    // --- ML-KEM leg: декапсуляция ---
    let (dk, _) =
        pq_from_seed(my_pq_seed_hex).ok_or_else(|| anyhow::anyhow!("Invalid ML-KEM seed"))?;

    let kemct_clean: String = kemct_b64
        .trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let ct_bytes = base64::engine::general_purpose::STANDARD
        .decode(&kemct_clean)
        .map_err(|e| anyhow::anyhow!("Invalid kemct base64: {e}"))?;
    if ct_bytes.len() != PQ_CT_LEN {
        anyhow::bail!("kemct must be {PQ_CT_LEN} bytes, got {}", ct_bytes.len());
    }
    let ct: KemCt768 = KemCt768::try_from(ct_bytes.as_slice())
        .map_err(|_| anyhow::anyhow!("kemct import failed"))?;
    let mlkem_ss = dk.decapsulate(&ct);

    // peer_pq_ek в info неизвестен получателю (это ek получателя, не
    // отправителя) — None: info-связка выполняется my_pub+peer_pub.
    let mlkem_arr: [u8; 32] = mlkem_ss.as_slice().try_into().expect("ML-KEM ss 32 bytes");
    let key = hybrid_key(
        x25519_ss.as_bytes(),
        &mlkem_arr,
        my_pub.as_bytes(),
        peer_pub.as_bytes(),
    );

    let (nonce_bytes, ct_bytes) = decoded.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(nonce_bytes),
            Payload {
                msg: ct_bytes,
                aad: b"VAULT",
            },
        )
        .map_err(|_| anyhow::anyhow!("Not a vault message (AAD auth failed) or wrong key"))?;

    String::from_utf8(plaintext).map_err(|e| anyhow::anyhow!("Invalid UTF-8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::generate_keypair_cmd;

    fn full_setup() -> (
        crate::crypto::KeyPair,
        crate::crypto::KeyPair,
        PqKeyPair,
        PqKeyPair,
    ) {
        let alice = generate_keypair_cmd();
        let bob = generate_keypair_cmd();
        let alice_pq = pq_generate();
        let bob_pq = pq_generate();
        (alice, bob, alice_pq, bob_pq)
    }

    #[test]
    fn test_pq_generate_and_restore() {
        let pq = pq_generate();
        assert_eq!(pq.seed_hex.len(), 128); // 64 байта hex
                                            // Ek восстанавливается из seed и совпадает с ek_b64
        let (_, ek) = pq_from_seed(&pq.seed_hex).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD.encode(ek.to_bytes().as_slice()),
            pq.ek_b64
        );
        // Ek парсится из b64
        assert!(pq_ek_from_b64(&pq.ek_b64).is_some());
        // Мусор отклоняется
        assert!(pq_ek_from_b64("!!!").is_none());
        assert!(pq_ek_from_b64(&"A".repeat(PQ_EK_LEN)).is_none());
    }

    #[test]
    fn test_hybrid_roundtrip() {
        let (alice, bob, alice_pq, bob_pq) = full_setup();

        // Alice шифрует для Bob: его X25519-pub + его PQ-ek
        let (wire, hdr) = hybrid_encrypt_vault(
            "секрет PQ",
            &alice.private_key,
            &bob.public_key,
            Some(&alice_pq.seed_hex),
            &bob_pq.ek_b64,
        )
        .unwrap();
        assert!(hdr.kemct.is_some());
        assert!(hdr.pq.is_some());

        // Bob расшифровывает: свой priv + PQ-seed, публичный ключ Alice, kemct
        let kemct = hdr.kemct.clone().unwrap();
        let pt = hybrid_decrypt_vault(
            &wire,
            &bob.private_key,
            &alice.public_key,
            &bob_pq.seed_hex,
            &kemct,
        )
        .unwrap();
        assert_eq!(pt, "секрет PQ");
    }

    #[test]
    fn test_hybrid_without_sender_pq_key() {
        // У Alice нет PQ-ключа (миграция) — pq=None в конверте, но шифрование
        // против PQ-ключа Bob'а всё равно гибридное.
        let (alice, bob, _, bob_pq) = full_setup();
        let (wire, hdr) = hybrid_encrypt_vault(
            "гибрид без pq-отправителя",
            &alice.private_key,
            &bob.public_key,
            None,
            &bob_pq.ek_b64,
        )
        .unwrap();
        assert!(hdr.pq.is_none());
        let kemct = hdr.kemct.unwrap();
        let pt = hybrid_decrypt_vault(
            &wire,
            &bob.private_key,
            &alice.public_key,
            &bob_pq.seed_hex,
            &kemct,
        )
        .unwrap();
        assert_eq!(pt, "гибрид без pq-отправителя");
    }

    #[test]
    fn test_hybrid_rejects_wrong_kemct() {
        let (alice, bob, _, bob_pq) = full_setup();
        let (wire, _) = hybrid_encrypt_vault(
            "x",
            &alice.private_key,
            &bob.public_key,
            None,
            &bob_pq.ek_b64,
        )
        .unwrap();
        // Подменённый kemct (валидный base64, чужая инкапсуляция)
        let other_pq = pq_generate();
        let other_ek = pq_ek_from_b64(&other_pq.ek_b64).unwrap();
        let (other_ct, _) = other_ek.encapsulate();
        let fake_kemct = base64::engine::general_purpose::STANDARD.encode(other_ct.as_slice());
        let res = hybrid_decrypt_vault(
            &wire,
            &bob.private_key,
            &alice.public_key,
            &bob_pq.seed_hex,
            &fake_kemct,
        );
        assert!(res.is_err(), "wrong kemct must fail AAD auth");
    }

    #[test]
    fn test_hybrid_rejects_wrong_x25519() {
        let (alice, bob, alice_pq, bob_pq) = full_setup();
        let eve = generate_keypair_cmd();
        let (wire, hdr) = hybrid_encrypt_vault(
            "x",
            &alice.private_key,
            &bob.public_key,
            Some(&alice_pq.seed_hex),
            &bob_pq.ek_b64,
        )
        .unwrap();
        let kemct = hdr.kemct.unwrap();
        // Eve подделала X25519-партнёра
        let res = hybrid_decrypt_vault(
            &wire,
            &bob.private_key,
            &eve.public_key,
            &bob_pq.seed_hex,
            &kemct,
        );
        assert!(res.is_err(), "wrong x25519 peer must fail");
    }

    #[test]
    fn test_hybrid_key_determinism() {
        // Одинаковые входы → одинаковый ключ; любой изменённый leg → другой.
        let k1 = hybrid_key(&[1u8; 32], &[2u8; 32], &[3u8; 32], &[4u8; 32]);
        let k2 = hybrid_key(&[1u8; 32], &[2u8; 32], &[3u8; 32], &[4u8; 32]);
        assert_eq!(k1, k2);
        let k3 = hybrid_key(&[9u8; 32], &[2u8; 32], &[3u8; 32], &[4u8; 32]);
        assert_ne!(k1, k3);
        let k4 = hybrid_key(&[1u8; 32], &[9u8; 32], &[3u8; 32], &[4u8; 32]);
        assert_ne!(k1, k4);
    }

    #[test]
    fn test_hybrid_rejects_legacy_ciphertext() {
        // Гибридный decrypt на legacy-письме (без kemct вообще) — Err →
        let (alice, bob, _, bob_pq) = full_setup();
        let legacy =
            crate::crypto::encrypt_vault_cmd("legacy", &alice.private_key, Some(&bob.public_key))
                .unwrap();
        let res = hybrid_decrypt_vault(
            &legacy,
            &bob.private_key,
            &alice.public_key,
            &bob_pq.seed_hex,
            "AAAA",
        );
        assert!(res.is_err());
    }

    #[test]
    fn test_media_hybrid_key_symmetry() {
        // Звонящий и принимающий получают ОДИН медиа-ключ:
        // out = HKDF(x25519_ss ‖ encapsulate()), in = HKDF(x25519_ss ‖ decapsulate()).
        let caller_pq = pq_generate();
        let callee_pq = pq_generate();
        let x_ss = [0x42u8; 32];

        let (key_out, kemct, my_ek) =
            media_hybrid_key_out(&x_ss, &caller_pq.seed_hex, &callee_pq.ek_b64).unwrap();
        let key_in = media_hybrid_key_in(&x_ss, &callee_pq.seed_hex, &kemct).unwrap();
        assert_eq!(key_out, key_in, "media keys must match");
        // ek звонящего корректен (принимающий сохранит контакт)
        assert!(pq_ek_from_b64(&my_ek).is_some());
        // Подменённый kemct → другой ключ (не равен)
        let other = pq_generate();
        let (_, fake_ct, _) =
            media_hybrid_key_out(&x_ss, &other.seed_hex, &callee_pq.ek_b64).unwrap();
        let fake_in = media_hybrid_key_in(&x_ss, &callee_pq.seed_hex, &fake_ct).unwrap();
        assert_ne!(key_out, fake_in);
    }

    #[test]
    fn test_kemct_size_on_wire() {
        let (alice, bob, _, bob_pq) = full_setup();
        let (_, hdr) = hybrid_encrypt_vault(
            "x",
            &alice.private_key,
            &bob.public_key,
            None,
            &bob_pq.ek_b64,
        )
        .unwrap();
        let ct_bytes = base64::engine::general_purpose::STANDARD
            .decode(hdr.kemct.unwrap())
            .unwrap();
        assert_eq!(ct_bytes.len(), PQ_CT_LEN);
    }
}
