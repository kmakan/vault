//! Vault Sfera: Tauri-команды для companion/billing/account/media.
//! Отдельный crate: базовый FFI и bridge не раздуваются. Команды приватные
//! (урок E0255 в tauri 2.12), наружу — handler.

use serde::{Deserialize, Serialize};
use sfera_billing::{plan_for, validate, PlansResponse};
use sfera_companion::{action_for, target_uri, CompanionProbe};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct CompanionDto {
    pub install: bool,
    pub target: &'static str,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlanDto {
    pub plan: String,
    pub months: u16,
    pub amount: String,
    pub currency: String,
    pub kopecks: u64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub enum MediaKindDto {
    Image,
    Audio,
    Video,
    Document,
}

#[tauri::command]
fn social_companion_action(deep_link_handled: bool) -> CompanionDto {
    let action = action_for(CompanionProbe {
        deep_link_handled,
        same_device_linked: false,
    });
    CompanionDto {
        install: matches!(action, sfera_companion::CompanionAction::InstallMessenger),
        target: target_uri(action),
    }
}

#[tauri::command]
fn social_plans_from_server(response: PlansResponse) -> Result<Vec<PlanDto>, String> {
    validate(&response).map_err(|e| format!("catalog: {e:?}"))?;
    Ok(response
        .plans
        .iter()
        .map(|p| PlanDto {
            plan: p.plan.clone(),
            months: p.months,
            amount: p.amount.clone(),
            currency: p.currency.clone(),
            kopecks: p.kopecks,
        })
        .collect())
}

#[tauri::command]
fn social_plan_for(response: PlansResponse, months: u16) -> Option<PlanDto> {
    plan_for(&response, months).map(|p| PlanDto {
        plan: p.plan.clone(),
        months: p.months,
        amount: p.amount.clone(),
        currency: p.currency.clone(),
        kopecks: p.kopecks,
    })
}

#[tauri::command]
fn social_media_kind(mime: String) -> MediaKindDto {
    match social_media_kind::classify(&mime) {
        social_media_kind::MediaKind::Image => MediaKindDto::Image,
        social_media_kind::MediaKind::Audio => MediaKindDto::Audio,
        social_media_kind::MediaKind::Video => MediaKindDto::Video,
        social_media_kind::MediaKind::Document => MediaKindDto::Document,
    }
}

#[tauri::command]
fn social_organization_role_allows_media(role: social_account::OrgRole) -> bool {
    social_account::OrgRole::permission_set(role).can_view_media
}

pub fn social_extra_commands_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        social_companion_action,
        social_plans_from_server,
        social_plan_for,
        social_media_kind,
        social_organization_role_allows_media,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn companion_dto_has_no_secret() {
        let open = social_companion_action(true);
        assert!(!open.install);
        assert_eq!(open.target, "vault://open");
        let install = social_companion_action(false);
        assert!(install.install);
        assert_eq!(install.target, "https://vault-msg.ru/");
    }

    #[test]
    fn media_kind_is_classified_in_rust() {
        assert!(matches!(social_media_kind("image/png".into()), MediaKindDto::Image));
        assert!(matches!(social_media_kind("application/pdf".into()), MediaKindDto::Document));
    }

    #[test]
    fn viewer_has_no_media() {
        assert!(!social_organization_role_allows_media(social_account::OrgRole::Viewer));
        assert!(social_organization_role_allows_media(social_account::OrgRole::Owner));
    }
}
