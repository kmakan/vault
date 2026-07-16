use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Supported emoji reactions
pub const VALID_EMOJIS: &[&str] = &["👍", "❤️", "😂", "😮", "😢", "🔥"];

/// A single reaction on a message
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Reaction {
    pub message_id: String,
    pub emoji: String,
    pub user: String,
    pub timestamp: DateTime<Utc>,
}

impl Reaction {
    pub fn new(message_id: &str, emoji: &str, user: &str) -> Self {
        Self {
            message_id: message_id.to_string(),
            emoji: emoji.to_string(),
            user: user.to_string(),
            timestamp: Utc::now(),
        }
    }

    /// Validate that the emoji is one of the allowed set
    pub fn is_valid_emoji(emoji: &str) -> bool {
        VALID_EMOJIS.contains(&emoji)
    }
}

/// Aggregated reactions for display: emoji → count and list of users
#[derive(Debug, Clone)]
pub struct ReactionSummary {
    pub emoji: String,
    pub count: usize,
    pub users: Vec<String>,
}

/// Manages reaction storage backed by a JSON file
pub struct ReactionStore {
    path: PathBuf,
    reactions: HashMap<String, Vec<Reaction>>,
}

impl ReactionStore {
    /// Create a new store using the default path (~/.whisper/reactions.json)
    pub fn new() -> Self {
        let path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".whisper")
            .join("reactions.json");
        Self::with_path(path)
    }

    /// Create a store with an explicit path (useful for tests)
    pub fn with_path(path: PathBuf) -> Self {
        let reactions = Self::load_from_file(&path).unwrap_or_default();
        Self { path, reactions }
    }

    /// Load reactions from disk
    fn load_from_file(path: &PathBuf) -> Result<HashMap<String, Vec<Reaction>>> {
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let data = fs::read_to_string(path).context("Failed to read reactions file")?;
        let reactions: HashMap<String, Vec<Reaction>> =
            serde_json::from_str(&data).context("Failed to parse reactions file")?;
        Ok(reactions)
    }

    /// Save reactions to disk
    fn save_to_file(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).context("Failed to create .whisper directory")?;
        }
        let data = serde_json::to_string_pretty(&self.reactions)
            .context("Failed to serialize reactions")?;
        fs::write(&self.path, data).context("Failed to write reactions file")?;
        Ok(())
    }

    /// Add a reaction to a message. Returns false if emoji is invalid.
    pub fn add_reaction(&mut self, message_id: &str, emoji: &str, user: &str) -> Result<bool> {
        if !Reaction::is_valid_emoji(emoji) {
            return Ok(false);
        }

        // Remove any existing reaction from this user on this message (replace behavior)
        if let Some(msg_reactions) = self.reactions.get_mut(message_id) {
            msg_reactions.retain(|r| r.user != user || r.emoji != emoji);
        }

        let reaction = Reaction::new(message_id, emoji, user);
        self.reactions
            .entry(message_id.to_string())
            .or_insert_with(Vec::new)
            .push(reaction);

        self.save_to_file()?;
        Ok(true)
    }

    /// Remove a specific reaction from a message
    pub fn remove_reaction(&mut self, message_id: &str, emoji: &str, user: &str) -> Result<bool> {
        if let Some(msg_reactions) = self.reactions.get_mut(message_id) {
            let before = msg_reactions.len();
            msg_reactions.retain(|r| !(r.user == user && r.emoji == emoji));
            let removed = msg_reactions.len() < before;

            // Clean up empty entries
            if msg_reactions.is_empty() {
                self.reactions.remove(message_id);
            }

            if removed {
                self.save_to_file()?;
            }
            Ok(removed)
        } else {
            Ok(false)
        }
    }

    /// Remove all reactions from a user on a message
    pub fn remove_all_from_user(&mut self, message_id: &str, user: &str) -> Result<usize> {
        if let Some(msg_reactions) = self.reactions.get_mut(message_id) {
            let before = msg_reactions.len();
            msg_reactions.retain(|r| r.user != user);
            let removed = before - msg_reactions.len();

            if msg_reactions.is_empty() {
                self.reactions.remove(message_id);
            }

            if removed > 0 {
                self.save_to_file()?;
            }
            Ok(removed)
        } else {
            Ok(0)
        }
    }

    /// Get reactions for a message, grouped by emoji
    pub fn get_reactions(&self, message_id: &str) -> Vec<ReactionSummary> {
        match self.reactions.get(message_id) {
            Some(msg_reactions) => {
                let mut groups: HashMap<String, Vec<String>> = HashMap::new();
                for r in msg_reactions {
                    groups
                        .entry(r.emoji.clone())
                        .or_insert_with(Vec::new)
                        .push(r.user.clone());
                }

                let mut summaries: Vec<ReactionSummary> = groups
                    .into_iter()
                    .map(|(emoji, users)| ReactionSummary {
                        count: users.len(),
                        emoji,
                        users,
                    })
                    .collect();

                // Sort by count descending, then emoji
                summaries.sort_by(|a, b| b.count.cmp(&a.count).then(a.emoji.cmp(&b.emoji)));
                summaries
            }
            None => Vec::new(),
        }
    }

    /// Get all reactions for a message as a flat list
    pub fn get_all_reactions(&self, message_id: &str) -> Vec<&Reaction> {
        self.reactions
            .get(message_id)
            .map(|r| r.iter().collect())
            .unwrap_or_default()
    }

    /// Format reactions for display (e.g. "👍3 ❤️2")
    pub fn format_reactions(&self, message_id: &str) -> String {
        let summaries = self.get_reactions(message_id);
        if summaries.is_empty() {
            return String::new();
        }

        summaries
            .iter()
            .map(|s| {
                if s.count > 1 {
                    format!("{}{}", s.emoji, s.count)
                } else {
                    s.emoji.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Count total reactions for a message
    pub fn count_reactions(&self, message_id: &str) -> usize {
        self.reactions.get(message_id).map(|r| r.len()).unwrap_or(0)
    }
}

impl Default for ReactionStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    fn test_store() -> ReactionStore {
        let dir = temp_dir().join(format!("whisper_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        ReactionStore::with_path(dir.join("reactions.json"))
    }

    #[test]
    fn test_valid_emoji() {
        assert!(Reaction::is_valid_emoji("👍"));
        assert!(Reaction::is_valid_emoji("❤️"));
        assert!(Reaction::is_valid_emoji("😂"));
        assert!(Reaction::is_valid_emoji("😮"));
        assert!(Reaction::is_valid_emoji("😢"));
        assert!(Reaction::is_valid_emoji("🔥"));
        assert!(!Reaction::is_valid_emoji("🚀"));
        assert!(!Reaction::is_valid_emoji("a"));
    }

    #[test]
    fn test_add_reaction() {
        let mut store = test_store();
        let result = store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
        assert!(result);

        let reactions = store.get_reactions("msg1");
        assert_eq!(reactions.len(), 1);
        assert_eq!(reactions[0].emoji, "👍");
        assert_eq!(reactions[0].count, 1);
        assert_eq!(reactions[0].users, vec!["alice@test.com"]);
    }

    #[test]
    fn test_add_multiple_reactions_same_emoji() {
        let mut store = test_store();
        store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
        store.add_reaction("msg1", "👍", "bob@test.com").unwrap();

        let reactions = store.get_reactions("msg1");
        assert_eq!(reactions.len(), 1);
        assert_eq!(reactions[0].count, 2);
    }

    #[test]
    fn test_add_different_emojis() {
        let mut store = test_store();
        store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
        store.add_reaction("msg1", "❤️", "alice@test.com").unwrap();

        let reactions = store.get_reactions("msg1");
        assert_eq!(reactions.len(), 2);
    }

    #[test]
    fn test_invalid_emoji() {
        let mut store = test_store();
        let result = store.add_reaction("msg1", "🚀", "alice@test.com").unwrap();
        assert!(!result);
        assert_eq!(store.count_reactions("msg1"), 0);
    }

    #[test]
    fn test_remove_reaction() {
        let mut store = test_store();
        store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
        let removed = store
            .remove_reaction("msg1", "👍", "alice@test.com")
            .unwrap();
        assert!(removed);
        assert_eq!(store.count_reactions("msg1"), 0);
    }

    #[test]
    fn test_remove_nonexistent_reaction() {
        let mut store = test_store();
        let removed = store
            .remove_reaction("msg1", "👍", "alice@test.com")
            .unwrap();
        assert!(!removed);
    }

    #[test]
    fn test_remove_all_from_user() {
        let mut store = test_store();
        store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
        store.add_reaction("msg1", "❤️", "alice@test.com").unwrap();
        store.add_reaction("msg1", "👍", "bob@test.com").unwrap();

        let removed = store
            .remove_all_from_user("msg1", "alice@test.com")
            .unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.count_reactions("msg1"), 1);
    }

    #[test]
    fn test_persistence() {
        let dir = temp_dir().join(format!("whisper_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("reactions.json");

        // Write
        {
            let mut store = ReactionStore::with_path(path.clone());
            store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
            store.add_reaction("msg1", "❤️", "bob@test.com").unwrap();
        }

        // Read back
        {
            let store = ReactionStore::with_path(path);
            assert_eq!(store.count_reactions("msg1"), 2);
            let reactions = store.get_reactions("msg1");
            assert_eq!(reactions.len(), 2);
        }
    }

    #[test]
    fn test_format_reactions() {
        let mut store = test_store();
        store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
        store.add_reaction("msg1", "👍", "bob@test.com").unwrap();
        store
            .add_reaction("msg1", "❤️", "charlie@test.com")
            .unwrap();

        let formatted = store.format_reactions("msg1");
        assert_eq!(formatted, "👍2 ❤️");
    }

    #[test]
    fn test_format_reactions_empty() {
        let store = test_store();
        let formatted = store.format_reactions("msg1");
        assert!(formatted.is_empty());
    }

    #[test]
    fn test_get_all_reactions() {
        let mut store = test_store();
        store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
        store.add_reaction("msg1", "❤️", "bob@test.com").unwrap();

        let all = store.get_all_reactions("msg1");
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn test_reaction_struct() {
        let r = Reaction::new("msg1", "👍", "alice@test.com");
        assert_eq!(r.message_id, "msg1");
        assert_eq!(r.emoji, "👍");
        assert_eq!(r.user, "alice@test.com");
    }

    #[test]
    fn test_clean_empty_message_entry() {
        let mut store = test_store();
        store.add_reaction("msg1", "👍", "alice@test.com").unwrap();
        store
            .remove_reaction("msg1", "👍", "alice@test.com")
            .unwrap();
        // The entry should be cleaned up
        assert!(store.reactions.get("msg1").is_none());
    }
}
