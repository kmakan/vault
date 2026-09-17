// Регресс: транспорт иногда оборачивает Base64-конверт в quoted-printable
// (`=3D` вместо `=`). is_encrypted() должен распознавать такие тела,
// иначе сообщения тихо отбрасываются как «не зашифрованные».
use std::fs;
use vault_client::crypto::CryptoClient;

#[test]
fn is_encrypted_detects_quoted_printable_body() {
    let body = fs::read_to_string("/tmp/uid230_body.txt")
        .expect("тестовые данные должны быть подготовлены");
    let mut crypto = CryptoClient::new();
    crypto.generate_keypair();
    assert!(
        crypto.is_encrypted(&body),
        "is_encrypted должен распознавать QP-перекодированный конверт"
    );
}
