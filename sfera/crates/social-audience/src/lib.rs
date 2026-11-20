//! Vault Sfera — ключи аудитории и их эпохи (ADR-006 §4, §4.3).
//!
//! Аудитория (`social_rights::Audience`) отвечает на вопрос «кто входит».
//! Здесь — криптографический ответ: **каким ключом** зашифрован пост этой
//! аудитории в данную эпоху.
//!
//! Правило ротации: при ЛЮБОМ изменении состава (добавили или удалили
//! участника) эпоха растёт, а ключ берётся **свежей случайностью**. Выводить
//! новый ключ из старого нельзя: удалённый участник знает старый ключ и
//! вывел бы новый, то есть сохранил бы доступ. Старые ключи остаются в
//! истории только для чтения уже полученных постов.
//!
//! Ключи НИКОГДА не уходят в JS и не сериализуются: их обёртывает и
//! доставляет `social-delivery` адресно каждому текущему участнику.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use social_model::Fingerprint;

/// Что изменилось при правке состава.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MembershipChange {
    /// Состав изменился → эпоха и ключ ротированы.
    Changed,
    /// Состав тот же → ключ не трогали.
    Unchanged,
}

/// Эпохальные ключи одной аудитории.
///
/// `history` хранит ключи прошлых эпох, чтобы устройство владельца могло
/// отдать историю новому контакту и прочитать собственные старые посты.
/// Компромисс E2E: удалённый участник сохраняет старые копии, но новых
/// ключей не получает — это честно показывается в UI.
#[derive(Clone)]
pub struct AudienceKeys {
    audience_id: String,
    epoch: u64,
    current: [u8; 32],
    members: BTreeSet<String>,
    history: BTreeMap<u64, [u8; 32]>,
}

impl AudienceKeys {
    /// Новая аудитория: эпоха 1, свежий ключ, заданный состав.
    pub fn new<I>(audience_id: impl Into<String>, members: I) -> Self
    where
        I: IntoIterator<Item = Fingerprint>,
    {
        let members: BTreeSet<String> = members
            .into_iter()
            .map(|f| f.as_str().to_string())
            .collect();
        let current = fresh_key();
        let mut history = BTreeMap::new();
        history.insert(1, current);
        Self {
            audience_id: audience_id.into(),
            epoch: 1,
            current,
            members,
            history,
        }
    }

    pub fn audience_id(&self) -> &str {
        &self.audience_id
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Ключ текущей эпохи. Только для ядра/доставки, не для UI.
    pub fn current_key(&self) -> &[u8; 32] {
        &self.current
    }

    /// Ключ конкретной эпохи (для чтения старых постов).
    pub fn key_for(&self, epoch: u64) -> Option<&[u8; 32]> {
        self.history.get(&epoch)
    }

    pub fn members(&self) -> impl Iterator<Item = &str> {
        self.members.iter().map(|s| s.as_str())
    }

    pub fn is_member(&self, fp: &Fingerprint) -> bool {
        self.members.contains(fp.as_str())
    }

    /// Добавить участника. Реальное добавление ротирует ключ.
    pub fn add_member(&mut self, fp: &Fingerprint) -> MembershipChange {
        if self.members.insert(fp.as_str().to_string()) {
            self.rotate();
            MembershipChange::Changed
        } else {
            MembershipChange::Unchanged
        }
    }

    /// Удалить участника. Реальное удаление ротирует ключ, чтобы ушедший
    /// не получил новые посты.
    pub fn remove_member(&mut self, fp: &Fingerprint) -> MembershipChange {
        if self.members.remove(fp.as_str()) {
            self.rotate();
            MembershipChange::Changed
        } else {
            MembershipChange::Unchanged
        }
    }

    /// Привести состав к `target` (синхронизация между устройствами).
    /// Порядок не важен; ротация — только если набор реально изменился.
    pub fn apply_membership<I>(&mut self, target: I) -> MembershipChange
    where
        I: IntoIterator<Item = Fingerprint>,
    {
        let target: BTreeSet<String> = target
            .into_iter()
            .map(|f| f.as_str().to_string())
            .collect();
        if target == self.members {
            return MembershipChange::Unchanged;
        }
        self.members = target;
        self.rotate();
        MembershipChange::Changed
    }

    /// Новая эпоха со СВЕЖИМ случайным ключом. Не выводить из `current`.
    fn rotate(&mut self) {
        self.epoch += 1;
        self.current = fresh_key();
        self.history.insert(self.epoch, self.current);
    }
}

// Секрет не должен попасть в лог через `{:?}`.
impl fmt::Debug for AudienceKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AudienceKeys")
            .field("audience_id", &self.audience_id)
            .field("epoch", &self.epoch)
            .field("members", &self.members.len())
            .field("current_key", &"<redacted>")
            .finish()
    }
}

fn fresh_key() -> [u8; 32] {
    use rand::RngCore;
    let mut k = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut k);
    k
}
