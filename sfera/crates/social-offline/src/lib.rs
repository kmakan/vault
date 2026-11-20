//! Vault Sfera: офлайн-состояние (ADR-006 §7.3).
//!
//! Лента и миниатюры читаются без сети. Пост можно создать офлайн: он лежит
//! в outbox, шифрование и загрузка медиа начнутся при появлении сети. UI
//! показывает честное состояние, а не «опубликовано» до доставки.
//!
//! Никаких системных часов и сетевых вызовов: время и факт сети приходят
//! аргументом, поэтому переходы детерминированы и тестируемы.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Connectivity {
    Online,
    Offline,
}

/// Что показать в UI. Только строки-состояния: локализация живёт в UI-слое.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DraftStatus {
    /// Пост сохранён локально, сеть не нужна.
    SavedLocally,
    /// Ждёт сети: шифрование/загрузка не начинались.
    QueuedOffline,
    /// В outbox, сеть есть — отправка пойдёт при следующем drain.
    QueuedOnline,
    /// Доставлено получателям.
    Delivered,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftState {
    pub status: DraftStatus,
    pub queued: usize,
    pub delivered: usize,
}

impl DraftState {
    /// Статус черновика при создании. Офлайн = честное «ждёт сети».
    pub fn created(online: Connectivity, queued: usize) -> Self {
        Self {
            status: match online {
                Connectivity::Online => DraftStatus::QueuedOnline,
                Connectivity::Offline => DraftStatus::QueuedOffline,
            },
            queued,
            delivered: 0,
        }
    }

    /// Сеть вернулась: «ждёт сети» → «в очереди к отправке».
    pub fn connectivity_changed(&mut self, online: Connectivity) -> bool {
        let before = self.status;
        if online == Connectivity::Online && self.status == DraftStatus::QueuedOffline {
            self.status = DraftStatus::QueuedOnline;
        } else if online == Connectivity::Offline
            && matches!(self.status, DraftStatus::QueuedOnline | DraftStatus::SavedLocally)
        {
            self.status = DraftStatus::QueuedOffline;
        }
        before != self.status
    }

    /// Отметить доставку. UI не покажет «опубликовано» раньше этого вызова.
    pub fn mark_delivered(&mut self, n: usize) {
        self.delivered += n;
        self.queued = self.queued.saturating_sub(n);
        if self.queued == 0 {
            self.status = DraftStatus::Delivered;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offline_draft_waits_for_network() {
        let s = DraftState::created(Connectivity::Offline, 1);
        assert_eq!(s.status, DraftStatus::QueuedOffline);
        assert_eq!(s.delivered, 0);
    }

    #[test]
    fn reconnect_moves_queued_to_online() {
        let mut s = DraftState::created(Connectivity::Offline, 2);
        assert!(s.connectivity_changed(Connectivity::Online));
        assert_eq!(s.status, DraftStatus::QueuedOnline);
        assert!(!s.connectivity_changed(Connectivity::Online), "повтор не меняет статус");
    }

    #[test]
    fn going_offline_returns_to_waiting() {
        let mut s = DraftState::created(Connectivity::Online, 1);
        assert!(s.connectivity_changed(Connectivity::Offline));
        assert_eq!(s.status, DraftStatus::QueuedOffline);
    }

    #[test]
    fn delivered_only_after_explicit_mark() {
        let mut s = DraftState::created(Connectivity::Online, 3);
        assert_ne!(s.status, DraftStatus::Delivered);
        s.mark_delivered(2);
        assert_ne!(s.status, DraftStatus::Delivered);
        s.mark_delivered(1);
        assert_eq!(s.status, DraftStatus::Delivered);
        assert_eq!(s.queued, 0);
        assert_eq!(s.delivered, 3);
    }
}
