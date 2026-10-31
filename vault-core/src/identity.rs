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
//!  * `key_store.rs::add_peer_key_at` — SELF-KEY GUARD сравнением СТРОК
//!    (`kp.public_key == key.public_key`): ключ, записанный в верхнем регистре
//!    или с обрамлением, стража проходил;
//!  * `chat-navigation.js` / `messages.js` — гейт «есть ли ключ собеседника»
//!    по голой строке адреса, без словаря `email-aliases`: после смены почты у
//!    пира тап по известному адресу открывал попап «Добавить контакт» вместо
//!    чата. Мера форм адреса — `address_variants` здесь;
//!  * `profiles.js::broadcastProfile` — обход ВСЕХ `peer_keys`, включая записи
//!    нашего собственного ключа (алиасы своей сессии лежат там же, где чужие
//!    ключи): письмо-профиль уходило самому себе. Мера — `peer_is_self`.
//!
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

/// Все формы адреса, под которыми может лежать ключ собеседника после смены
/// почты. Словарь `aliases` — пары (старый, новый) из kv `email-aliases`;
/// порядок обхода — как в словаре.
///
/// ТРИ варианта, в этом порядке:
///  1. сам адрес (нормальная форма) — быстрый путь, ключ не переезжал;
///  2. конец цепочки old→new — контакт менял почту дважды, ключ под свежим
///     адресом; цикл A→B→A обрывается на первом повторе (тот же дефект, что
///     чинил `rememberAlias`: циклом резолв зависал, а победитель зависел от
///     порядка перечитывания писем);
///  3. адреса, которые резолвятся В этот — строка списка/письма осталась
///     СТАРОЙ, а ключ переехал на новый адрес.
///
/// ЗАЧЕМ В ЯДРЕ. Пункт 3 — это то, из-за чего тап по контакту после смены
/// почты показывал попап «Добавить контакт» вместо открытого чата: гейт
/// `chat-navigation.js` спрашивал ключ по строке адреса, не зная словаря.
/// Вопрос «какими формами адреса это один и тот же пир» решает ядро, фронт
/// лишь перебирает возвращённые формы.
///
/// Пустой адрес — ноль вариантов; пустой новый адрес в паре в цепочку не
/// ведёт (им нельзя затереть смысл ключа).
pub fn address_variants(aliases: &[(String, String)], address: &str) -> Vec<String> {
    let start = normalize(address);
    if start.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = vec![start.clone()];
    let push = |out: &mut Vec<String>, v: String| {
        if !v.is_empty() && !out.contains(&v) {
            out.push(v);
        }
    };

    for next in alias_chain(aliases, &start) {
        push(&mut out, next);
    }

    for (from, to) in aliases {
        let (f, t) = (normalize(from), normalize(to));
        if f.is_empty() || t != start {
            continue;
        }
        push(&mut out, f);
    }
    out
}

/// Звенья цепочки `old→new` после `start`, в порядке обхода. Цикл `A→B→A`
/// обрывается на первом повторе: иначе резолв ходит по кругу, а «победитель»
/// зависит от порядка перечитывания писем (живые данные 08.10.2026).
///
/// ОДНА ЦЕПОЧКА НА ДВА ВОПРОСА. «Какими формами адреса это один пир» и «какой
/// адрес у него сейчас» — один обход, заданный с двух сторон; вторая копия
/// обхода (раньше жила во фронте) расходилась с ядром молча.
fn alias_chain(aliases: &[(String, String)], start: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(start.to_string());
    let mut cur = start.to_string();
    loop {
        let next = match aliases.iter().find(|(from, _)| normalize(from) == cur) {
            Some((_, to)) => normalize(to),
            None => break,
        };
        if next.is_empty() || !seen.insert(next.clone()) {
            break;
        }
        out.push(next.clone());
        cur = next;
    }
    out
}

/// Свежий адрес пира для строки из письма или списка: конец цепочки
/// `old→new`, а без смены — нормальная форма самого адреса. Пустой адрес
/// остаётся пустым (резолвить нечего). Вопрос тот же, что у
/// `address_variants`, но ответ — один адрес, а не все формы.
pub fn resolve_alias(aliases: &[(String, String)], address: &str) -> String {
    let start = normalize(address);
    if start.is_empty() {
        return String::new();
    }
    alias_chain(aliases, &start).pop().unwrap_or(start)
}

/// Письмо пришло ОТ НАС? Отправитель сначала приводится к свежему адресу
/// (цепочка `old→new`), затем сравнивается с нашим адресом нормальной формой.
///
/// ЗАЧЕМ В ЯДРЕ. Handshake-письма (инвайт, accept) живут в ящике вечно, и
/// четыре места фронта отдельно решали «это мы?» сравнением строк ПОСЛЕ
/// резолва. Сравнение было регистрозависимым, поэтому своё письмо с адресом
/// в другом регистре проходило гейт и возвращало наш ключ в контакты; правка
/// одной копии не ловилась остальными (ADR-005 §2). Пустой отправитель — не
/// мы: `same_address` не считает пустое значение адресом.
pub fn is_own_address(aliases: &[(String, String)], own_address: &str, address: &str) -> bool {
    same_address(&resolve_alias(aliases, address), own_address)
}

/// Словарь смен, сведённый к свежим адресам: `(строка, которой адрес был,
/// → адрес, которым он стал)`. Нужен кэшу фронта, чтобы резолв строки был
/// одним поиском, а не обходом цепочки в JS. Цепочка `A→B→C` даёт две строки
/// с одним концом, цикл разрешается звеньями (как `resolve_alias`); пары без
/// смены (пустые, ведущие в пустоту, сам в себя) не выдаются.
pub fn alias_resolutions(aliases: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (from, _) in aliases {
        let key = normalize(from);
        if key.is_empty() || out.iter().any(|(seen, _)| *seen == key) {
            continue;
        }
        let fresh = resolve_alias(aliases, &key);
        if fresh != key {
            out.push((key, fresh));
        }
    }
    out
}

/// Словарь `email-aliases` после запоминания смены `old → new`.
///
/// ДВА ПРАВИЛА, ОБА ИЗ ЖИВЫХ ДАННЫХ (08.10.2026):
///  * запись со старым ключом заменяется, а запись, где ключ — НОВЫЙ адрес,
///    убирается: после смены A→B→A карта {A:B, B:A} зацикливала резолв, и
///    «победитель» зависел от порядка перечитывания писем;
///  * словарь нормализуется целиком: ключи приходят из kv как их записал
///    фронт, а искать по ним будет `resolve_alias`.
///
/// Пустая смена и `old == new` новых пар не добавляют.
pub fn alias_pairs_after_remember(
    aliases: &[(String, String)],
    old_email: &str,
    new_email: &str,
) -> Vec<(String, String)> {
    let old = normalize(old_email);
    let new = normalize(new_email);
    let real = !old.is_empty() && !new.is_empty() && old != new;
    let mut out: Vec<(String, String)> = Vec::with_capacity(aliases.len() + 1);
    for (from, to) in aliases {
        let (f, t) = (normalize(from), normalize(to));
        if real && (f == old || f == new) {
            continue;
        }
        out.push((f, t));
    }
    if real {
        out.push((old, new));
    }
    out
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

/// Запись peer-хранилища — ЭТО МЫ? Два пути, и оба про идентичность, а не про
/// строку адреса:
///  1. адрес в `id` (email ∪ алиасы);
///  2. публичный ключ совпал с нашим (запись могла лежать под адресом, о
///     котором мост не знает — контакты общий на машину peer-store).
///
/// Мера для ЧТЕНИЯ списка контактов, добивки из групп и broadcast профиля.
/// Запись ключа опирается на те же два предиката, но по отдельности: мост
/// спрашивает адрес (`Identity::has_address` — «не клади чужой ключ под нашей
/// почтой»), ядро хранилища — ключ (`same_public_key` — «не клади наш ключ как
/// пирский»), и у каждого отказа своё сообщение. Прежняя запись
/// (`key_store::add_peer_key_at`) сравнивала строки ключа без нормализации,
/// поэтому ключ в верхнем регистре проходил стража, а собственный аккаунт
/// оставался в `peer_keys` «контактом»: список показывал свою почту строкой,
/// тап по ней открывал попап «Добавить контакт» вместо чата, а broadcast
/// профиля писал письмо самому себе (живые данные 24.10).
pub fn peer_is_self(id: &Identity, address: &str, public_key: &str, own_public_key: &str) -> bool {
    id.has_address(address) || same_public_key(public_key, own_public_key)
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

/// Один и тот же публичный ключ с двух сторон границы? Hex нечувствителен к
/// регистру, сравнивается полная длина (первые 8 байт — отпечаток, это ДРУГОЙ
/// контракт). Пустой ключ не совпадает ни с чем, включая другой пустой.
pub fn same_public_key(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    !a.is_empty() && a == b
}

/// Сколько ключей перебирает слушатель, когда ключ отправителя не подошёл.
/// Ограничение — про цену тика (перебор идёт по каждому письму тика), а не про
/// протокол: неподходящий ключ отбрасывает AEAD-проверка.
pub const PEER_KEY_CANDIDATES_MAX: usize = 8;

/// Ключ собеседника в форме, удобной для перебора: адрес нужен затем, чтобы
/// сказать, ЧЕЙ это ключ, когда расшифрование удалось.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerKey<'a> {
    pub address: &'a str,
    pub public_key: &'a str,
    pub pq_ek: Option<&'a str>,
}

/// Порядок перебора ключей при расшифровании письма от `sender`.
///
/// ЗАЧЕМ. У человека несколько ящиков: письмо приходит с основного адреса, а
/// ТЕКУЩИЙ ключ этого человека слушатель записал под адресом-алиасом (31.10:
/// письмо `From: koanmak@ya.ru` зашифровано ключом, лежавшим за
/// `vault-msg@ya.ru`, и слушатель молча отбраковывал его как «AAD auth
/// failed»). Гибридный `PQ1`-конверт это маскировал: там ключ сообщения задаёт
/// KEM получателя, и кривая отправителя в шифре не участвует. Сломалось ровно
/// тогда, когда отправитель ушёл на legacy-форму.
///
/// ПРАВИЛО. Первым пробуется ключ самого отправителя (обычный путь — ничего не
/// меняется), затем ключи остальных контактов: детерминированно по адресу
/// (перебор не должен зависеть от порядка перечитывания книги), без пустых
/// ключей и без повторов одного и того же ключа. Ответ даёт AEAD: под этим
/// ключом письмо расшифровывается или нет, поэтому «подошёл чужой ключ» — это
/// не подделка, а просто неверный ключ в книге. Перебор ТОЛЬКО читает книгу:
/// ничего не записывает и не переносит.
pub fn peer_key_candidates<'a>(sender: &str, known: &[PeerKey<'a>]) -> Vec<PeerKey<'a>> {
    let mut ordered: Vec<PeerKey<'a>> = known
        .iter()
        .filter(|k| !k.public_key.trim().is_empty())
        .cloned()
        .collect();
    ordered.sort_by(|a, b| {
        let rank = |addr: &str| if same_address(addr, sender) { 0u8 } else { 1u8 };
        rank(a.address)
            .cmp(&rank(b.address))
            .then_with(|| normalize(a.address).cmp(&normalize(b.address)))
    });
    let mut out: Vec<PeerKey<'a>> = Vec::new();
    for k in ordered {
        if out.len() >= PEER_KEY_CANDIDATES_MAX {
            break;
        }
        if out
            .iter()
            .any(|seen| same_public_key(seen.public_key, k.public_key))
        {
            continue;
        }
        out.push(k);
    }
    out
}

/// Исход перебора ключей собеседника. Четыре разных «нет» вместо одного
/// молчания: «ключа нет в книге», «ни один не подошёл», «письмо расшифровалось
/// чужим ключом, но это не наш конверт» и успех — на вызывающей стороне
/// решают по-разному (первое тихо пропускает, второе ретраит, третье забудет).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerLetter<T> {
    /// Конверт открыт. `key_address` — ЗА ЧЕМ ключ лежал в книге, а не адрес
    /// отправителя: расхождение и есть «у человека второй ящик».
    Opened {
        value: T,
        key_address: String,
        /// Ключ записан за адресом отправителя (обычный путь, ренейм не нужен).
        from_own_address: bool,
    },
    /// Тело открылось этим ключом, но содержимое — не наш конверт.
    /// Искать дальше бессмысленно: другой ключ это же тело не откроет.
    NotOurLetter { key_address: String },
    /// Были кандидаты, ни один не открыл. `tried` и `last_error` — диагноз.
    NoKey {
        tried: usize,
        last_error: Option<String>,
    },
    /// Открывать нечем: в книге нет ни одного непустого ключа.
    EmptyBook,
}

/// Открыть письмо тем ключом книги, который его открывает.
///
/// ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. Порядок и стоп-условия — протокольное решение
/// (какой ключ вероятнее, когда прекращать перебор, что считать «не нашим
/// письмом»). 31.10 слушатель бота терял письма, потому что это решение жило
/// в его цикле вместе с применением ключа: порядок нельзя было проверить
/// отдельно от `crypto`, а тест проверял только «письмо прочиталось или нет».
/// Здесь решение отделено от шифра: вызывающий даёт книгу и одно действие —
/// «попробуй этот ключ».
///
/// ОСТАТОК (честно, чтобы не выглядело сделанным). У монитора сервиса
/// (`monitor_state::decrypt_order`) и у фронта (`features/incoming.js`) пока
/// свои копии порядка, и они НЕ совпадают с этой: монитор пробует ещё и свой
/// ключ, фронт сначала матчит конверт по ключу из заголовка. Поэтому свести их
/// — отдельный шаг (каждой копии нужен свой вход), а не «ещё один вызов».
/// Здесь закрыт путь слушателя; копии перечислены в ADR-005.
///
/// `attempt` возвращает `Ok(None)`, когда тело ОТКРЫЛОСЬ, но это не наш
/// конверт: перебор обязан остановиться на верном ключе, а не идти гадать
/// дальше и приписать отказ следующему ключу.
pub fn decrypt_with_peer_keys<'a, T, E, F>(
    sender: &str,
    book: &[PeerKey<'a>],
    mut attempt: F,
) -> PeerLetter<T>
where
    E: std::fmt::Display,
    F: FnMut(PeerKey<'a>) -> Result<Option<T>, E>,
{
    let candidates = peer_key_candidates(sender, book);
    if candidates.is_empty() {
        return PeerLetter::EmptyBook;
    }
    let mut last_error: Option<String> = None;
    let mut tried: usize = 0;
    for key in candidates {
        tried += 1;
        match attempt(key) {
            Ok(Some(value)) => {
                return PeerLetter::Opened {
                    value,
                    from_own_address: same_address(key.address, sender),
                    key_address: key.address.to_string(),
                }
            }
            Ok(None) => return PeerLetter::NotOurLetter { key_address: key.address.to_string() },
            Err(e) => last_error = Some(e.to_string()),
        }
    }
    PeerLetter::NoKey { tried, last_error }
}

/// Публичный ключ, записанный В ПОЛЕ отпечатка (след старой добивки).
/// Some — только если строка и есть полный ключ: 64 hex-символа. Короткий
/// отпечаток (`xx:…:****`) ключом не является: сравнивать его с ключом
/// нельзя, иначе восемь байт решают за весь ключ.
pub fn public_key_from_trace(raw: &str) -> Option<String> {
    let v = normalize(raw);
    if v.len() != 64 || !v.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(v)
}

/// Участник — ЭТОТ ЖЕ аккаунт, что и мы. Три пути, и все — про ключ, а не
/// про строку адреса:
///  1. адрес в.Identity (email ∪ алиасы);
///  2. отпечаток в нормальной форме совпал с нашим (стабилен при смене почты);
///  3. в поле `fingerprint` лежит НАШ публичный ключ целиком — след старой
///     добивки, которая писала в отпечаток сам ключ.
///
/// ПУНКТ 3 — НЕ «чья угодно запись в peer_keys»: сравнивается именно с ключом
/// текущей пары. Алиасы своего аккаунта тоже хранятся в peer_keys (см.
/// `profiles.js::aliasesOf`), поэтому совпадение с ЛЮБЫМ пиром означало бы
/// «все собеседники — это я».
pub fn member_is_account(
    id: &Identity,
    member_email: &str,
    member_fingerprint: &str,
    own_public_key_hex: &str,
) -> bool {
    id.has_address(member_email)
        || id.has_fingerprint(member_fingerprint)
        || same_public_key(member_fingerprint, own_public_key_hex)
}

/// Кого из участников групп добавить в список контактов.
///
/// Порядок вопросов СТРОГИЙ (урок 24.10 — иначе след чужого ключа перетягивал
/// живой аккаунт к неверному пиру):
///  1. это НЕ наш собственный аккаунт (`member_is_account`);
///  2. такого адреса ещё нет в контактах (сравнение — нормальная форма);
///  3. эта идентичность ещё не представлена другим адресом: отпечаток
///     участника совпадает с отпечатком, вычисленным из ключа известного
///     контакта, либо в поле участника лежит сырой ключ (след старой добивки),
///     который и есть ключ известного контакта.
///
/// Пункт 3 — «контакт-призрак» (X50, 24.10): в составе koanmak@gmail.com со
/// следом ключа, а тот же ключ лежит в peer_keys под vault-msg@ya.ru (пир
/// сменил почту, группы остались со старым адресом). Фронт ставил второй
/// строкой адрес БЕЗ ключа: одна аватарка дважды в списке, а тап по дублю
/// открывал попап «Добавить контакт» вместо чата, который и так был открыт.
///
/// Пустой адрес — не контакт. Возврат — адреса в порядке обхода, без дублей.
pub fn contacts_to_pad<'a>(
    members: &[(&'a str, &'a str)],
    contacts: &[(&'a str, &'a str)],
    id: &Identity,
    own_public_key_hex: &str,
) -> Vec<&'a str> {
    let mut out: Vec<&'a str> = Vec::new();
    for (email, fingerprint) in members {
        if email.is_empty() || member_is_account(id, email, fingerprint, own_public_key_hex) {
            continue;
        }
        if contacts.iter().any(|(c, _)| same_address(c, email)) {
            continue;
        }
        let trace = public_key_from_trace(fingerprint);
        let known = contacts.iter().any(|(_, key)| {
            let key_norm = normalize(key);
            fingerprint_from_public_key(&key_norm)
                .map(|fp| same_fingerprint(&fp, fingerprint))
                .unwrap_or(false)
                || trace.as_deref() == Some(key_norm.as_str())
        });
        if known {
            continue;
        }
        if !out.iter().any(|e| same_address(e, email)) {
            out.push(email);
        }
    }
    out
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

    #[test]
    fn same_public_key_is_full_hex_and_never_empty() {
        let key = "ab".repeat(32);
        assert!(same_public_key(&key.to_uppercase(), &key));
        assert!(same_public_key(&format!(" {key} "), &key));
        assert!(!same_public_key("", ""));
        assert!(
            !same_public_key(&key[..16], &key),
            "префикс ключа — не совпадение: иначе один отпечаток выдавался бы за весь ключ"
        );
    }

    fn pk<'a>(address: &'a str, key: &'a str) -> PeerKey<'a> {
        PeerKey {
            address,
            public_key: key,
            pq_ek: None,
        }
    }

    #[test]
    fn peer_key_candidates_try_the_senders_own_key_first() {
        let book = [pk("bob@ya.ru", "b"), pk("anna@ya.ru", "a"), pk("cz@ya.ru", "c")];
        let got = peer_key_candidates("anna@ya.ru", &book);
        assert_eq!(got.first().map(|k| k.address), Some("anna@ya.ru"));
        assert_eq!(got.len(), 3, "остальные ключи не выбрасываются — они и есть лечение");
    }

    #[test]
    fn peer_key_candidates_ignore_case_of_the_senders_address() {
        // «aaa@ya.ru» по алфавиту раньше «anna@ya.ru»: если сравнение адреса
        // сделать строкой (регистр и обрамление не нормализованы), совпадения
        // нет, ранг у всех одинаковый и победит алфавит — первый кандидат
        // окажется чужим ключом.
        let book = [
            pk("bob@ya.ru", "b"),
            pk("Anna@YA.ru", "a"),
            pk("aaa@ya.ru", "z"),
        ];
        let got = peer_key_candidates("  anna@ya.ru ", &book);
        assert_eq!(got.first().map(|k| k.address), Some("Anna@YA.ru"));
    }

    #[test]
    fn peer_key_candidates_order_the_rest_by_address_not_by_book_order() {
        // Тот же набор, перечитанный в обратном порядке, обязан дать тот же
        // перебор: иначе победитель зависел бы от порядка хранения книги.
        let forward = [pk("a@ya.ru", "k1"), pk("b@ya.ru", "k2"), pk("c@ya.ru", "k3")];
        let backward = [pk("c@ya.ru", "k3"), pk("b@ya.ru", "k2"), pk("a@ya.ru", "k1")];
        let senders = ["z@ya.ru", "z@ya.ru"];
        assert_eq!(
            peer_key_candidates(&senders[0], &forward),
            peer_key_candidates(&senders[1], &backward)
        );
    }

    #[test]
    fn peer_key_candidates_tried_once_per_key_and_never_with_an_empty_one() {
        let book = [
            pk("old@ya.ru", ""),
            pk("me@ya.ru", "same"),
            pk("alias@ya.ru", "SAME"),
            pk("other@ya.ru", "  "),
        ];
        let got = peer_key_candidates("nobody@ya.ru", &book);
        assert_eq!(
            got.iter().map(|k| k.address).collect::<Vec<_>>(),
            vec!["alias@ya.ru"],
            "пустой ключ не кандидат, а один и тот же ключ под двумя адресами пробуется один раз — берётся первый по алфавиту, чтобы выбор не зависел от порядка книги"
        );
    }

    #[test]
    fn peer_key_candidates_are_bounded() {
        let keys: Vec<String> = (0..20).map(|i| format!("k{i:02}")).collect();
        let book: Vec<PeerKey> = (0..20)
            .map(|i| pk("x@ya.ru", keys[i].as_str()))
            .collect();
        // Все адреса одинаковые → сортировка стабильна, но перебор ограничен.
        assert_eq!(
            peer_key_candidates("nobody@ya.ru", &book).len(),
            PEER_KEY_CANDIDATES_MAX
        );
    }

    #[test]
    fn peer_letter_opened_reports_the_address_the_key_lives_under() {
        // Живой случай 31.10: письмо от koanmak@ya.ru открылось ключом,
        // записанным за vault-msg@ya.ru. Успех без адреса-владельца — это
        // «письмо прочитано», но не «это смена почты»: фронт по этому полю
        // решает, делать ли ренейм.
        let book = [pk("vault-msg@ya.ru", "real"), pk("other@ya.ru", "junk")];
        let got = decrypt_with_peer_keys("koanmak@ya.ru", &book, |k| -> Result<Option<String>, String> {
            if k.public_key == "real" {
                Ok(Some(k.public_key.to_string()))
            } else {
                Err("AAD".to_string())
            }
        });
        match got {
            PeerLetter::Opened { value, key_address, from_own_address } => {
                assert_eq!(value, "real", "открыл ключ, записанный за адресом-алиасом");
                assert_eq!(key_address, "vault-msg@ya.ru");
                assert!(!from_own_address, "ключ за чужим адресом — это не обычный путь");
            }
            other => panic!("ожидался Opened, получено {other:?}"),
        }
    }

    #[test]
    fn peer_letter_success_on_the_senders_own_key_is_not_foreign() {
        let book = [pk("Anna@YA.ru", "a"), pk("bob@ya.ru", "b")];
        let got = decrypt_with_peer_keys("anna@ya.ru", &book, |k| -> Result<Option<String>, String> {
            Ok(Some(k.public_key.to_string()))
        });
        match got {
            PeerLetter::Opened { key_address, from_own_address, value, .. } => {
                assert!(from_own_address, "адрес в книге тот же человек в другой регистрацией — не чужой ящик");
                assert_eq!(key_address, "Anna@YA.ru");
                assert_eq!(value, "a", "первым пробуется ключ самого отправителя");
            }
            other => panic!("ожидался Opened, получено {other:?}"),
        }
    }

    #[test]
    fn peer_letter_stops_on_a_key_that_opened_a_foreign_letter() {
        // Тело открылось — значит ключ верный, а письмо чужое (не vault-конверт).
        // Идти дальше было бы «угадыванием» чужим ключом и подменой диагноза.
        let book = [pk("a@ya.ru", "k1"), pk("b@ya.ru", "k2")];
        let mut tried: Vec<String> = Vec::new();
        let got = decrypt_with_peer_keys("nobody@ya.ru", &book, |k| {
            tried.push(k.public_key.to_string());
            Ok::<Option<String>, String>(None)
        });
        assert_eq!(got, PeerLetter::NotOurLetter { key_address: "a@ya.ru".to_string() });
        assert_eq!(tried, vec!["k1".to_string()], "перебор остановлен на верном ключе");
    }

    #[test]
    fn peer_letter_no_key_counts_attempts_and_keeps_the_last_error() {
        let book = [pk("a@ya.ru", "k1"), pk("b@ya.ru", "k2")];
        let got = decrypt_with_peer_keys("nobody@ya.ru", &book, |k| {
            Err::<Option<String>, String>(format!("AAD under {}", k.address))
        });
        match got {
            PeerLetter::NoKey { tried, last_error } => {
                assert_eq!(tried, 2, "испытуемых ключей столько, сколько кандидатов в книге");
                assert_eq!(last_error.as_deref(), Some("AAD under b@ya.ru"));
            }
            other => panic!("ожидался NoKey, получено {other:?}"),
        }
    }

    #[test]
    fn peer_letter_empty_book_never_attempts() {
        let mut attempts = 0;
        let got = decrypt_with_peer_keys("nobody@ya.ru", &[], |k| {
            attempts += 1;
            Ok::<Option<String>, String>(Some(k.public_key.to_string()))
        });
        assert_eq!(got, PeerLetter::EmptyBook);
        assert_eq!(attempts, 0, "книга без ключей — не повод что-то расшифровывать «вслепую»");
    }

    #[test]
    fn public_key_from_trace_takes_only_full_hex_key() {
        let key = "ab".repeat(32);
        assert_eq!(public_key_from_trace(&key.to_uppercase()).as_deref(), Some(&key[..]));
        assert_eq!(public_key_from_trace(&format!(" {key} ")).as_deref(), Some(&key[..]));
        // Короткий отпечаток — НЕ ключ: восемь байт не решают за весь ключ.
        assert_eq!(public_key_from_trace("9c:ad:cd:4d:7d:bf:26:33:****"), None);
        assert_eq!(public_key_from_trace(&key[..16]), None);
        assert_eq!(public_key_from_trace(""), None);
    }

    #[test]
    fn member_is_account_recognises_own_key_left_in_fingerprint() {
        // Живой случай 24.10 (X50, groups.json): сессия koanmak@ya.ru, в
        // составе koanmak@gmail.com, а в fingerprint — публичный ключ десктопа
        // целиком (след старой добивки). Это СВОЙ аккаунт, не контакт.
        let own = format!("9cadcd4d7dbf2633{}", "00".repeat(24));
        let own_fp = "9c:ad:cd:4d:7d:bf:26:33:****";
        let me = Identity::new("koanmak@ya.ru", &[], "2b:e1:c9:30:d1:b9:1b:85:****");
        assert!(member_is_account(&me, "koanmak@gmail.com", &own, &own));
        // Настоящая форма отпечатка (её пишет backfill по computed fp) —
        // тот же человек, даже под чужим на вид адресом.
        let me_fp = Identity::new("koanmak@ya.ru", &[], own_fp);
        assert!(
            member_is_account(&me_fp, "someone@else.org", own_fp, &own),
            "настоящая форма отпечатка тоже опознаёт своего"
        );
        // Чужой ключ/чужой отпечаток — не мы.
        let anna = format!("c73ce55a9f7b466f{}", "00".repeat(24));
        assert!(!member_is_account(&me, "icemaksim@gmail.com", &anna, &own));
        assert!(!member_is_account(
            &me,
            "icemaksim@gmail.com",
            "c7:3c:e5:5a:9f:7b:46:6f:****",
            &own
        ));
        // Пустые значения — не совпадение (иначе безключевой участник
        // складывался бы в каждого второго).
        assert!(!member_is_account(&me, "x@y.zz", "", &own));
        assert!(!member_is_account(
            &me,
            "",
            "c7:3c:e5:5a:9f:7b:46:6f:****",
            &own
        ));
        let no_key = Identity::new("x@y.zz", &[], "");
        assert!(!member_is_account(&no_key, "q@w.ee", "", ""));
    }

    #[test]
    fn member_is_account_never_claims_a_foreign_peer_by_alias_entry() {
        // Алиасы своего аккаунта живут в peer_keys наравне с чужими ключами:
        // правило обязано сверять с КЛЮЧОМ ПАРЫ, а не со «есть ли такой пир».
        let own = format!("9cadcd4d7dbf2633{}", "00".repeat(24));
        let me = Identity::new("koanmak@gmail.com", &["vault-msg@ya.ru".to_string()], "");
        assert!(
            member_is_account(&me, " VAULT-MSG@YA.RU ", "", &own),
            "алиас — свой адрес"
        );
        assert!(
            !member_is_account(
                &me,
                "koanmak@ya.ru",
                &format!("2be1c930d1b91b85{}", "00".repeat(24)),
                &own
            ),
            "ключ другого человека под своим алиасом не делает его мной"
        );
    }

    // ── contacts_to_pad: кого звать в список контактов из состава групп ──

    const OWN: &str = "2be1c930d1b91b85000000000000000000000000000000000000000000000000";
    const DESKTOP: &str = "9cadcd4d7dbf2633000000000000000000000000000000000000000000000000";
    const ANNA: &str = "c73ce55a9f7b466f000000000000000000000000000000000000000000000000";

    fn me_id() -> Identity {
        Identity::new("koanmak@ya.ru", &[], "2b:e1:c9:30:d1:b9:1b:85:****")
    }

    #[test]
    fn contacts_to_pad_skips_self_known_address_and_ghost() {
        // Живые данные X50 (24.10). Контакт: пир под новым адресом.
        let contacts = [("vault-msg@ya.ru", DESKTOP), ("icemaksim@gmail.com", ANNA)];
        let members = [
            ("koanmak@ya.ru", OWN),                   // это мы
            ("koanmak@gmail.com", DESKTOP),           // след = ключ известного пира
            ("icemaksim@gmail.com", ""),              // адрес уже в списке
            ("kmakan@zoho.com", ""),                  // новый собеседник
            ("", ""),                                 // пустого адреса нет
        ];
        assert_eq!(
            contacts_to_pad(&members, &contacts, &me_id(), OWN),
            vec!["kmakan@zoho.com"],
            "в добивке остаётся только тот, кого в списке ещё нет"
        );
    }

    #[test]
    fn contacts_to_pad_recognises_identity_by_computed_fingerprint() {
        // Не след, а настоящий отпечаток участника: он совпадает с
        // отпечатком, вычисленным из ключа известного контакта.
        let contacts = [("peer-new@mail.ru", ANNA)];
        let members = [("peer-old@mail.ru", "c7:3c:e5:5a:9f:7b:46:6f:****")];
        assert_eq!(
            contacts_to_pad(&members, &contacts, &me_id(), OWN),
            Vec::<&str>::new(),
            "тот же человек под другим адресом — не новый контакт"
        );
    }

    #[test]
    fn contacts_to_pad_address_beats_foreign_trace() {
        // Урок 24.10: адрес сильнее следа. Адрес участника уже в контактах с
        // ДРУГИМ ключом — вторая строка не появляется, даже если в поле
        // участника лежит чужой ключ. Форма адреса (регистр, обрамление)
        // тоже не плодит дубль.
        let contacts = [("ivan@post.ru", ANNA)];
        let members = [
            ("ivan@post.ru", DESKTOP),
            (" Ivan@Post.RU ", ""),
            (" PETR@post.ru ", ""),
        ];
        assert_eq!(
            contacts_to_pad(&members, &contacts, &me_id(), OWN),
            vec![" PETR@post.ru "],
            "известный адрес не дублируется из-за следа и написания"
        );
    }

    #[test]
    fn contacts_to_pad_compares_the_whole_key_not_its_prefix() {
        // Совпадение первых 16 hex — это совпадение ОТПЕЧАТКА, а отпечаток
        // не решает за весь ключ: два разных пира с общим префиксом не должны
        // сливаться в одного (иначе второй исчезает из списка).
        let twin = format!("c73ce55a9f7b466f{}", "11".repeat(24));
        let contacts = [("other-peer@mail.ru", twin.as_str())];
        let members = [("ghost@mail.ru", ANNA)];
        assert_eq!(
            contacts_to_pad(&members, &contacts, &me_id(), OWN),
            vec!["ghost@mail.ru"],
            "префикс чужого ключа не делает участника известным"
        );
    }

    #[test]
    fn contacts_to_pad_lists_one_address_once_per_several_groups() {
        let members = [("petr@post.ru", ""), ("PETR@POST.RU", "")];
        assert_eq!(
            contacts_to_pad(&members, &[], &me_id(), OWN),
            vec!["petr@post.ru"],
            "один человек в двух группах — одна строка"
        );
    }

    #[test]
    fn contacts_to_pad_never_pads_our_own_alias_account() {
        // Свой аккаунт под другим адресом (алиас) — не контакт.
        let me = Identity::new("koanmak@ya.ru", &["koanmak@gmail.com".to_string()], "");
        let members = [("koanmak@gmail.com", "")];
        assert_eq!(
            contacts_to_pad(&members, &[], &me, OWN),
            Vec::<&str>::new(),
            "алиас своей сессии в добивку не идёт"
        );
    }

    fn dict(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(f, t)| (f.to_string(), t.to_string()))
            .collect()
    }

    #[test]
    fn peer_is_self_takes_key_not_string_equality() {
        let own = "ab".repeat(32);
        let id = Identity::new("me@post.ru", &["me@ya.ru".to_string()], "");
        assert!(
            peer_is_self(&id, "me@YA.RU", &own.to_uppercase(), &own),
            "ключ в верхнем регистре — тот же ключ: прежняя строка `==` пропускала себя в контакты"
        );
        assert!(
            peer_is_self(&id, "me@post.ru", "", ""),
            "наш адрес остаётся нашим, даже если ключ записи пуст"
        );
        assert!(
            peer_is_self(&id, "anna@post.ru", &own, &own),
            "наш ключ под чужим адресом — всё равно мы: peer_store общий на машину, \
             и мост не обязан знать адрес, под которым легла наша запись"
        );
        let peer = "cd".repeat(32);
        assert!(
            !peer_is_self(&id, "anna@post.ru", &peer, &own),
            "чужой ключ под чужим адресом — не я"
        );
        assert!(
            !peer_is_self(&id, "", "", ""),
            "пустой ключ не совпадает ни с чем, включая пустой наш"
        );
    }

    #[test]
    fn address_variants_starts_with_the_address_itself() {
        let variants = address_variants(&[], "Petr@Post.RU");
        assert_eq!(
            variants,
            vec!["petr@post.ru"],
            "без словаря вариант ровно один, в нормальной форме"
        );
        assert!(address_variants(&[], "").is_empty(), "пустой адрес — не адрес");
        assert!(address_variants(&[], "   ").is_empty());
    }

    #[test]
    fn address_variants_walks_the_chain_to_the_fresh_address() {
        let d = dict(&[("a@x", "b@x"), ("b@x", "c@x")]);
        assert_eq!(
            address_variants(&d, "a@x"),
            vec!["a@x", "b@x", "c@x"],
            "две смены подряд: ключ лежит под свежим адресом"
        );
    }

    #[test]
    fn address_variants_stops_on_a_cycle_instead_of_hanging() {
        // Словарь {A:B, B:A} от смены A→B→A: резолв не должен ходить по кругу.
        let d = dict(&[("a@x", "b@x"), ("b@x", "a@x")]);
        assert_eq!(address_variants(&d, "a@x"), vec!["a@x", "b@x"]);
        let empty_new = dict(&[("a@x", "")]);
        assert_eq!(
            address_variants(&empty_new, "a@x"),
            vec!["a@x"],
            "пустой новый адрес не форма пира"
        );
    }

    #[test]
    fn address_variants_adds_stale_addresses_of_the_same_peer() {
        // Строка списка/письма осталась СТАРОЙ, ключ переехал на новый адрес:
        // тап по старому должен найти ключ по новому — иначе вместо чата
        // показывается попап «Добавить контакт» (случай X50, 24.10).
        let d = dict(&[("old@x", "new@x")]);
        assert_eq!(
            address_variants(&d, "new@x"),
            vec!["new@x", "old@x"],
            "старый адрес — второй вариант, порядок решает быстрый путь"
        );
        assert_eq!(
            address_variants(&d, "OLD@x"),
            vec!["old@x", "new@x"],
            "регистр и обрамление не значимы"
        );
    }

    #[test]
    fn address_variants_uses_only_pairs_of_this_peer() {
        // Словарь — общий на аккаунт: в нём записи обо ВСЕХ переименованных
        // пирах. Варианты одного не имеют права тянуть чужие адреса, иначе
        // `peerContactFor` подставит в чат ключ постороннего.
        let d = dict(&[("a@x", "b@x"), ("c@x", "d@x")]);
        assert_eq!(address_variants(&d, "e@x"), vec!["e@x"]);
        assert_eq!(address_variants(&d, "b@x"), vec!["b@x", "a@x"]);
    }

    #[test]
    fn address_variants_reads_a_dirty_dictionary() {
        // Ключи `email-aliases` приходят из kv как их записали (фронт словарь
        // не причесывает), поэтому нормализация — обязанность правила, а не
        // вызывающего: иначе пара «Old@X → New@X» не находится и тап по
        // известному адресу открывает попап «Добавить контакт».
        let d = dict(&[(" Old@X ", "New@X")]);
        assert_eq!(
            address_variants(&d, "old@x"),
            vec!["old@x", "new@x"],
            "грязный ключ словаря всё равно ведёт к свежему адресу"
        );
        assert_eq!(
            address_variants(&d, "new@x"),
            vec!["new@x", "old@x"],
            "обратный ход ищет по нормализованному значению, а не по сырому"
        );
    }

    #[test]
    fn resolve_alias_returns_the_fresh_address_or_the_normal_form() {
        let d = dict(&[("a@x", "b@x"), ("b@x", "c@x")]);
        assert_eq!(resolve_alias(&d, "a@x"), "c@x", "две смены подряд — конец цепочки");
        assert_eq!(resolve_alias(&d, "c@x"), "c@x", "свежий адрес резолвится в себя");
        assert_eq!(resolve_alias(&[], "Petr@Post.RU"), "petr@post.ru");
        assert_eq!(resolve_alias(&[], ""), "", "пустой адрес — не адрес");
        assert_eq!(resolve_alias(&[], "   "), "");
        let empty_key = dict(&[("", "x@x")]);
        assert_eq!(
            resolve_alias(&empty_key, ""),
            "",
            "пустой адрес не резолвится даже при записи с пустым ключом"
        );
    }

    #[test]
    fn resolve_alias_reads_a_dirty_dictionary() {
        // Та же обязанность, что у `address_variants`: смена почты пишется из
        // письма, где адрес мог прийти с обрамлением и в верхнем регистре.
        let d = dict(&[(" Old@X ", "New@X")]);
        assert_eq!(resolve_alias(&d, "OLD@x"), "new@x");
        assert_eq!(resolve_alias(&d, " new@x "), "new@x");
    }

    #[test]
    fn resolve_alias_stops_on_a_cycle_like_the_variants() {
        // Смена A→B→A: обе строки словаря разрешаются в соседа, а не в
        // бесконечность; ответ совпадает с обходом `address_variants`.
        let d = dict(&[("a@x", "b@x"), ("b@x", "a@x")]);
        assert_eq!(resolve_alias(&d, "a@x"), "b@x");
        assert_eq!(resolve_alias(&d, "b@x"), "a@x");
        let empty_new = dict(&[("a@x", "")]);
        assert_eq!(
            resolve_alias(&empty_new, "a@x"),
            "a@x",
            "пустой новый адрес не резолвит никуда"
        );
    }

    #[test]
    fn is_own_address_resolves_the_sender_and_compares_normal_forms() {
        let d = dict(&[("old@me", "new@me")]);
        assert!(
            is_own_address(&[], "Me@Post.RU", " me@post.ru "),
            "форма адреса одна: регистр и обрамление не делают письмо чужим"
        );
        assert!(
            is_own_address(&d, "New@Me", "OLD@me"),
            "письмо старого нашего адреса после смены — всё ещё наше"
        );
        assert!(!is_own_address(&[], "me@post.ru", "anna@post.ru"));
        assert!(!is_own_address(&[], "me@post.ru", ""));
        assert!(
            !is_own_address(&[], "", ""),
            "пустой отправитель не совпадает и с пустым нашим"
        );
        assert!(
            is_own_address(&[], "Иван@Почта.РФ", "иван@почта.рф"),
            "кириллица понижается по Юникоду, а не по ASCII"
        );
    }

    #[test]
    fn is_own_address_follows_a_two_hop_chain_and_stops_on_a_cycle() {
        let two = dict(&[("a@x", "b@x"), ("b@x", "me@x")]);
        assert!(
            is_own_address(&two, "me@x", "a@x"),
            "две смены подряд доводят старое письмо до нашего адреса"
        );
        let cycle = dict(&[("a@x", "b@x"), ("b@x", "a@x")]);
        assert!(!is_own_address(&cycle, "me@x", "a@x"));
        assert!(
            is_own_address(&cycle, "b@x", "a@x"),
            "цикл обрывается на соседе, как у resolve_alias"
        );
    }

    #[test]
    fn alias_resolutions_precompute_the_chain_end_for_every_stale_address() {
        let d = dict(&[(" A@X ", "B@X"), ("b@x", "c@x")]);
        assert_eq!(
            alias_resolutions(&d),
            vec![
                ("a@x".to_string(), "c@x".to_string()),
                ("b@x".to_string(), "c@x".to_string()),
            ],
            "обе старые строки ведут к одному свежему адресу, ключи нормализованы"
        );
    }

    #[test]
    fn alias_resolutions_skips_pairs_that_change_nothing() {
        let d = dict(&[("a@x", ""), ("b@x", "b@x"), ("c@x", "d@x"), (" c@x ", "d@x")]);
        assert_eq!(
            alias_resolutions(&d),
            vec![("c@x".to_string(), "d@x".to_string())],
            "пустые цели и самоссылки не резолвят, повтор ключа не плодит строк"
        );
        assert!(alias_resolutions(&[]).is_empty());
    }

    #[test]
    fn alias_resolutions_follows_a_cycle_without_looping() {
        let d = dict(&[("a@x", "b@x"), ("b@x", "a@x")]);
        assert_eq!(
            alias_resolutions(&d),
            vec![
                ("a@x".to_string(), "b@x".to_string()),
                ("b@x".to_string(), "a@x".to_string()),
            ],
            "цикл остаётся виден разрешением на соседа, как у resolve_alias"
        );
    }

    #[test]
    fn alias_pairs_after_remember_adds_the_normalized_pair() {
        let d = dict(&[(" X@X ", "Y@X")]);
        assert_eq!(
            alias_pairs_after_remember(&d, " Old@X ", "New@X"),
            dict(&[("x@x", "y@x"), ("old@x", "new@x")]),
            "новая пара дописана, чужие записи нормализованы, а не тронуты"
        );
    }

    #[test]
    fn alias_pairs_after_remember_overwrites_the_old_key() {
        let d = dict(&[("a@x", "b@x"), ("a@x", "c@x")]);
        assert_eq!(
            alias_pairs_after_remember(&d, "a@x", "d@x"),
            vec![("a@x".to_string(), "d@x".to_string())],
            "по одному ключу остаётся одно направление смены"
        );
    }

    #[test]
    fn alias_pairs_after_remember_drops_the_stale_reverse_entry() {
        // Смена B→A, потом A→B: запись {B:A} сделала бы карту {A:B, B:A} и
        // зациклила резолв. Текущий адрес не может сам быть алиасом.
        let d = dict(&[("b@x", "a@x"), ("x@x", "y@x")]);
        assert_eq!(
            alias_pairs_after_remember(&d, "a@x", "b@x"),
            dict(&[("x@x", "y@x"), ("a@x", "b@x")]),
            "запись, где ключ — свежий адрес, убрана; чужая пара осталась"
        );
    }

    #[test]
    fn alias_pairs_after_remember_is_idempotent() {
        let d = dict(&[("a@x", "b@x")]);
        let once = alias_pairs_after_remember(&d, "a@x", "b@x");
        let twice = alias_pairs_after_remember(&once, "a@x", "b@x");
        assert_eq!(once, twice, "повторная смена не плодит записей");
    }

    #[test]
    fn alias_pairs_after_remember_ignores_empty_and_equal_changes() {
        let d = dict(&[("a@x", "b@x")]);
        assert_eq!(alias_pairs_after_remember(&d, "", "b@x"), d);
        assert_eq!(alias_pairs_after_remember(&d, "a@x", ""), d);
        assert_eq!(
            alias_pairs_after_remember(&d, " A@X ", "a@x"),
            d,
            "смена на тот же адрес ничего не добавляет"
        );
    }

    #[test]
    fn remember_then_resolve_reads_the_same_dictionary() {
        // Запись и чтение — одно правило: после `alias_pairs_after_remember`
        // `resolve_alias` обязан вести по свежему адресу, включая цепочку из
        // двух смен подряд.
        let first = alias_pairs_after_remember(&[], "a@x", "b@x");
        let second = alias_pairs_after_remember(&first, "b@x", "c@x");
        assert_eq!(resolve_alias(&second, "a@x"), "c@x");
        assert_eq!(second.len(), 2);
    }
}
