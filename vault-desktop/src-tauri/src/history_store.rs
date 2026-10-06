use anyhow::Result;
use std::fs;
use std::path::PathBuf;

/// Root directory for chat history files.
/// `~/.local/share/com.vault.vault/history/<email>/<safe_chatKey>.json`
fn history_root() -> Result<PathBuf> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine local data directory"))?;
    Ok(base.join("com.vault.vault").join("history"))
}

fn safe_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Save full chat history to a JSON file. Overwrites the previous file atomically.
pub fn save_history(email: &str, chat_key: &str, messages_json: &str) -> Result<()> {
    let dir = history_root()?.join(safe_name(email));
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{}.json", safe_name(chat_key)));
    // Atomic write: write to temp then rename
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, messages_json)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

/// Load chat history from its JSON file. Returns `None` if the file does not exist.
pub fn load_history(email: &str, chat_key: &str) -> Result<Option<String>> {
    let path = history_root()?
        .join(safe_name(email))
        .join(format!("{}.json", safe_name(chat_key)));
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(fs::read_to_string(&path)?))
}

/// Delete all history files for a given email account.
pub fn clear_history(email: &str) -> Result<()> {
    let dir = history_root()?.join(safe_name(email));
    if dir.exists() {
        fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

/// Delete history of ONE chat only (смена почты собеседником: старый
/// chat_key = email пира надо убрать, не трогая остальные переписки).
/// Отсутствующий файл — не ошибка (идемпотентно).
pub fn clear_chat_history(email: &str, chat_key: &str) -> Result<()> {
    let path = history_root()?
        .join(safe_name(email))
        .join(format!("{}.json", safe_name(chat_key)));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Смена почты собеседником: переименование chat_key не должно затирать
    /// переписку ДРУГИХ чатов (clear_chat_history vs clear_history).
    #[test]
    fn clear_chat_history_touches_only_that_chat() {
        // Изоляция: уникальный HOME на тест, чтобы не тронуть реальные данные.
        let tmp = std::env::temp_dir().join(format!("vault_hist_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("HOME", &tmp);
        std::env::set_var("XDG_DATA_HOME", tmp.join(".local/share"));

        save_history("acc@x", "old@peer", "[\"old\"]").unwrap();
        save_history("acc@x", "other@peer", "[\"other\"]").unwrap();

        clear_chat_history("acc@x", "old@peer").unwrap();

        assert!(
            load_history("acc@x", "old@peer").unwrap().is_none(),
            "старый чат удалён"
        );
        assert!(
            load_history("acc@x", "other@peer").unwrap().is_some(),
            "чужой чат цел"
        );
        // Идемпотентность: повторный вызов по удалённому — не ошибка.
        clear_chat_history("acc@x", "old@peer").unwrap();

        let _ = fs::remove_dir_all(&tmp);
    }
}
