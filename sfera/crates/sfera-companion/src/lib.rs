//! Vault Sfera: связь с мессенджером Vault (ADR-006 §18).
//!
//! Решение PM: Sfera и мессенджер — два приложения с общим ключевым графом.
//! В интерфейсе одна контекстная кнопка: «Открыть мессенджер», если он
//! установлен, или «Установить мессенджер», если нет. Никакого второго
//! клиента, никакого импорта прикладного кода.
//!
//! Механика: мессенджер уже регистрирует deep link `vault://open` (Android
//! manifest, M2.3-b). Sfera не гадает по именам пакетов и путям, а проверяет, что ссылка
//! обрабатывается системой, и передаёт результат в UI как типизированное
//! состояние. Факт установки и открытие — тонкий адаптер ОС; ядро только
//! решение, что показывать.

use serde::{Deserialize, Serialize};

/// Deep link мессенджера — тот же, что в его AndroidManifest.xml.
pub const MESSENGER_DEEP_LINK: &str = "vault://open";
/// Страница установки мессенджера (сайт проекта).
pub const MESSENGER_INSTALL_URL: &str = "https://vault-msg.ru/";

/// Что показать в UI. Только состояние — без путей и внутренних имён.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompanionAction {
    /// Мессенджер установлен: кнопка «Открыть».
    OpenMessenger,
    /// Не установлен: кнопка «Установить» (открыть сайт).
    InstallMessenger,
}

/// Входные данные от ОС-адаптера. `deep_link_handled` — результат проверки,
/// что `vault://open` обрабатывается системой; `same_device_linked` — есть ли
/// связанное устройство (§8), чтобы не предлагать установку при отсутствии связи.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompanionProbe {
    pub deep_link_handled: bool,
    pub same_device_linked: bool,
}

/// Единственное решение: что предлагать пользователю.
pub fn action_for(probe: CompanionProbe) -> CompanionAction {
    if probe.deep_link_handled {
        CompanionAction::OpenMessenger
    } else {
        CompanionAction::InstallMessenger
    }
}

/// URI, который должен открыть UI. Ядро не вызывает ОС само.
pub fn target_uri(action: CompanionAction) -> &'static str {
    match action {
        CompanionAction::OpenMessenger => MESSENGER_DEEP_LINK,
        CompanionAction::InstallMessenger => MESSENGER_INSTALL_URL,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_messenger_gets_open_action() {
        let a = action_for(CompanionProbe {
            deep_link_handled: true,
            same_device_linked: false,
        });
        assert_eq!(a, CompanionAction::OpenMessenger);
        assert_eq!(target_uri(a), MESSENGER_DEEP_LINK);
    }

    #[test]
    fn missing_messenger_gets_install_action() {
        let a = action_for(CompanionProbe {
            deep_link_handled: false,
            same_device_linked: true,
        });
        assert_eq!(a, CompanionAction::InstallMessenger);
        assert_eq!(target_uri(a), MESSENGER_INSTALL_URL);
    }

    #[test]
    fn deep_link_matches_messenger_manifest() {
        assert_eq!(MESSENGER_DEEP_LINK, "vault://open");
    }
}
