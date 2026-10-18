// Регресс: транспорт иногда оборачивает Base64-конверт в quoted-printable
// (`=3D` вместо `=`). is_encrypted() должен распознавать такие тела,
// иначе сообщения тихо отбрасываются как «не зашифрованные».
//
// Фикстура строится на месте. Раньше тест читал руками подготовленный
// /tmp/uid230_body.txt и падал на любой чистой машине/CI (env-dependent).
use vault_client::crypto::CryptoClient;

#[test]
fn is_encrypted_detects_quoted_printable_body() {
    let mut crypto = CryptoClient::new();
    crypto.generate_keypair();

    // Настоящий конверт (base64, с padding `=`) — как его отдал бы SMTP-транспорт:
    // quoted-printable (`=3D` вместо `=`) + мягкий перевод строки посередине.
    let envelope = crypto.encrypt("qp transport regression body");
    let qp_body = envelope.replace('=', "=3D");
    assert!(
        qp_body.contains("=3D"),
        "фикстура должна содержать QP-escape (=3D)"
    );
    let (head, tail) = qp_body.split_at(qp_body.len() / 2);
    let wrapped = format!("{}\r\n{}", head, tail);

    assert!(
        crypto.is_encrypted(&wrapped),
        "is_encrypted должен распознавать QP-перекодированный конверт"
    );
    // Санити-проверка: сырой конверт тоже распознаётся.
    assert!(crypto.is_encrypted(&envelope));
}
