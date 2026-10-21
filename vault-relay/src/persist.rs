//! Персист «тихих» карт релея: привязки FCM-токенов и рингтоны звонка.
//!
//! Историческая боль (задача t_44e210b4): обе карты жили только в памяти
//! (`AppState::topic_fcm` / `topic_ringtone`). Рестарт релея их обнулял:
//!  - FCM: клиент не перерегистрировался (кэш «уже зарегистрированы» в prefs
//!    переживал рестарт), а на проде `VAULT_RELAY_NTFY_URL` не задан — ветка
//!    «нечем будить» молчала, wake-канал был мёртв целиком;
//!  - рингтон: кастомный звук звонка слетал на дефолтный.
//!
//! Формат — один JSON-документ (путь из `VAULT_RELAY_STATE`, дефолт
//! `./vault-relay-state.json` в WorkingDirectory сервиса). Запись атомарная:
//! temp-файл + `rename(2)` — оборванный рестарт/креш не оставит битый файл.
//! Отсутствие или битый файл НЕ фатальны: релей стартует с пустыми картами
//! (как раньше) и чинит их первым же /relay/fcm/register.
//!
//! TTL/чистка по времени НЕ вводится намеренно: запись привязки бессмертна
//! ровно до следующей регистрации того же токена ( Firebase сам ротирует
//! reg_token и клиент перерегистрируется), а «протухшая» привязка безвредна —
//! отправка по ней вернёт ошибку FCM, конверт останется в очереди. Вместо
//! TTL работают два других механизма: (1) фильтрация битых записей при загрузке
//! (sanitize), (2) удаление привязки, когда FCM ответил UNREGISTERED
//! (токен сгорел — хранить его бессмысленно).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Переменная окружения с путём к файлу состояния.
pub const ENV_STATE_PATH: &str = "VAULT_RELAY_STATE";
/// Файл состояния по умолчанию (WorkingDirectory сервиса).
pub const DEFAULT_STATE_FILE: &str = "vault-relay-state.json";
/// Актуальная версия формата (v=1 — первая).
const STATE_VERSION: u32 = 1;
/// Мягкий потолок числа записей. Карта растёт на РОТАЦИЮ токена/устройства
/// (каждая выдача read-токена = новая тема), то есть медленно; потолок —
/// страховка от бесконечного роста файла при злоупотреблении /relay/register.
const MAX_ENTRIES: usize = 50_000;

/// Что переживает рестарт релея. Всё остальное (очереди конвертов,
/// last_seen, счётчики) намеренно остаётся in-memory: конверты клиент
/// добудет по почте, счётчики обнуление переживают тривиально.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedState {
    /// Версия формата (на будущее — миграции).
    #[serde(default)]
    pub v: u32,
    /// unix-сек последней записи (диагностика: «релей писал state»).
    #[serde(default)]
    pub saved_at: u64,
    /// hash(read-токен) → FCM reg_token (получатель, которого будим через FCM).
    #[serde(default)]
    pub topic_fcm: HashMap<String, String>,
    /// hash(read-токен) → URL mp3 рингтона входящего звонка.
    #[serde(default)]
    pub topic_ringtone: HashMap<String, String>,
    /// fp аккаунта → выданный ему read-токен. Даёт СТАБИЛЬНОСТЬ адреса
    /// очереди: повторная регистрация с тем же fp возвращает тот же токен.
    #[serde(default)]
    pub fp_tokens: HashMap<String, FpToken>,
    /// ADR-002: kid канала (как строка) → публичный ключ подписи
    /// владельца + hash ЕГО ЛИЧНОГО токена. Пусто = все каналы в
    /// режиме v1 (миграция), поведение прежнее.
    #[serde(default)]
    pub channel_keys: HashMap<String, crate::channel_keys::Entry>,
    /// hash(токена) → fingerprint аккаунта: токен привязан к одному
    /// аккаунту (защита от шаринга платного токена).
    ///
    /// ПЕРСИСТ — НЕ опция, а условие: при in-memory привязке после рестарта
    /// релея токен обнулялся, и первый же использовавший получал его в
    /// собственную привязку. Для бесплатных токенов это терпимо (выдача
    /// возобновляется), для платных — нет: купленный Pro не должен
    /// отвязываться из-за рестарта сервиса.
    #[serde(default)]
    pub token_bindings: HashMap<String, String>,
    /// Подписки: id подписки → оплаченный план. Ключ — внешний идентификатор
    /// покупки (checkout), значение — состояние плана.
    #[serde(default)]
    pub subscriptions: HashMap<String, Subscription>,
    /// Устройства подписки: id подписки → hash'ы выданных ей токенов.
    ///
    /// Один токен — одно устройство, поэтому лимит устройств считается по
    /// ЧИСЛУ ТОКЕНОВ этой подписки. Персист обязателен: рестарт релея не
    /// должен обнулять лимит (иначе после рестарта можно было бы навесить
    /// unlimited устройств на один Pro).
    #[serde(default)]
    pub sub_tokens: HashMap<String, Vec<String>>,
}

/// Состояние оплаченной подписки.
///
/// Поля — контракт с платёжным провайдером и с клиентом: план, до какого
/// оплачено, и не отозвана ли подписка.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subscription {
    /// Тариф: "free" | "pro" (см. vault_relay::tokens::Plan).
    #[serde(default)]
    pub plan: String,
    /// fingerprint покупателя: по нему проверяется «у этого аккаунта уже есть
    /// активная подписка» (второй чекаут не нужен) и что верифицирующий чекаут
    /// — свой, а не чужой.
    #[serde(default)]
    pub fp: String,
    /// unix-сек, до какого оплачен план (0 = без срока).
    #[serde(default)]
    pub paid_until: u64,
    /// Подписка отозвана (возврат/отмена) — токены подписки не работают.
    #[serde(default)]
    pub revoked: bool,
}

/// Запись «fp аккаунта → выданный ему read-токен».
///
/// Инцидент 12.10.2026: адрес очереди МЕНЯЛСЯ. Миграция kv на fp-namespace
/// теряла `relay-list` (свой `myToken`), клиент честно перерегистрировался,
/// `/relay/register` выдавал НОВЫЙ токен — и собеседники, знающие старый
/// адрес, молча теряли канал (вызовы уходили в мёртвую очередь). Теперь
/// выдача идемпотентна по fp: повторная регистрация возвращает ТОТ ЖЕ токен.
/// Смена токена возможна только осознанно — выдача тестового (промо) или
/// платного вида.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FpToken {
    /// read-токен = адрес очереди получателя.
    pub token: String,
    /// Вид токена: "install" | "test" | "paid" (vault_relay::tokens::Kind).
    #[serde(default)]
    pub kind: String,
    /// unix-сек истечения записи: протухшую не переиспользуем.
    #[serde(default)]
    pub exp: u32,
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// reg_token в том же словаре, что и на входе /relay/fcm/register.
/// Дублирует нормировку хендлера намеренно (тот живёт в бинарнике): при
/// загрузке мусорный токен обязан отфильтроваться ДО того, как попадёт
/// в FCM-запрос.
fn valid_reg_token(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 4096
        && v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.' | '~' | '%'))
}

/// URL рингтона — тот же фильтр, что norm_ringtone в main.rs.
fn valid_ringtone(v: &str) -> bool {
    v.trim().starts_with("http")
}

/// Тема = hex(mac) — 64 hex-символа. Ключи не-hex отбрасываем: это защита
/// от мусора в state.json.
fn valid_topic(v: &str) -> bool {
    v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit())
}

/// fp аккаунта: hex-байты через ':'. Не пустой, ограниченной длины, без
/// пробелов/управляющих символов (защита от мусора и от ключей-«полотенец»).
fn valid_fp(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'-' | b'_'))
}

/// read-токен в state.json: base64url (без '='), ограниченной длины.
fn valid_token(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
impl PersistedState {
    /// Снимок текущих in-memory карт.
    pub fn snapshot(
        topic_fcm: &HashMap<String, String>,
        topic_ringtone: &HashMap<String, String>,
        fp_tokens: &HashMap<String, FpToken>,
        channel_keys: &HashMap<String, crate::channel_keys::Entry>,
        token_bindings: &HashMap<String, String>,
        subscriptions: &HashMap<String, Subscription>,
        sub_tokens: &HashMap<String, Vec<String>>,
    ) -> Self {
        Self {
            v: STATE_VERSION,
            saved_at: now_unix(),
            topic_fcm: topic_fcm.clone(),
            topic_ringtone: topic_ringtone.clone(),
            fp_tokens: fp_tokens.clone(),
            channel_keys: channel_keys.clone(),
            token_bindings: token_bindings.clone(),
            subscriptions: subscriptions.clone(),
            sub_tokens: sub_tokens.clone(),
        }
    }

    /// Прочитать состояние. Нет файла / битый JSON → пустое состояние + запись
    /// в лог: релей обязан подняться в любом случае.
    pub fn load(path: &Path) -> Self {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::info!(path = %path.display(), "state: file not found, starting empty");
                return Self::default();
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "state: unreadable, starting empty");
                return Self::default();
            }
        };
        match serde_json::from_str::<Self>(&text) {
            Ok(mut st) => {
                let (f, r) = (st.topic_fcm.len(), st.topic_ringtone.len());
                let fps = st.fp_tokens.len();
                st.sanitize();
                tracing::info!(
                    path = %path.display(), v = st.v, fcm = f, ringtone = r, fp = fps,
                    kept_fcm = st.topic_fcm.len(), kept_ringtone = st.topic_ringtone.len(),
                    kept_fp = st.fp_tokens.len(),
                    "state: loaded"
                );
                st
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "state: broken json, starting empty");
                Self::default()
            }
        }
    }

    /// Отбросить битые записи (тема не hex / токен или URL невалидны) и
    /// ужать до потолка, если карта разрослась.
    fn sanitize(&mut self) {
        self.topic_fcm.retain(|k, v| valid_topic(k) && valid_reg_token(v));
        self.topic_ringtone.retain(|k, v| valid_topic(k) && valid_ringtone(v));
        self.fp_tokens
            .retain(|k, v| valid_fp(k) && valid_token(&v.token));
        // Битая запись о канале хуже, чем её отсутствие: без неё канал
        // работает в режиме v1 (миграция), с ней — публикация падает.
        // Требуем только hex-форму (64 символа): строгую проверку точки
        // делает verify_strict в момент verify (dalek 2.1 принимает почти
        // любую 32-байтовую строку в from_bytes — проверять «кривую» здесь
        // значило бы врать).
        self.channel_keys.retain(|k, v| {
            k.parse::<u64>().is_ok()
                && v.pubkey.len() == 64
                && v.pubkey.chars().all(|c| c.is_ascii_hexdigit())
        });
        for map in [&mut self.topic_fcm, &mut self.topic_ringtone] {
            if map.len() > MAX_ENTRIES {
                let extra = map.len() - MAX_ENTRIES;
                let drop: Vec<String> = map.keys().take(extra).cloned().collect();
                for k in drop {
                    map.remove(&k);
                }
                tracing::warn!(dropped = extra, "state: entries over cap dropped");
            }
        }
        if self.fp_tokens.len() > MAX_ENTRIES {
            let extra = self.fp_tokens.len() - MAX_ENTRIES;
            let drop: Vec<String> = self.fp_tokens.keys().take(extra).cloned().collect();
            for k in drop {
                self.fp_tokens.remove(&k);
            }
            tracing::warn!(dropped = extra, "state: fp entries over cap dropped");
        }
    }

    /// Сохранить атомарно: пишем `<path>.tmp`, fsync, затем `rename` в
    /// `<path>` (rename атомарен в пределах ФС → читатель видит либо старый,
    /// либо новый файл, но не половину). Каталог тоже fsync'им, иначе после
    /// креша может «потеряться» сам rename.
    pub fn save_atomic(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir).map_err(|e| format!("create_dir_all: {e}"))?;
            }
        }
        let json = serde_json::to_string(self).map_err(|e| format!("serialize: {e}"))?;
        let mut tmp = path.as_os_str().to_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
            f.write_all(json.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
            f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
            // 0600: в файле лежат reg_token'ы (адреса доставки).
            set_private_mode(&tmp);
        }
        std::fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                if let Ok(d) = std::fs::File::open(dir) {
                    let _ = d.sync_all(); // лучше с ошибкой, чем потерянный rename
                }
            }
        }
        Ok(())
    }
}

fn set_private_mode(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// Путь к файлу состояния: `VAULT_RELAY_STATE` (пусто/unset → дефолт рядом
/// с WorkingDirectory). Явное «off»/«none»/«0» — персист выключен (тесты,
/// dev-машины без диска): тогда `None`.
pub fn state_path_from_env() -> Option<PathBuf> {
    match std::env::var(ENV_STATE_PATH) {
        Ok(v) => state_path_from_raw(Some(&v)),
        Err(_) => state_path_from_raw(None),
    }
}

/// Чистое ядро разбора пути (вынесено отдельно, чтобы юниты не дёргали
/// общий env процесса — cargo test гоняет их параллельно).
pub fn state_path_from_raw(v: Option<&str>) -> Option<PathBuf> {
    match v {
        None => Some(PathBuf::from(DEFAULT_STATE_FILE)),
        Some(v) => {
            let v = v.trim();
            if v.is_empty() {
                Some(PathBuf::from(DEFAULT_STATE_FILE))
            } else if matches!(v, "off" | "none" | "0" | "disabled") {
                None
            } else {
                Some(PathBuf::from(v))
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// ПРИВЯЗКА ТОКЕНА ПЕРЕЖИВАЕТ РЕСТАРТ.
    ///
    /// Это не «красиво», а условие: купленный Pro-токен не должен
    /// отвязываться из-за рестарта релея (иначе первый же использовавший
    /// перехватил бы его в свою привязку — тихо, без ошибки).
    #[test]
    fn test_token_bindings_survive_restart() {
        let path = tmp_path("bindings");
        let mut bindings = HashMap::new();
        bindings.insert("hash-token-1".to_string(), "fp-alice".to_string());
        let mut subs = HashMap::new();
        subs.insert(
            "checkout-77".to_string(),
            Subscription {
                plan: "pro".to_string(),
                fp: "fp-alice".to_string(),
                paid_until: 1_800_000_000,
                revoked: false,
            },
        );
        let st = PersistedState::snapshot(
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &bindings,
            &subs,
            &HashMap::new(),
        );
        st.save_atomic(&path).expect("state saved");
        let loaded = PersistedState::load(&path);
        assert_eq!(
            loaded.token_bindings.get("hash-token-1").map(|s| s.as_str()),
            Some("fp-alice"),
            "привязка токена обязана пережить рестарт релея"
        );
        let sub = loaded.subscriptions.get("checkout-77").expect("подписка сохранена");
        assert_eq!(sub.plan, "pro");
        assert_eq!(sub.paid_until, 1_800_000_000);
        assert!(!sub.revoked);
        let _ = std::fs::remove_file(&path);
    }

    /// Старый файл состояния (без новых полей) читается без паники: поля
    /// помечены serde(default), поэтому рестарт релея после деплоя не теряет
    /// остальное состояние.
    #[test]
    fn test_old_state_file_without_new_fields_loads() {
        let path = tmp_path("oldstate");
        std::fs::write(&path, r#"{"v":1,"saved_at":1}"#).expect("старый файл записан");
        let loaded = PersistedState::load(&path);
        assert!(loaded.token_bindings.is_empty());
        assert!(loaded.subscriptions.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    /// Отозванная подписка остаётся отозванной после перезагрузки — отзыв не
    /// должен «смываться» рестартом.
    #[test]
    fn test_revoked_subscription_stays_revoked() {
        let path = tmp_path("revoked");
        let mut subs = HashMap::new();
        subs.insert(
            "checkout-9".to_string(),
            Subscription {
                plan: "pro".to_string(),
                fp: "fp-alice".to_string(),
                paid_until: 1_800_000_000,
                revoked: true,
            },
        );
        let st = PersistedState::snapshot(
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &subs,
            &HashMap::new(),
        );
        st.save_atomic(&path).expect("state saved");
        let loaded = PersistedState::load(&path);
        assert!(loaded.subscriptions["checkout-9"].revoked, "отзыв обязан пережить рестарт");
        let _ = std::fs::remove_file(&path);
    }

    fn tmp_path(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir()
            .join(format!("vault-relay-state-{}-{tag}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("tmp dir");
        dir.join(DEFAULT_STATE_FILE)
    }

    fn topic(seed: char) -> String {
        // 64 hex-символа = настоящий вид темы (hex(mac)).
        std::iter::repeat(seed).take(64).collect()
    }

    fn cleanup(path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn bindings_survive_restart() {
        let path = tmp_path("restart");
        let t = topic('a');
        let st = PersistedState::snapshot(
            &HashMap::from([(t.clone(), "reg-token-abc:123".to_string())]),
            &HashMap::from([(
                t.clone(),
                "https://vault-msg.ru/ring_incoming_pulse.mp3".to_string(),
            )]),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        );
        st.save_atomic(&path).expect("save");

        // «Рестарт релея»: читаем файл заново — обе карты должны быть на месте.
        let loaded = PersistedState::load(&path);
        assert_eq!(
            loaded.topic_fcm.get(&t).map(String::as_str),
            Some("reg-token-abc:123")
        );
        assert_eq!(
            loaded.topic_ringtone.get(&t).map(String::as_str),
            Some("https://vault-msg.ru/ring_incoming_pulse.mp3")
        );
        assert_eq!(loaded.v, STATE_VERSION);
        assert!(loaded.saved_at > 0);
        cleanup(&path);
    }

    #[test]
    fn save_is_atomic_and_leaves_no_temp() {
        let path = tmp_path("atomic");
        PersistedState::default().save_atomic(&path).expect("save");
        assert!(path.exists());
        let mut tmp = path.as_os_str().to_os_string();
        tmp.push(".tmp");
        assert!(
            !PathBuf::from(tmp).exists(),
            "temp file must be renamed away"
        );
        // Второй save перезаписывает (не дописывает) — файл остаётся валидным.
        let t = topic('b');
        PersistedState::snapshot(
            &HashMap::from([(t.clone(), "tok".to_string())]),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .save_atomic(&path)
        .expect("save 2");
        assert_eq!(
            PersistedState::load(&path)
                .topic_fcm
                .get(&t)
                .map(String::as_str),
            Some("tok")
        );
        cleanup(&path);
    }

    #[test]
    fn missing_file_is_empty_not_panic() {
        let path = tmp_path("missing").with_file_name("nope-does-not-exist.json");
        let st = PersistedState::load(&path);
        assert!(st.topic_fcm.is_empty() && st.topic_ringtone.is_empty());
        cleanup(&path);
    }

    #[test]
    fn broken_json_is_ignored() {
        let path = tmp_path("broken");
        std::fs::write(&path, b"{not json at all").expect("write");
        let st = PersistedState::load(&path);
        assert!(st.topic_fcm.is_empty() && st.topic_ringtone.is_empty());
        cleanup(&path);
    }

    #[test]
    fn broken_entries_are_filtered_on_load() {
        let path = tmp_path("filter");
        // Вручную подсовкиваем мусор: не-hex тема, пустой reg_token,
        // «рингтон» не http, битый fp/токен. Всё это обязано исчезнуть,
        // валидное — остаться.
        let raw = format!(
            r#"{{"v":1,"topic_fcm":{{"{}":"good-token","{}":"","zz":"tok"}},"topic_ringtone":{{"{}":"ftp://x/y.mp3","{}":"https://ok/r.mp3"}},"fp_tokens":{{"c7:3c:e5:5a:9f:7b:46:6f":{{"token":"AbC-123_xyz","kind":"install","exp":99}},"":{{"token":"x"}},"bad fp":{{"token":"y"}},"aa:bb":{{"token":"not a token"}}}}}}"#,
            topic('1'),
            topic('2'),
            topic('3'),
            topic('4')
        );
        std::fs::write(&path, raw.as_bytes()).expect("write");
        let st = PersistedState::load(&path);
        assert_eq!(st.topic_fcm.len(), 1);
        assert_eq!(
            st.topic_fcm.get(&topic('1')).map(String::as_str),
            Some("good-token")
        );
        assert_eq!(st.topic_ringtone.len(), 1);
        assert_eq!(
            st.topic_ringtone.get(&topic('4')).map(String::as_str),
            Some("https://ok/r.mp3")
        );
        // fp: остаётся только корректная запись (непустой fp, base64url-токен).
        assert_eq!(st.fp_tokens.len(), 1);
        let rec = st.fp_tokens.get("c7:3c:e5:5a:9f:7b:46:6f").expect("fp kept");
        assert_eq!(rec.token, "AbC-123_xyz");
        assert_eq!(rec.kind, "install");
        cleanup(&path);
    }

    #[test]
    fn fp_tokens_survive_restart() {
        // Главное свойство фикса: адрес очереди переживает рестарт релея,
        // т.е. повторная выдача по тому же fp вернёт тот же токен.
        let path = tmp_path("fprestart");
        let fp = "2b:e1:c9:30:d1:b9:1b:85".to_string();
        let rec = FpToken {
            token: "Tok_abc-123".to_string(),
            kind: "install".to_string(),
            exp: 4102444800,
        };
        PersistedState::snapshot(
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::from([(fp.clone(), rec.clone())]),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
            &HashMap::new(),
        )
        .save_atomic(&path)
        .expect("save");
        let loaded = PersistedState::load(&path);
        assert_eq!(loaded.fp_tokens.get(&fp), Some(&rec));
        cleanup(&path);
    }

    #[test]
    fn state_path_from_raw_rules() {
        // Явный путь — как есть; off/none — персист выключен; пусто/unset —
        // дефолт рядом с WorkingDirectory.
        assert_eq!(
            state_path_from_raw(Some("/home/maksim/vault-relay/state.json")),
            Some(PathBuf::from("/home/maksim/vault-relay/state.json"))
        );
        assert_eq!(state_path_from_raw(Some("off")), None);
        assert_eq!(state_path_from_raw(Some(" none ")), None);
        assert_eq!(
            state_path_from_raw(Some("")),
            Some(PathBuf::from(DEFAULT_STATE_FILE))
        );
        assert_eq!(
            state_path_from_raw(None),
            Some(PathBuf::from(DEFAULT_STATE_FILE))
        );
    }
}