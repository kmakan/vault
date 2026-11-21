//! Vault Sfera: Tauri-команды для связывания, репозитория и истории.
//! Отдельный crate: `social-ffi` держит базовые команды и не раздувается.
//! Команды приватные (урок tauri 2.12 / E0255), наружу — handler.

use serde::{Deserialize, Serialize};
use social_bridge::{accept_link, restore_repo};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LinkInfoDto {
    pub account_fp: String,
    pub device_pub_key: String,
    pub contacts: usize,
    pub spheres: usize,
    pub seq: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RepoStatusDto {
    pub blocks: usize,
    pub head: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct ProgressDto {
    pub sent_batches: usize,
    pub total_batches: usize,
    pub sent_keys: usize,
    pub total_keys: usize,
    pub done: bool,
}

fn err(code: &str, msg: impl std::fmt::Display) -> String {
    format!("{code}: {msg}")
}

/// Разобрать и проверить QR-ссылку связывания (без изменения состояния).
#[tauri::command]
fn social_link_inspect(uri: String, expected_seq: u64) -> Result<LinkInfoDto, String> {
    let id = accept_link(&uri, expected_seq).map_err(|e| err("link", format!("{e:?}")))?;
    Ok(LinkInfoDto {
        account_fp: id.account_fp.as_str().to_string(),
        device_pub_key: id.device_pub_key,
        contacts: id.contacts.len(),
        spheres: id.spheres.len(),
        seq: id.seq,
    })
}

/// Проверить цепочку блоков репозитория перед записью на диск.
#[tauri::command]
fn social_repo_verify(blocks: Vec<social_repo::RepoBlock>) -> Result<RepoStatusDto, String> {
    let chain = restore_repo(blocks).map_err(|e| err("repo", format!("{e:?}")))?;
    Ok(RepoStatusDto {
        blocks: chain.blocks.len(),
        head: chain.head_hash(),
    })
}

/// Прогресс выдачи истории для UI — только числа.
#[tauri::command]
fn social_history_progress(
    sent_batches: usize,
    total_batches: usize,
    sent_keys: usize,
    total_keys: usize,
) -> ProgressDto {
    ProgressDto {
        sent_batches,
        total_batches,
        sent_keys,
        total_keys,
        done: total_batches > 0 && sent_batches == total_batches,
    }
}

/// Команды этого крейта — для сборки общего handler'а в оболочке.
pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "social_link_inspect" | "social_repo_verify" | "social_history_progress"
    )
}

pub fn social_bridge_commands_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        social_link_inspect,
        social_repo_verify,
        social_history_progress,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_dto_is_honest() {
        let p = social_history_progress(1, 2, 50, 100);
        assert!(!p.done);
        let p2 = social_history_progress(2, 2, 100, 100);
        assert!(p2.done);
    }

    #[test]
    fn handles_only_own_commands() {
        assert!(handles("social_link_inspect"));
        assert!(!handles("social_feed"));
    }

    #[test]
    fn bad_uri_is_typed_error() {
        let e = social_link_inspect("not-a-link".into(), 0).unwrap_err();
        assert!(e.starts_with("link:"));
    }
}
