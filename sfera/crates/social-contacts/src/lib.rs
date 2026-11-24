//! Vault Sfera — контакты: заявка → решение владельца (ADR-006 §4.1).
//!
//! Состояние отношения — `none → requested → contact | declined | blocked`.
//! Одобряет только устройство владельца: сервера, который сделал бы это за
//! него, нет. Здесь — чистые переходы; доставка конвертов живёт в
//! `social-delivery`.

use std::collections::{BTreeMap, BTreeSet};

use social_model::Fingerprint;
use social_rights::{RelationState, Role, RoleOverrides};

/// Заявка в контакты. `fp` заявителя извлекается из подписанного ключа, а не
/// из email (email — лишь подсказка доставки).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContactRequest {
    pub from: Fingerprint,
    pub to: Fingerprint,
    pub ts: u64,
    /// Nonce для дедупа повторной доставки.
    pub nonce: String,
    pub message: String,
    /// Адрес заявителя — подсказка доставки, не идентичность. Пусто — нет.
    #[serde(default)]
    pub address: String,
}

impl ContactRequest {
    pub fn new(
        from: Fingerprint,
        to: Fingerprint,
        ts: u64,
        nonce: impl Into<String>,
        message: impl Into<String>,
    ) -> Result<Self, ContactError> {
        if from.same(&to) {
            return Err(ContactError::SelfRequest);
        }
        Ok(Self {
            from,
            to,
            ts,
            nonce: nonce.into(),
            message: message.into(),
            address: String::new(),
        })
    }

    /// Приложить адрес доставки (цепочка вызовов, чтобы не ломать `new`).
    pub fn with_address(mut self, address: impl Into<String>) -> Self {
        self.address = address.into();
        self
    }
}

/// Принятый контакт: роль, точечные права, сферы и флаг истории.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContactRecord {
    pub fp: Fingerprint,
    pub role: Role,
    #[serde(default)]
    pub overrides: RoleOverrides,
    #[serde(default)]
    pub spheres: Vec<String>,
    pub history_granted: bool,
    pub state: RelationState,
    /// Адрес доставки, известный от заявителя. Подсказка, не идентичность:
    /// конверты адресуются отпечатком, а адрес помогает, когда отпечаток
    /// не совпал (алиас, смена ящика).
    #[serde(default)]
    pub address: String,
}

impl ContactRecord {
    pub fn contact(
        fp: Fingerprint,
        role: Role,
        spheres: Vec<String>,
        history_granted: bool,
    ) -> Self {
        Self {
            fp,
            role,
            overrides: RoleOverrides::default(),
            spheres,
            history_granted,
            state: RelationState::Contact,
            address: String::new(),
        }
    }

    pub fn blocked(fp: Fingerprint) -> Self {
        Self {
            fp,
            role: Role::Restricted,
            overrides: RoleOverrides::default(),
            spheres: Vec::new(),
            history_granted: false,
            state: RelationState::Blocked,
            address: String::new(),
        }
    }
}

/// Действие владельца (или заявителя) над отношением.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContactAction {
    /// Новая заявка (повторная идемпотентна; у заблокированного игнорируется).
    Request,
    /// Владелец добавил: роль, сферы, показывать ли историю.
    Approve {
        role: Role,
        spheres: Vec<String>,
        history_granted: bool,
    },
    /// Владелец отклонил заявку.
    Reject,
    /// Владелец заблокировал (из любого состояния, идемпотентно).
    Block,
    /// Снять блокировку.
    Unblock,
    /// Удалить контакт или отменить заявку.
    Remove,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContactError {
    SelfRequest,
    /// Одобрить/отклонить можно только существующую заявку.
    NoPendingRequest,
    /// Разблокировать можно только заблокированного.
    NotBlocked,
    /// Повторная заявка от уже принятого контакта.
    AlreadyContact,
    /// Менять роль можно только у принятого контакта.
    NotContact,
}

/// Переход отношения. Чистая функция: то же решение на всех устройствах.
pub fn transition(
    state: RelationState,
    action: &ContactAction,
) -> Result<RelationState, ContactError> {
    use ContactAction::*;
    use RelationState::*;

    match (state, action) {
        // Заявка
        (None, Request) | (Declined, Request) => Ok(Requested),
        (Requested, Request) => Ok(Requested), // повторная доставка не плодит заявки
        (Blocked, Request) => Ok(Blocked),     // заявки заблокированного игнорируются
        (Contact, Request) => Err(ContactError::AlreadyContact),

        // Решение владельца
        (Requested, Approve { .. }) => Ok(Contact),
        (_, Approve { .. }) => Err(ContactError::NoPendingRequest),
        (Requested, Reject) => Ok(Declined),
        (_, Reject) => Err(ContactError::NoPendingRequest),

        // Блокировка и разблокировка
        (_, Block) => Ok(Blocked),
        (Blocked, Unblock) => Ok(None),
        (_, Unblock) => Err(ContactError::NotBlocked),

        // Удаление / отмена заявки
        (Contact, Remove) | (Requested, Remove) | (Declined, Remove) => Ok(None),
        (None, Remove) => Ok(None),
        // Снять блокировку удалением нельзя: сначала явный Unblock.
        (Blocked, Remove) => Err(ContactError::NotBlocked),
    }
}

/// Кто может отправлять заявки — настройка владельца (ADR-006 §4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestPolicy {
    LinkOnly,
    Everyone,
    Nobody,
}

pub fn can_send_request(policy: RequestPolicy, has_valid_invite: bool) -> bool {
    match policy {
        RequestPolicy::Everyone => true,
        RequestPolicy::LinkOnly => has_valid_invite,
        RequestPolicy::Nobody => false,
    }
}

/// Локальная книга контактов, ключ — канонический отпечаток.
#[derive(Clone, Debug, Default)]
pub struct ContactBook {
    records: BTreeMap<String, ContactRecord>,
    /// Уже обработанные nonce заявок и выдач: ключ `from|to|nonce`.
    /// ADR-006 §7.5: повторная доставка не создаёт второй контакт и не выдаёт
    /// ключ дважды. Без этого реестра повтор письма = повторная выдача.
    seen_nonces: BTreeSet<String>,
}

/// Итог приёма заявки. `Duplicate` — тот же `(from, to, nonce)` уже был.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestOutcome {
    Accepted,
    Duplicate,
}

fn nonce_key(from: &Fingerprint, to: &Fingerprint, nonce: &str) -> String {
    format!("{}|{}|{}", from.as_str(), to.as_str(), nonce)
}

impl ContactBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Принять заявку с дедупом по `(from, to, nonce)`.
    /// Повторная доставка того же письма — `Duplicate`, состояние не меняется.
    pub fn accept_request(
        &mut self,
        req: &ContactRequest,
    ) -> Result<RequestOutcome, ContactError> {
        let key = nonce_key(&req.from, &req.to, &req.nonce);
        if self.seen_nonces.contains(&key) {
            return Ok(RequestOutcome::Duplicate);
        }
        let current = self.state_of(&req.from);
        let next = transition(current, &ContactAction::Request)?;
        if next != current {
            let mut record = self
                .get(&req.from)
                .cloned()
                .unwrap_or_else(|| ContactRecord::contact(req.from.clone(), Role::Acquaintance, Vec::new(), false));
            record.state = next;
            // Адрес из заявки переносим в запись: иначе он теряется, и
            // доставить конверт этому контакту будет некуда.
            if !req.address.is_empty() {
                record.address = req.address.clone();
            }
            self.upsert(record);
        }
        self.seen_nonces.insert(key);
        Ok(RequestOutcome::Accepted)
    }

    /// Отметить nonce как обработанный (для выдач ключей/истории).
    /// `false` — уже был: повторную выдачу делать нельзя.
    pub fn mark_nonce(&mut self, from: &Fingerprint, to: &Fingerprint, nonce: &str) -> bool {
        self.seen_nonces.insert(nonce_key(from, to, nonce))
    }

    pub fn nonce_seen(&self, from: &Fingerprint, to: &Fingerprint, nonce: &str) -> bool {
        self.seen_nonces.contains(&nonce_key(from, to, nonce))
    }

    pub fn upsert(&mut self, record: ContactRecord) {
        self.records
            .insert(record.fp.as_str().to_string(), record);
    }

    /// Сменить роль принятого контакта. Состояние отношения, сферы, история и
    /// точечные `overrides` не трогаются — это отдельные решения владельца.
    pub fn set_role(&mut self, fp: &Fingerprint, role: Role) -> Result<(), ContactError> {
        let record = self
            .records
            .get_mut(fp.as_str())
            .ok_or(ContactError::NotContact)?;
        if record.state != RelationState::Contact {
            return Err(ContactError::NotContact);
        }
        record.role = role;
        Ok(())
    }

    pub fn get(&self, fp: &Fingerprint) -> Option<&ContactRecord> {
        self.records.get(fp.as_str())
    }

    pub fn state_of(&self, fp: &Fingerprint) -> RelationState {
        self.get(fp)
            .map(|r| r.state)
            .unwrap_or(RelationState::None)
    }

    /// Только принятые контакты — вход для `all_contacts` аудитории.
    pub fn contacts(&self) -> impl Iterator<Item = &ContactRecord> {
        self.records
            .values()
            .filter(|r| r.state == RelationState::Contact)
    }

    pub fn remove(&mut self, fp: &Fingerprint) -> Option<ContactRecord> {
        self.records.remove(fp.as_str())
    }
}
