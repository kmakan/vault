//! Параметры PBKDF2 замка и duress/panic-кодов (ADR-005 §W4, `t_502b6c90`).
//!
//! Зачем в ядре: итерации и формат `salt:hash` — протокол, а не деталь
//! экрана. Ошибка в итерациях делает ранее сохранённый хэш невалидным:
//! пользователь вводит верный код, а замок не открывается или аварийное
//! стирание не срабатывает — тихо, без ошибки. Поэтому параметры, вывод и
//! проверка живут в одном месте, покрыты тестами и мутационным набором, а
//! мост только читает/пишет конфиг и зовёт эти функции.
//!
//! Форма сохранённого значения — часть протокола: её читает и Kotlin-замок
//! (`LockActivity` → JNI → `verify_secret`), и JS-замок через мост.

use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::Serialize;
use sha2::Sha256;

/// Итерации PBKDF2. Меняется ТОЛЬКО вместе с миграцией сохранённых хэшей:
/// иначе все существующие PIN-ы перестанут проверяться.
pub const ITERATIONS: u32 = 10_000;
/// Длина соли в байтах.
pub const SALT_LEN: usize = 16;
/// Длина производного ключа в байтах.
pub const KEY_LEN: usize = 32;

fn pbkdf2_hmac_sha256(secret: &[u8], salt: &[u8], iterations: u32, out: &mut [u8; KEY_LEN]) {
    // PBKDF2-HMAC-SHA256 вручную (без pbkdf2-crate): U1=HMAC(salt||i), Ui=HMAC(prev)...
    type HmacSha256 = Hmac<Sha256>;
    let mut block: [u8; KEY_LEN] = [0; KEY_LEN];
    let mut block_index: u32 = 1;
    let mut filled = 0usize;
    while filled < KEY_LEN {
        let mut mac = HmacSha256::new_from_slice(secret).expect("hmac key");
        mac.update(salt);
        mac.update(&block_index.to_be_bytes());
        let mut u = mac.finalize().into_bytes();
        let mut t = u;
        for _ in 1..iterations {
            let mut mac2 = HmacSha256::new_from_slice(secret).expect("hmac key");
            mac2.update(&u);
            u = mac2.finalize().into_bytes();
            for (tb, ub) in t.iter_mut().zip(u.iter()) {
                *tb ^= ub;
            }
        }
        let take = (KEY_LEN - filled).min(KEY_LEN);
        block[..take].copy_from_slice(&t[..take]);
        out[filled..filled + take].copy_from_slice(&block[..take]);
        filled += take;
        block_index += 1;
    }
}

/// Новый хэш секрета: `salt:hash` в hex. Соль случайная, поэтому два хэша
/// одного PIN-а различаются (проверяется тестом).
pub fn hash_secret(secret: &str) -> String {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut out = [0u8; KEY_LEN];
    pbkdf2_hmac_sha256(secret.as_bytes(), &salt, ITERATIONS, &mut out);
    let hex_salt: String = salt.iter().map(|b| format!("{b:02x}")).collect();
    let hex_hash: String = out.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex_salt}:{hex_hash}")
}

/// Constant-time сравнение сохранённого `salt:hash` с введённым секретом.
///
/// Разбор строгий: неверная длина или не-hex — это `false`, а не
/// «декодировали в нули и, может быть, совпало».
pub fn verify_secret(secret: &str, stored: &str) -> bool {
    let Some((hex_salt, hex_hash)) = stored.split_once(':') else {
        return false;
    };
    let Ok(salt) = hex::decode(hex_salt) else {
        return false;
    };
    if salt.len() != SALT_LEN {
        return false;
    }
    let Ok(expected_stored) = hex::decode(hex_hash) else {
        return false;
    };
    if expected_stored.len() != KEY_LEN {
        return false;
    }
    let mut expected = [0u8; KEY_LEN];
    pbkdf2_hmac_sha256(secret.as_bytes(), &salt, ITERATIONS, &mut expected);
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(expected_stored.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Конверт duress-SOS: `{vault:1, id:"{ts}sos", type:"sos", text, ts}`.
///
/// Правило формата переехало из `service_monitor.rs` (headless-отправка): там
/// оно компилировалось только под `cfg(target_os = "android")` и не измерялось
/// с хоста ничем. Ошибиться в метке `type` — получить письмо, которое
/// получатель покажет как обычное сообщение, а не как сигнал беды; узнать об
/// этом можно только тогда, когда помощи не дождались.
///
/// Процесс с activity (JS `sendDuressSos`) собирает SOS полным
/// сообщенийным конвертом (`envelope::build` с `type:"sos"`) — с именем и
/// ключом отправителя. Headless-конверт остаётся минимальным: смена его
/// байтовой формы — это изменение протокола на живой аварии, оно требует
/// приёмки на устройстве, а не «улучшения по дороге».
pub fn build_sos_envelope(text: &str, ts_ms: i64) -> String {
    #[derive(Serialize)]
    struct Sos<'a> {
        vault: u8,
        id: String,
        #[serde(rename = "type")]
        msg_type: &'a str,
        text: &'a str,
        ts: i64,
    }
    let env = Sos {
        vault: 1,
        id: format!("{ts_ms}sos"),
        msg_type: "sos",
        text,
        ts: ts_ms,
    };
    serde_json::to_string(&env).unwrap_or_else(|_| "{}".to_string())
}

/// Правило текста SOS-письма — ОДНА копия на оба канала (ADR-005 W4, #38).
///
/// ЗАЧЕМ в ядре. До 27.10 копий было две: правило жила в мосте для headless
/// (JNI) и ещё раз — во фронте (`features/duress.js`), и копии разошлись по
/// трём вопросам: подставлять ли дефолтный текст, когда настройки пусты,
/// сколько плейсхолдеров заменять и чем разделять хвост. Правильный ответ на
/// «что именно прочитает тот, кому я signal беду» не может зависеть от того,
/// каким каналом письмо ушло.
///
/// Данные канала при этом остаются данными: `default_text` приходит из локали
/// фронта (headless локали не имеет — там пустая строка сознательна: «настройку
/// не меняли» — это не «письмо без текста»), `geo` — уже отформатированная
/// фраза, `separator` — как эта фраза склеивается с текстом.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SosText<'a> {
    /// Настроенный человеком текст (`sos_text` конфига замка).
    pub text: &'a str,
    /// Чем заменить пустую настройку.
    pub default_text: &'a str,
    /// Включена ли передача координат.
    pub geo_on: bool,
    /// Фраза координат; пустая — если их нет.
    pub geo: &'a str,
    /// Разделитель хвоста, когда плейсхолдера в тексте нет.
    pub separator: &'a str,
}

/// Собрать текст по правилу. Порядок веток — часть смысла: координат нет →
/// плейсхолдер снимается (в письме не должно оставаться служебной метки);
/// плейсхолдер есть → подставляется ВСЕ вхождения (текст с двумя окнами
/// координат правдоподобен: «{coords}, а дом — {coords}»); плейсхолдера нет,
/// но гео включено и координаты есть → хвост.
pub fn compose_sos_text(rule: &SosText) -> String {
    let base = if rule.text.trim().is_empty() {
        rule.default_text
    } else {
        rule.text
    };
    if rule.geo.is_empty() {
        return base.replace("{coords}", "");
    }
    if base.contains("{coords}") {
        return base.replace("{coords}", rule.geo);
    }
    if rule.geo_on {
        return format!("{base}{}{}", rule.separator, rule.geo);
    }
    base.to_string()
}

/// Фраза координат для текста SOS. Числа формует ядро (это содержимое письма,
/// и дрейф разрядов увидит получатель), а подпись берётся из локали: магазины
/// требуют, чтобы письмо говорило на языке отправителя, а не на одном заранее.
/// Пустая подпись — голые числа после запятой.
pub fn geo_phrase(label: &str, lat: f64, lon: f64) -> String {
    let label = label.trim();
    if label.is_empty() {
        return format!(", {lat:.5}, {lon:.5}");
    }
    format!(", {label}: {lat:.5}, {lon:.5}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash_secret("1234");
        assert!(verify_secret("1234", &h));
        assert!(!verify_secret("4321", &h));
        assert!(!verify_secret("1234", "garbage"));
    }

    #[test]
    fn different_salts() {
        assert_ne!(hash_secret("x"), hash_secret("x"));
    }

    /// Параметры — контракт с уже сохранёнными хэшами. Этот тест падает
    /// первым, если кто-то «оптимизирует» итерации: иначе round-trip внутри
    /// новой версии остался бы зелёным, а старые PIN-ы перестали бы работать.
    #[test]
    fn parameters_match_protocol() {
        assert_eq!(ITERATIONS, 10_000);
        assert_eq!(SALT_LEN, 16);
        assert_eq!(KEY_LEN, 32);
    }

    /// KAT с фиксированной солью. Ловит дрейф алгоритма (порядок XOR, длина
    /// выхода, итерации), который round-trip внутри новой версии не видит:
    /// старые `salt:hash` перестали бы проверяться, а `hash_secret`+
    /// `verify_secret` остались бы согласованы сами с собой.
    #[test]
    fn pbkdf2_matches_known_vector() {
        let salt: [u8; SALT_LEN] = core::array::from_fn(|i| i as u8);
        let mut out = [0u8; KEY_LEN];
        pbkdf2_hmac_sha256(b"1234", &salt, ITERATIONS, &mut out);
        assert_eq!(
            hex::encode(out),
            "91ea059bae0333a2969fc8ccd7c77851dda43f5adb96baeea246a624cdf489ec"
        );
    }

    /// Конверт SOS (26.10): сборка переехала из `service_monitor.rs`, где её
    /// не измеряло ничего — модуль компилируется только под
    /// `cfg(target_os = "android")`. Проверка литералами: сверять собранное
    /// с той же константой, из которой оно собрано, значит измерять себя.
    #[test]
    fn sos_envelope_is_a_vault_signal_of_type_sos() {
        let json = build_sos_envelope("Телефон не у меня 55.75,37.61", 1_700_000_000_000);
        let obj: serde_json::Value = serde_json::from_str(&json).expect("конверт — JSON");
        assert_eq!(obj["vault"], 1, "маркер формата: {json}");
        assert_eq!(obj["type"], "sos", "получатель узнаёт SOS по полю type: {json}");
        assert_eq!(obj["id"], "1700000000000sos", "метка sos в идентификаторе");
        assert_eq!(obj["ts"].as_i64(), Some(1_700_000_000_000));
        assert_eq!(obj["text"], "Телефон не у меня 55.75,37.61", "текст беды доезжает");
    }

    /// Пустой текст — не основание молчать: получатель обязан получить
    /// сигнал беды и тогда, когда текст не подставился. Проверяется наличие
    /// поля `text` в конверте, а не его содержательность.
    #[test]
    fn sos_envelope_keeps_the_type_with_empty_text() {
        let json = build_sos_envelope("", 7);
        let obj: serde_json::Value = serde_json::from_str(&json).expect("конверт — JSON");
        assert_eq!(obj["type"], "sos");
        assert_eq!(obj["text"], "");
    }

    #[test]
    fn rejects_malformed_stored_hash() {
        let good = hash_secret("1234");
        let (salt, hash) = good.split_once(':').unwrap();
        assert!(!verify_secret("1234", salt), "нет разделителя");
        assert!(
            !verify_secret("1234", &format!("{}:{hash}", &salt[..8])),
            "короткая, но hex соль"
        );
        assert!(!verify_secret("1234", &format!("{salt}:")), "пустой хэш");
        assert!(
            !verify_secret("1234", &format!("{salt}:{}", &hash[..62])),
            "короткий хэш"
        );
        assert!(
            !verify_secret("1234", &format!("zz{salt}:{hash}")),
            "не-hex соль"
        );
        assert!(
            !verify_secret("1234", &format!("{salt}:zz{}", &hash[2..])),
            "не-hex хэш"
        );
    }

    #[test]
    fn empty_secret_is_still_hashed() {
        let h = hash_secret("");
        assert!(verify_secret("", &h));
        assert!(!verify_secret("0", &h));
    }

    // ── Правило текста SOS (27.10, #38): переехало из двух копий в одну ──

    fn rule<'a>(
        text: &'a str,
        default_text: &'a str,
        geo_on: bool,
        geo: &'a str,
        sep: &'a str,
    ) -> SosText<'a> {
        SosText { text, default_text, geo_on, geo, separator: sep }
    }

    /// Настольная и headless-сборки одного и того же конфига должны давать
    /// ОДИН текст — это и был смысл сведения копий. Проверяется буквами,
    /// а не «правилом же»: сверять собранное с той же константой, из которой
    /// оно собрано, значит измерять себя.
    #[test]
    fn desktop_letter_is_the_live_shape() {
        assert_eq!(
            compose_sos_text(&rule(
                "Телефон не у меня{coords}",
                "Телефон не у меня{coords}",
                true,
                ", мои координаты: 55.75150, 37.61550",
                ""
            )),
            "Телефон не у меня, мои координаты: 55.75150, 37.61550"
        );
    }

    #[test]
    fn headless_letter_is_the_live_shape() {
        assert_eq!(
            compose_sos_text(&rule("Меня заставляют открыть", "", true, "55.75150, 37.61550", " | ")),
            "Меня заставляют открыть | 55.75150, 37.61550"
        );
    }

    #[test]
    fn unset_text_falls_back_to_the_channels_default() {
        assert_eq!(
            compose_sos_text(&rule("", "Авария{coords}", false, "", "")),
            "Авария",
            "пустая настройка — не основание слать письмо без слов"
        );
        // Пробелы — тоже «не настроено», иначе письмо приходит пустым.
        assert_eq!(compose_sos_text(&rule("   ", "Авария", false, "", "")), "Авария");
        // Headless своего дефолта не имеет: там пустая настройка остаётся
        // пустой (и это зафиксировано буквом выше, а не изменено по дороге).
        assert_eq!(compose_sos_text(&rule("", "", false, "", " | ")), "");
    }

    #[test]
    fn placeholder_never_survives_without_coordinates() {
        assert_eq!(
            compose_sos_text(&rule("Телефон{coords}, помоги", "", false, "", "")),
            "Телефон, помоги"
        );
        // И ни одно вхождение не переживает: их два — подставляются оба.
        assert_eq!(
            compose_sos_text(&rule("{coords} и {coords}", "", true, "Т:1,2", "")),
            "Т:1,2 и Т:1,2"
        );
    }

    #[test]
    fn tail_phrase_requires_the_geo_flag() {
        // Гео включено, координаты есть, плейсхолдера нет → хвост.
        assert_eq!(
            compose_sos_text(&rule("Помоги", "", true, ", мои координаты: 1, 2", "")),
            "Помоги, мои координаты: 1, 2"
        );
        // Гео выключено — фраза не дописывается никогда, даже если пришла.
        assert_eq!(
            compose_sos_text(&rule("Помоги", "", false, ", мои координаты: 1, 2", "")),
            "Помоги"
        );
        // Координат нет — никакого висячего разделителя в начале письма.
        assert_eq!(compose_sos_text(&rule("Помоги", "", true, "", " | ")), "Помоги");
    }

    #[test]
    fn geo_phrase_carries_five_decimal_places() {
        assert_eq!(
            geo_phrase("мои координаты", 55.7515099, 37.6155),
            ", мои координаты: 55.75151, 37.61550"
        );
        // Подпись — язык отправителя, ядро её не изобретает: без неё — числа.
        assert_eq!(geo_phrase("  ", 1.0000001, 2.5), ", 1.00000, 2.50000");
    }
}
