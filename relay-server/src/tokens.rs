//! Stateless HMAC-токены подписки (design §4).
//!
//! token = base64url( key_id(8) ‖ scope(1) ‖ expiry(4) ‖ mac(32) )
//! mac = HMAC-SHA256(server_key, key_id ‖ scope ‖ expiry)
//! Выдача — CLI (bin/gen_token.rs), валидация — без БД.
//! В самом токене нет email: сервер знает только opaque-строку.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    Read,
    Write,
    /// Канал (M2 channels): read-токен канала = адрес общей очереди
    /// подписчиков (fan-out на poll). Детерминирован из channel_id.
    ChannelRead,
    /// write-токен канала = право publish в его очередь, отдельный
    /// идентификатор для pub-лимитов канала (design channels §4.1/§6).
    ChannelWrite,
}

impl Scope {
    fn to_byte(self) -> u8 {
        match self {
            Scope::Read => b'r',
            Scope::Write => b'w',
            Scope::ChannelRead => b'c',
            Scope::ChannelWrite => b'C',
        }
    }
    fn from_byte(b: u8) -> Option<Self> {
        match b {
            b'r' => Some(Scope::Read),
            b'w' => Some(Scope::Write),
            b'c' => Some(Scope::ChannelRead),
            b'C' => Some(Scope::ChannelWrite),
            _ => None,
        }
    }
    /// Канальные scope'ы (read или write) — токен привязан к channel_id.
    pub fn is_channel(self) -> bool {
        matches!(self, Scope::ChannelRead | Scope::ChannelWrite)
    }
}

/// Ротация server_key без инвалидации старых токенов:
/// key_id выбирает активный ключ из набора (MVP: один).
pub struct ServerKeys {
    keys: Vec<(u64, [u8; 32])>,
}

impl ServerKeys {
    pub fn new(key: [u8; 32]) -> Self {
        // key_id — первые 8 байт самого ключа (детерминированно для MVP).
        let kid = u64::from_be_bytes(key[..8].try_into().expect("8 bytes"));
        Self { keys: vec![(kid, key)] }
    }

    fn mac(&self, key_id: u64, scope: Scope, expiry: u32) -> Option<[u8; 32]> {
        for (kid, key) in &self.keys {
            if *kid == key_id {
                let mut mac = HmacSha256::new_from_slice(key).ok()?;
                mac.update(&key_id.to_be_bytes());
                mac.update(&[scope.to_byte()]);
                mac.update(&expiry.to_be_bytes());
                let out = mac.finalize().into_bytes();
                let mut tag = [0u8; 32];
                tag.copy_from_slice(&out);
                return Some(tag);
            }
        }
        None
    }
}

#[derive(Clone, Debug)]
pub struct Token {
    pub scope: Scope,
    pub expiry: u32,
    /// hash очереди получателя = mac токена (read-токен адресует очередь).
    pub hash: String,
    /// Личные токены: id серверного ключа. Канальные: read несёт
    /// первые 8 байт своего mac, write — те же байты mac'а read-токена
    /// (привязка: publish в очередь канала возможен только write-токеном
    /// этого канала; подделка = знать broadcast-ключ).
    pub key_id: u64,
}

impl Token {
    pub fn is_expired(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as u32)
            .unwrap_or(0);
        self.expiry < now
    }
    /// Привязан ли этот write-токен канала к данной очереди канала.
    pub fn channel_matches(&self, read_tok: &Token) -> bool {
        self.scope == Scope::ChannelWrite && read_tok.scope == Scope::ChannelRead
            && self.key_id == read_tok.key_id
    }
}

/// Собрать токен (для CLI-генератора и тестов).
pub fn issue(keys: &ServerKeys, scope: Scope, expiry: u32) -> String {
    let key_id = keys.keys[0].0;
    let mac = keys.mac(key_id, scope, expiry).expect("key present");
    let mut raw = Vec::with_capacity(45);
    raw.extend_from_slice(&key_id.to_be_bytes());
    raw.push(scope.to_byte());
    raw.extend_from_slice(&expiry.to_be_bytes());
    raw.extend_from_slice(&mac);
    b64url(&raw)
}

/// Разобрать и проверить токен. None = битый/поддельный/неизвестный key_id.
///
/// Канальные scope'ы ('c'/'C') — capability-токены: выводятся из
/// broadcast-ключа канала (clients-derive, design channels §4.1), сервер
/// их НЕ верифицирует server_key-MAC'ом: владение значением = авторизация
/// (256-битная способность, подбор невозможен). Структурная проверка:
/// длина + sentinel-expiry (u32::MAX — канал живёт, пока жив broadcast-ключ;
/// ротация ключа = новые токены через migration-механику §3.3).
pub fn parse(keys: &ServerKeys, token: &str) -> Option<Token> {
    let raw = b64url_decode(token)?;
    if raw.len() != 8 + 1 + 4 + 32 {
        return None;
    }
    let scope = Scope::from_byte(raw[8])?;
    let expiry = u32::from_be_bytes(raw[9..13].try_into().expect("4"));
    if scope.is_channel() {
        if expiry != u32::MAX {
            return None;
        }
        // hash очереди = hex(mac-поля), та же адресация, что у личных.
        // key_id у канала — link-связка: read несёт свои первые 8 байт mac,
        // write — первые 8 байт mac-а read (publish принимается только
        // write-токеном, чей key_id == key_id очереди).
        let key_id = u64::from_be_bytes(raw[..8].try_into().expect("8"));
        return Some(Token {
            scope,
            expiry,
            hash: hex(&raw[13..45]),
            key_id,
        });
    }
    let key_id = u64::from_be_bytes(raw[..8].try_into().expect("8"));
    let tag = &raw[13..45];
    let mac = keys.mac(key_id, scope, expiry)?;
    // constant-time compare
    if !ct_eq(tag, &mac) {
        return None;
    }
    // Очередь адресуем mac-хэшем: коллизии = подделка MAC (2^128).
    Some(Token {
        scope,
        expiry,
        hash: hex(&mac),
        key_id,
    })
}

/// Вывести канальную пару токенов из broadcast-ключа (32B, тот что в QR).
/// (read, write): read — адрес общей очереди подписчиков (poll у всех дают
/// одни и те же посты), write — право publish в неё. Детерминированно:
/// владелец и каждый подписчик вычисляют пару независимо, сервера-выдачи
/// нет. Layout: kid(8) ‖ scope(1) ‖ 0xFFFFFFFF ‖ mac(32),
/// mac = HMAC-SHA256(broadcast_key, "vault-relay-channel-{read,write}").
/// kid write-токена = первые 8 байт mac read-токена (привязка к очереди).
pub fn channel_tokens(broadcast_key: &[u8; 32]) -> (String, String) {
    let mac_of = |label: &[u8]| -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(broadcast_key).expect("32B key");
        mac.update(label);
        mac.finalize().into_bytes().into()
    };
    let read_mac = mac_of(b"vault-relay-channel-read");
    let write_mac = mac_of(b"vault-relay-channel-write");
    let pack = |kid: u64, byte: u8, mac: &[u8; 32]| -> String {
        let mut raw = Vec::with_capacity(45);
        raw.extend_from_slice(&kid.to_be_bytes());
        raw.push(byte);
        raw.extend_from_slice(&u32::MAX.to_be_bytes());
        raw.extend_from_slice(mac);
        b64url(&raw)
    };
    let read_kid = u64::from_be_bytes(read_mac[..8].try_into().expect("8"));
    (
        pack(read_kid, Scope::ChannelRead.to_byte(), &read_mac),
        pack(read_kid, Scope::ChannelWrite.to_byte(), &write_mac),
    )
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}

fn b64url(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys() -> ServerKeys {
        ServerKeys::new([42u8; 32])
    }

    #[test]
    fn roundtrip_read() {
        let k = keys();
        let t = issue(&k, Scope::Read, 4102444800); // 2100 год
        let parsed = parse(&k, &t).expect("parse");
        assert_eq!(parsed.scope, Scope::Read);
        assert!(!parsed.is_expired());
        assert_eq!(parsed.hash.len(), 64);
    }

    #[test]
    fn tampered_rejected() {
        let k = keys();
        let mut t = issue(&k, Scope::Read, 4102444800);
        // перевернём один символ
        let flip = if t.starts_with('A') { 'B' } else { 'A' };
        t.replace_range(0..1, &flip.to_string());
        assert!(parse(&k, &t).is_none());
    }

    #[test]
    fn wrong_scope_rejected() {
        let k = keys();
        let t = issue(&k, Scope::Write, 4102444800);
        let parsed = parse(&k, &t).expect("parse");
        assert_eq!(parsed.scope, Scope::Write);
    }

    #[test]
    fn expiry_works() {
        let k = keys();
        let t = issue(&k, Scope::Read, 1); // 1970
        let parsed = parse(&k, &t).expect("parse");
        assert!(parsed.is_expired());
    }

    #[test]
    fn channel_tokens_roundtrip() {
        let k = keys();
        let key = [7u8; 32];
        let (rd, wr) = issue_channel_pair(&k, &key);
        let p_rd = parse(&k, &rd).expect("channel read parses");
        assert_eq!(p_rd.scope, Scope::ChannelRead);
        assert!(!p_rd.is_expired());
        let p_wr = parse(&k, &wr).expect("channel write parses");
        assert_eq!(p_wr.scope, Scope::ChannelWrite);
        assert_eq!(p_rd.hash.len(), 64);
        assert_ne!(p_rd.hash, p_wr.hash);
    }

    #[test]
    fn channel_tokens_derived_only_from_broadcast_key() {
        // Серверные ключи не участвуют: две разные ServerKeys дают те же токены.
        let a = ServerKeys::new([1u8; 32]);
        let b = ServerKeys::new([2u8; 32]);
        let key = [9u8; 32];
        assert_eq!(issue_channel_pair(&a, &key), issue_channel_pair(&b, &key));
    }

    #[test]
    fn channel_tokens_cross_scope_not_confusable() {
        let k = keys();
        let (rd, _) = issue_channel_pair(&k, &[7u8; 32]);
        let p = parse(&k, &rd).expect("parses");
        assert_eq!(p.scope, Scope::ChannelRead);
        // подмена scope-байта ломает канал (hash меняется, mac не проверяем) —
        // канал-токены проверяются структурой, не MAC; своп read↔write =
        // другой hash = другая очередь, publish не попадёт в подписчиков.
        use base64::Engine;
        let mut raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&rd).unwrap();
        raw[8] = b'w'; // канал → личный write: MAC-валидация не пройдёт
        let forged = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&raw);
        assert!(parse(&k, &forged).is_none());
    }

    #[test]
    fn channel_read_token_accepted_where_read_expected() {
        // Подписчик poll'ит с read-токеном канала; сервер принимает его там,
        // где ожидает личный Read (общая очередь), но НЕ как write.
        let k = keys();
        let (rd, _) = issue_channel_pair(&k, &[3u8; 32]);
        let p = parse(&k, &rd).unwrap();
        assert_eq!(p.scope, Scope::ChannelRead);
        assert_ne!(p.scope, Scope::Write);
    }

    #[test]
    fn channel_write_token_bound_to_its_queue() {
        let k = keys();
        let (rd, wr) = issue_channel_pair(&k, &[5u8; 32]);
        let p_rd = parse(&k, &rd).unwrap();
        let p_wr = parse(&k, &wr).unwrap();
        assert!(p_wr.channel_matches(&p_rd));
        // Чужой канал не матчится: write-токен канала B не публикует в A.
        let (rd_b, _) = issue_channel_pair(&k, &[6u8; 32]);
        let p_rd_b = parse(&k, &rd_b).unwrap();
        assert!(!p_wr.channel_matches(&p_rd_b));
        // канал ≠ 2 разных broadcast-ключа → kid'ы разные (2^-64 коллизии)
        assert_ne!(p_rd.key_id, p_rd_b.key_id);
    }

    #[test]
    fn channel_tokens_golden_vectors() {
        // Cross-implementation contract (Rust relay-server ↔ Python smoke ↔
        // JS WebCrypto client): for broadcast key 0x00..0x1f the derived pair
        // MUST be byte-identical everywhere. Any layout change breaks this.
        let key: [u8; 32] = std::array::from_fn(|i| i as u8);
        let (rd, wr) = channel_tokens(&key);
        assert_eq!(rd, "SV_HjXPp5iRj_____0lfx41z6eYkxBwsz_yjudMQsR5y1y_gjWtvThUEHsVi");
        assert_eq!(wr, "SV_HjXPp5iRD_____wggA7nRt299pz5hlBU0WewQCsWWD7JgIIcmkz8csufh");
    }

    fn issue_channel_pair(_keys: &ServerKeys, key: &[u8; 32]) -> (String, String) {
        channel_tokens(key)
    }
}
