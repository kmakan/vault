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
