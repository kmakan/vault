//! Кто это «я»: нормализация адресов и предикат владения записью (ADR-005 §W4,
//! партия 4).
//!
//! ЖИВЁТ В `vault-core`, А НЕ В `vault-client`: тот же вопрос о форме адреса
//! задаёт хранилище ключей (`key_store`: гейт адреса, дедуп, переименование,
//! удаление), а `vault-client` зависит от `vault-core`, не наоборот. Путь
//! `vault::identity` сохранён реэкспортом.
//!
//! ЗАЧЕМ В ЯДРЕ. Вопрос «эта запись моя?» решает, что удаляется, что
//! пересылается и что считается уже импортированным. Ошибка здесь не
//! косметическая: чужую запись клиент принимает за свою и убирает её из ленты
//! (или, наоборот, свою перестаёт видеть — регрессия 05–06.10.2026, когда
//! группы «исчезли» после смены почты). До переноса правило жило во мосту
//! (`src-tauri/src/groups.rs::filter_own_groups`), то есть вне
//! `rust-mutation-gate`, а CLI вообще не знал ни алиасов, ни отпечатков:
//! `listen.rs` отсекал self-копии сравнением `eq_ignore_ascii_case`, а
//! `cli/repl.rs` искал участника по `to_lowercase()` без обрезки пробелов.
//! Три копии одного факта расходятся молча — четвёртая (в JS) уже разошлась,
//! см. ниже.
//!
//! ДУБЛИ, КОТОРЫЕ МЕРЯЮТСЯ ЗДЕСЬ (23.10, поиск по фронту и CLI):
//!  * `groups.rs::filter_own_groups` — владение = email ∪ алиасы ∪ fp;
//!  * `groups.rs::backfill_my_fingerprint` — тот же вопрос про адрес, но
//!    `eq_ignore_ascii_case` (кириллицу не понижает);
//!  * `backup_import.rs` — отбраковка дублей участников по
//!    `to_ascii_lowercase()`;
//!  * `storage/sqlite.rs::normalize_account` — та же форма «fp-first, адрес
//!    как fallback», реализованная отдельно;
//!  * `api.js:2057` — `g.created_by === this.email || members.some(… ===
//!    this.email)`: регистрозависимо, без алиасов и без fp (вне этой мерки,
//!    заведено отдельной задачей).
//!
//! ФОРМА АДРЕСА — ОДНО ПРАВИЛО. `normalize` = `trim` + ЮНИКОДНЫЙ
//! `to_lowercase()`. Не `to_ascii_lowercase()`: он кириллицу не трогает, и
//! сравнение `Иван@почта.рф` с `иван@почта.рф` не срабатывает НИКОГДА — тот же
//! дефект, что вскрылся 23.10 при переносе классификации папок
//! (`vault::mailbox_names`).
//!
//! ПУСТОЕ ЗНАЧЕНИЕ НИКОГДА НЕ СОВПАДАЕТ. Сравнение «пустой адрес == пустой
//! адрес» означало бы, что письмо без `From` считается своим (в слушателе CLI
//! оно молча выбрасывалось), а пустой отпечаток совпадает с любым. Это контракт
//! предикатов, а не защита от вызывающего: он проверяется мутациями.

use std::collections::HashSet;

/// Нормальная форма идентификатора: обрамление срезано, регистр — нижний по
/// Юникоду (не ASCII).
pub fn normalize(raw: &str) -> String {
    raw.trim().to_lowercase()
}

/// Один и тот же адрес с двух сторон границы? Пустая строка — НЕ адрес,
/// поэтому не совпадает ни с чем, включая другую пустую строку.
pub fn same_address(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    !a.is_empty() && a == b
}

/// Настоящий контактный адрес: содержит `@` и не служебный `fp:`-ключ.
/// Служебный ключ account-namespace заводил «контакт-отпечаток» в списке
/// (живой баг 06.10.2026). Проверка — по нормальной форме, поэтому `FP:` и
/// адрес с обрамлением оцениваются так же, как их нормальный вид.
pub fn is_contact_address(raw: &str) -> bool {
    let v = normalize(raw);
    v.contains('@') && !v.starts_with("fp:")
}

/// Тот же отпечаток? Пустой отпечаток (старые группы, инвайты без поля) не
/// означает «любой».
pub fn same_fingerprint(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    !a.is_empty() && a == b
}

/// Короткий отпечаток публичного ключа в форме десктопа: hex → первые 8 байт →
/// `xx:xx:…:****`. Форма — часть контракта релея (read-токен привязан к
/// отпечатку) и поля `GroupMember::fingerprint`, поэтому она одна на мост и
/// CLI, а не две реализации с разным срезом.
pub fn fingerprint_from_public_key(public_key_hex: &str) -> Result<String, String> {
    let bytes =
        hex::decode(public_key_hex.trim()).map_err(|e| format!("Invalid public key hex: {e}"))?;
    if bytes.len() != 32 {
        return Err("Public key must be 32 bytes".to_string());
    }
    let fp = bytes[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":");
    Ok(format!("{fp}:****"))
}

/// Какой отпечаток записать участнику. Пустой слот заполняется; значение,
/// равное ПУБЛИЧНОМУ КЛЮЧУ, — след старого backfill (фронт писал ключ в поле
/// отпечатка) и заменяется настоящим. Всё остальное не трогаем: клиент мог
/// выяснить отпечаток по живым письмам, и перезапись стёрла бы это знание.
pub fn fingerprint_to_repair(
    existing: &str,
    computed: &str,
    public_key_hex: &str,
) -> Option<String> {
    let computed = normalize(computed);
    if computed.is_empty() {
        return None;
    }
    let existing = normalize(existing);
    if existing.is_empty() || existing == normalize(public_key_hex) {
        Some(computed)
    } else {
        None
    }
}

/// Ключ записи хранилища для адреса: нормальная форма, а пустой адрес — не
/// ключ. Реестр присутствия и namespaces-ключи монитора держат одну и ту же
/// форму, иначе `Bob@X` и `bob@x` — две разные записи об одном человеке.
pub fn ledger_key(email: &str) -> Option<String> {
    let key = normalize(email);
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// «Я» для целей владения записью: текущий адрес, известные алиасы и
/// отпечаток публичного ключа. Все три нормализуются при создании, поэтому
/// сравнивать можно без повторной нормализации на каждом вызове.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    email: String,
    aliases: Vec<String>,
    fingerprint: String,
    addresses: HashSet<String>,
}

impl Identity {
    /// Собрать «мои» идентификаторы. Алиасы и адрес с пустой строкой в
    /// множество не попадают; пустой отпечаток — значит fp-проверка всегда
    /// ложна (ровно так вело себя исходное правило `filter_own_groups`).
    pub fn new(email: &str, aliases: &[String], fingerprint: &str) -> Self {
        let email = normalize(email);
        let fingerprint = normalize(fingerprint);
        let mut addresses: HashSet<String> = HashSet::new();
        if !email.is_empty() {
            addresses.insert(email.clone());
        }
        let mut norm_aliases: Vec<String> = Vec::with_capacity(aliases.len());
        for a in aliases {
            let v = normalize(a);
            if v.is_empty() || addresses.contains(&v) {
                continue;
            }
            addresses.insert(v.clone());
            norm_aliases.push(v);
        }
        Self {
            email,
            aliases: norm_aliases,
            fingerprint,
            addresses,
        }
    }

    /// Нормальный адрес аккаунта (для подписей и ключей хранилища).
    pub fn email(&self) -> &str {
        &self.email
    }

    /// Нормальный отпечаток аккаунта.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    /// Алиасы в нормальной форме: без пустых, без повторов и без самого
    /// адреса аккаунта (он и так в множестве).
    pub fn aliases(&self) -> &[String] {
        &self.aliases
    }

    /// Принадлежит ли мне адрес (email или любой алиас).
    pub fn has_address(&self, candidate: &str) -> bool {
        let v = normalize(candidate);
        !v.is_empty() && self.addresses.contains(&v)
    }

    /// Принадлежит ли мне этот отпечаток.
    pub fn has_fingerprint(&self, candidate: &str) -> bool {
        same_fingerprint(&self.fingerprint, candidate)
    }

    /// Принадлежит ли мне ЭТА запись участника: адрес (email или алиас) ИЛИ
    /// отпечаток. Отпечаток стабилен при смене почты, поэтому он и решает, а
    /// адрес — fallback для записей, где fp ещё не заполнен. Пустой fp ни с
    /// чем не совпадает.
    pub fn member_matches(&self, email: &str, fingerprint: &str) -> bool {
        self.has_address(email) || self.has_fingerprint(fingerprint)
    }

    /// Моя ли группа. `members` — пары (адрес участника, его отпечаток):
    /// форма записи здесь не важна, важен вопрос. Создатель считается по
    /// адресам (email ∪ алиасы), участник — по адресу ИЛИ отпечатку:
    /// отпечаток стабилен при смене почты, поэтому он и идёт первым в
    /// формулировке правила, а адрес остаётся fallback для записей, где fp
    /// ещё не заполнен.
    pub fn owns_group<'a, I>(&self, created_by: &str, members: I) -> bool
    where
        I: IntoIterator<Item = (&'a str, &'a str)>,
    {
        if self.has_address(created_by) {
            return true;
        }
        members
            .into_iter()
            .any(|(email, fp)| self.member_matches(email, fp))
    }
}

/// Заполнить пустой слот отпечатка: `Some` — записать это значение, `None` — не
/// трогать. Два стража без условия «чей это участник» — их используют обе
/// ленивые миграции старых `groups.json`: `backfill_my_fingerprint` дописывает
/// отпечаток себе, `groups_save_member_fingerprints` — любому участнику из
/// `peer_keys`. Пустой новый отпечаток не пишется (пустым затирается смысл
/// поля), непустой существующий не перезаписывается (иначе повторный вызов
/// стёр бы отпечаток, который клиент уже выяснил по живым письмам).
pub fn fill_missing_fingerprint(existing_fp: &str, new_fp: &str) -> Option<String> {
    let new_fp = normalize(new_fp);
    if new_fp.is_empty() || !existing_fp.trim().is_empty() {
        return None;
    }
    Some(new_fp)
}

/// Нужно ли проставить отпечаток участнику, которого мы ищем (ленивая
/// миграция `backfill_my_fingerprint` — ищем себя). Сверху — те же два стража,
/// здесь к ним добавляется треть: совпавший адрес. Сравнение — `same_address`,
/// а не ASCII-регистр: письма с не-ASCII локальной частью существовали всегда.
pub fn fingerprint_to_write(
    existing_fp: &str,
    new_fp: &str,
    member_email: &str,
    my_email: &str,
) -> Option<String> {
    if same_address(member_email, my_email) {
        fill_missing_fingerprint(existing_fp, new_fp)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "anna@mail.ru";
    const FP: &str = "ab12cd";

    fn id() -> Identity {
        Identity::new(ME, &["anna@ya.ru".to_string()], FP)
    }

    fn members<'a>(v: &'a [(&'a str, &'a str)]) -> impl Iterator<Item = (&'a str, &'a str)> + 'a {
        v.iter().copied()
    }

    #[test]
    fn normalize_trims_and_lowercases_unicode() {
        assert_eq!(normalize("  Иван@Почта.РФ "), "иван@почта.рф");
        // Мутация «ASCII-нижний регистр» ловится именно здесь: с
        // to_ascii_lowercase() кириллица остаётся кириллицей, и сравнение
        // двух записей одного человека не срабатывает никогда.
        assert_ne!("ИВАН".to_ascii_lowercase(), "иван");
    }

    #[test]
    fn empty_values_never_match_anything() {
        assert!(!same_address("", ""));
        assert!(!same_address("   ", ""));
        assert!(!same_fingerprint("", ""));
        assert!(!id().has_address(""));
        assert!(!id().has_fingerprint(""));
    }

    #[test]
    fn contact_address_is_judged_by_normal_form() {
        // Хранилище ключей индексирует контакты по адресу: служебный
        // fp:-ключ и строка без `@` — не контакт. Регистр и обрамление не
        // должны открывать обход гейта.
        assert!(is_contact_address(" Anna@Mail.RU "));
        assert!(is_contact_address("Иван@Почта.РФ"));
        assert!(!is_contact_address("fp:ab:cd"));
        assert!(!is_contact_address(" FP:bob@mail.ru "));
        assert!(!is_contact_address("not-an-email"));
        assert!(!is_contact_address(""));
    }

    #[test]
    fn address_match_is_case_and_whitespace_insensitive() {
        assert!(same_address(" Anna@Mail.RU ", ME));
        assert!(id().has_address("ANNA@YA.RU")); // алиас
        assert!(!id().has_address("oleg@mail.ru"));
    }

    #[test]
    fn owner_is_found_by_created_by_address() {
        assert!(id().owns_group("ANNA@Mail.ru ", members(&[])));
        assert!(id().owns_group("anna@ya.ru", members(&[]))); // алиас создателя
        assert!(!id().owns_group("oleg@mail.ru", members(&[])));
    }

    #[test]
    fn member_ownership_works_by_fingerprint_after_email_change() {
        // Смена почты: адрес в группе старый, отпечаток мой — группа остаётся
        // моей. Строгое сравнение по email (регрессия 05–06.10) её теряло.
        assert!(id().owns_group("oleg@mail.ru", members(&[("anna@old.example", FP)])));
    }

    #[test]
    fn member_ownership_falls_back_to_email_without_fingerprint() {
        assert!(id().owns_group("oleg@mail.ru", members(&[("anna@mail.ru", "")])));
    }

    #[test]
    fn foreign_member_is_not_mine() {
        assert!(!id().owns_group(
            "oleg@mail.ru",
            members(&[("oleg@mail.ru", "ff00"), ("petr@mail.ru", "")])
        ));
    }

    #[test]
    fn member_record_is_mine_by_address_or_fingerprint() {
        // Тот же предикат, по которому `owns_group` находит участника, теперь
        // доступен носителю отдельно: по нему фронт узнаёт «моя ли это строка»
        // (права в группе), не сравнивая адреса сам.
        assert!(id().member_matches(" ANNA@mail.ru ", ""));
        assert!(id().member_matches("anna@ya.ru", "")); // алиас
        assert!(id().member_matches("oleg@mail.ru", FP)); // мой отпечаток
        assert!(!id().member_matches("oleg@mail.ru", ""));
        // Пустой адрес сам по себе — не я, НО отпечаток решает: строка участника
        // без адреса с моим ключом принадлежит мне (инвайты без `sender`).
        assert!(!id().member_matches("", ""));
        assert!(id().member_matches("", FP));
        let no_fp = Identity::new(ME, &[], "");
        assert!(
            !no_fp.member_matches("oleg@mail.ru", ""),
            "пустой отпечаток ничего не утверждает"
        );
    }

    #[test]
    fn empty_account_fingerprint_does_not_claim_every_group() {
        // «Пустой fp совпадает с любым» — это спуфинг: чужая группа становится
        // моей.
        let no_fp = Identity::new("anna@mail.ru", &[], "");
        assert!(!no_fp.owns_group("oleg@mail.ru", members(&[("oleg@mail.ru", "ff00")])));
        assert!(no_fp.owns_group("oleg@mail.ru", members(&[("ANNA@MAIL.RU", "ff00")])));
    }

    #[test]
    fn aliases_are_normalized_and_duplicates_collapse() {
        let i = Identity::new(
            ME,
            &[
                " ANNA@YA.RU ".to_string(),
                "anna@ya.ru".to_string(),
                ME.to_string(),
                "  ".to_string(),
            ],
            FP,
        );
        assert_eq!(i.aliases(), ["anna@ya.ru"]);
        assert!(i.has_address("anna@ya.ru"));
    }

    #[test]
    fn fingerprint_backfill_only_fills_empty_slots() {
        assert_eq!(
            fingerprint_to_write("", FP, ME, "anna@mail.ru").as_deref(),
            Some("ab12cd")
        );
        assert_eq!(
            fingerprint_to_write("existing", FP, ME, "anna@mail.ru"),
            None
        );
        assert_eq!(fingerprint_to_write("", "", ME, "anna@mail.ru"), None);
        assert_eq!(fingerprint_to_write("", FP, "oleg@mail.ru", ME), None);
    }

    /// Массовая миграция из `peer_keys`: отпечаток пишется любому участнику,
    /// условие «это я» здесь ни при чём.
    #[test]
    fn fingerprint_fill_does_not_require_my_address() {
        assert_eq!(
            fill_missing_fingerprint("", "AB12CD").as_deref(),
            Some("ab12cd")
        );
        assert_eq!(fill_missing_fingerprint("", "  "), None);
        assert_eq!(
            fill_missing_fingerprint("existing", FP),
            None,
            "занный отпечаток не затирается"
        );
        assert_eq!(
            fill_missing_fingerprint("   ", FP).as_deref(),
            Some("ab12cd"),
            "пробел вместо отпечатка — это пустой слот, а не занятый"
        );
    }

    #[test]
    fn fingerprint_backfill_matches_unicode_addresses() {
        assert_eq!(
            fingerprint_to_write("", "FP", "Иван@Почта.РФ", "иван@почта.рф").as_deref(),
            Some("fp")
        );
        assert_eq!(
            fingerprint_to_write("", "FP", "иван@почта.рф", "Иван@другой.рф"),
            None
        );
    }

    #[test]
    fn identity_new_normalizes_all_fields() {
        let i = Identity::new(" ANNA@Mail.RU ", &["Oleg@Mail.RU".to_string()], " AB12CD ");
        assert_eq!(i.email(), "anna@mail.ru");
        assert_eq!(i.fingerprint(), "ab12cd");
        assert!(i.has_address("OLEG@mail.ru"));
    }

    #[test]
    fn ledger_key_is_the_normal_form_and_empty_is_not_a_key() {
        assert_eq!(ledger_key(" Bob@X ").as_deref(), Some("bob@x"));
        assert_eq!(ledger_key("BOB@X"), ledger_key("bob@x"));
        assert_eq!(ledger_key(""), None);
        assert_eq!(ledger_key("   "), None);
    }

    /// Нормальная форма идемпотентна: второй проход не меняет строку (иначе
    /// ключи хранилища зависели бы от того, сколько раз их нормализовали).
    #[test]
    fn normal_form_is_stable_under_second_pass() {
        assert_eq!(normalize(&normalize("  ANNA@YA.RU ")), "anna@ya.ru");
    }

    #[test]
    fn fingerprint_is_first_8_bytes_of_the_key() {
        let key = "00".repeat(32);
        assert_eq!(
            fingerprint_from_public_key(&key).as_deref(),
            Ok("00:00:00:00:00:00:00:00:****")
        );
        let key = format!("{}ff{}", "ab".repeat(8), "cd".repeat(23));
        assert_eq!(
            fingerprint_from_public_key(&key).as_deref(),
            Ok("ab:ab:ab:ab:ab:ab:ab:ab:****")
        );
        assert!(fingerprint_from_public_key("not-hex").is_err());
        assert!(
            fingerprint_from_public_key(&"00".repeat(31)).is_err(),
            "31 байт — не ключ X25519"
        );
    }

    #[test]
    fn fingerprint_repair_fills_empty_and_replaces_the_public_key_trace() {
        let key = "ab".repeat(32);
        let fp = "aa:bb:cc:dd:ee:ff:00:11:****";
        assert_eq!(fingerprint_to_repair("", fp, &key).as_deref(), Some(fp));
        assert_eq!(
            fingerprint_to_repair(&key.to_uppercase(), fp, &key).as_deref(),
            Some(fp),
            "поле, где лежит сам ключ, — след старого backfill"
        );
        assert_eq!(
            fingerprint_to_repair("01:02:03:04:05:06:07:08:****", fp, &key),
            None,
            "выясненный отпечаток не перезаписывается"
        );
        assert_eq!(fingerprint_to_repair("", "", &key), None);
    }
}
