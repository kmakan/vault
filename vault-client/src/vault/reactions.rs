// Rust core logic for message reactions — перенос из JS features/reactions.js.
// Wire format: {react:1, msg_id, emoji, action(add|remove)} в encrypted_payload.
// Storage: SQLite (core), fallback на kv если DB недоступен.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Reaction wire payload (внутри encrypted_payload)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionPayload {
    pub react: u8,
    pub msg_id: String,
    pub emoji: String,
    pub action: ReactionAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReactionAction {
    Add,
    Remove,
}

/// Stored reaction entry
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredReaction {
    pub emoji: String,
    pub user: String,
}

impl StoredReaction {
    /// Validate emoji (basic: 1-4 code points, not empty, no spaces).
    pub fn is_valid_emoji(emoji: &str) -> bool {
        !emoji.is_empty() && emoji.chars().count() <= 4 && !emoji.contains(char::is_whitespace)
    }
}

/// Reactions store: chat_key → msg_id → Vec<StoredReaction>
#[derive(Debug, Default, Clone)]
pub struct ReactionsStore(HashMap<String, HashMap<String, Vec<StoredReaction>>>);

/// Backward-compat aliases (mod.rs re-exports)
pub type Reaction = StoredReaction;

/// ReactionStore — repl.rs API (new + Result-returning add/remove).
#[derive(Debug, Default, Clone)]
pub struct ReactionStore(ReactionsStore);

impl ReactionStore {
    pub fn new() -> Self { Self(ReactionsStore::default()) }

    /// Validate emoji — правило живёт в StoredReaction (единственный источник).
    ///
    /// Раньше оно было продублировано в двух структурах, и правка одной копии
    /// оставляла вторую со старым поведением (тот же класс, что «правило
    /// описано в двух местах»).
    pub fn is_valid_emoji(emoji: &str) -> bool {
        StoredReaction::is_valid_emoji(emoji)
    }

    /// Add reaction. Returns Ok(true) if added, Ok(false) if invalid or already present.
    ///
    /// ВАЖНО: «уже есть» — это Ok(false), и это НЕ косметика. Вызывающий (CLI)
    /// по Ok(true) не только печатает «Reacted …», но и ОТПРАЛЯЕТ письмо-
    /// уведомление. Прежняя реализация возвращала Ok(true) всегда, и повторная
    /// та же реакция приводила к ПОВТОРНОЙ отправке уведомления (тот же
    /// класс, что «дубль квитанции»). Считаем по «до/после», как в
    /// remove_reaction.
    pub fn add_reaction(&mut self, msg_id: &str, emoji: &str, user: &str) -> Result<bool, String> {
        if !Self::is_valid_emoji(emoji) { return Ok(false); }
        let before = self.0.inner().get("__local__").and_then(|m| m.get(msg_id)).map_or(0, |v| v.len());
        self.0.add_reaction(msg_id, emoji, user);
        let after = self.0.inner().get("__local__").and_then(|m| m.get(msg_id)).map_or(0, |v| v.len());
        Ok(after > before)
    }

    /// Remove reaction. Returns Ok(true) removed, Ok(false) not found/invalid.
    pub fn remove_reaction(&mut self, msg_id: &str, emoji: &str, user: &str) -> Result<bool, String> {
        if !Self::is_valid_emoji(emoji) { return Ok(false); }
        let before = self.0.inner().get("__local__").and_then(|m| m.get(msg_id)).map_or(0, |v| v.len());
        self.0.remove_reaction(msg_id, emoji, user);
        let after = self.0.inner().get("__local__").and_then(|m| m.get(msg_id)).map_or(0, |v| v.len());
        Ok(before > after)
    }

    /// Format для repl.rs display.
    pub fn format_reactions(&self, msg_id: &str) -> String {
        reactions_for_message(&self.0, "__local__", msg_id).join(", ")
    }
}

impl ReactionsStore {
    /// Add a reaction to local store (called from repl.rs /react handler).
    pub fn add_reaction(&mut self, msg_id: &str, emoji: &str, user: &str) {
        let chat_store = self.0.entry("__local__".to_string()).or_default();
        let cur = chat_store.entry(msg_id.to_string()).or_default();
        if !cur.iter().any(|r| r.emoji == emoji && r.user == user) {
            cur.push(StoredReaction { emoji: emoji.to_string(), user: user.to_string() });
        }
    }

    /// Remove a reaction from local store.
    pub fn remove_reaction(&mut self, msg_id: &str, emoji: &str, user: &str) {
        let chat_store = self.0.entry("__local__".to_string()).or_default();
        if let Some(cur) = chat_store.get_mut(msg_id) {
            let idx = cur.iter().position(|r| r.emoji == emoji && r.user == user);
            if let Some(i) = idx {
                cur.remove(i);
            }
            if cur.is_empty() {
                chat_store.remove(msg_id);
            }
        }
    }

    /// Direct access to inner map for apply_reactions/reactions_for_message fns.
    pub fn inner(&self) -> &HashMap<String, HashMap<String, Vec<StoredReaction>>> { &self.0 }
    pub fn inner_mut(&mut self) -> &mut HashMap<String, HashMap<String, Vec<StoredReaction>>> { &mut self.0 }
}

/// Build a reaction wire payload — → encrypted_payload, then VaultEnvelope.wrap
pub fn build_reaction_payload(msg_id: &str, emoji: &str, action: ReactionAction) -> String {
    serde_json::to_string(&ReactionPayload {
        react: 1,
        msg_id: msg_id.to_string(),
        emoji: emoji.to_string(),
        action,
    }).expect("Failed to serialize reaction payload")
}

/// Wire reaction (from incoming encrypted_payload)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireReaction {
    pub emoji: String,
    pub user: String,
    pub action: ReactionAction,
}

/// Apply wire reactions to stored state, merge с сохранёнными реакциями.
pub fn apply_reactions(
    store: &mut ReactionsStore,
    chat_key: &str,
    wire_reactions: &HashMap<String, Vec<WireReaction>>,
) {
    let inner = store.inner_mut();
    let chat_store = inner.entry(chat_key.to_string()).or_default();
    for (msg_id, reactions) in wire_reactions {
        let cur = chat_store.entry(msg_id.clone()).or_default();
        for r in reactions {
            let idx = cur.iter().position(|x| x.emoji == r.emoji && x.user == r.user);
            if r.action == ReactionAction::Remove {
                if let Some(i) = idx { cur.remove(i); }
            } else if idx.is_none() {
                cur.push(StoredReaction { emoji: r.emoji.clone(), user: r.user.clone() });
            }
        }
        if cur.is_empty() {
            chat_store.remove(msg_id);
        }
    }
}

/// Get unique emojis для сообщения (для rendering)
pub fn reactions_for_message(store: &ReactionsStore, chat_key: &str, msg_id: &str) -> Vec<String> {
    store.inner()
        .get(chat_key)
        .and_then(|msgs| msgs.get(msg_id))
        .map(|reactions| {
            let mut seen: Vec<String> = Vec::new();
            for r in reactions {
                if !seen.contains(&r.emoji) {
                    seen.push(r.emoji.clone());
                }
            }
            seen
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_reaction_payload_add() {
        let payload = build_reaction_payload("msg-1", "👍", ReactionAction::Add);
        let parsed: ReactionPayload = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed.react, 1);
        assert_eq!(parsed.msg_id, "msg-1");
        assert_eq!(parsed.emoji, "👍");
        assert_eq!(parsed.action, ReactionAction::Add);
    }

    #[test]
    fn test_build_reaction_payload_remove() {
        let payload = build_reaction_payload("msg-2", "❤️", ReactionAction::Remove);
        let parsed: ReactionPayload = serde_json::from_str(&payload).unwrap();
        assert_eq!(parsed.action, ReactionAction::Remove);
    }

    #[test]
    fn test_apply_reactions_add() {
        let mut store = ReactionsStore::default();
        let mut wire = HashMap::new();
        wire.insert("msg-1".to_string(), vec![WireReaction {
            emoji: "👍".to_string(), user: "alice@x".to_string(),
            action: ReactionAction::Add,
        }]);
        apply_reactions(&mut store, "chat-1", &wire);
        assert_eq!(reactions_for_message(&store, "chat-1", "msg-1"), vec!["👍".to_string()]);
    }

    #[test]
    fn test_apply_reactions_remove() {
        let mut store = ReactionsStore::default();
        let mut wire = HashMap::new();
        wire.insert("msg-1".to_string(), vec![WireReaction {
            emoji: "👍".to_string(), user: "alice@x".to_string(),
            action: ReactionAction::Add,
        }]);
        apply_reactions(&mut store, "chat-1", &wire);
        wire.clear();
        wire.insert("msg-1".to_string(), vec![WireReaction {
            emoji: "👍".to_string(), user: "alice@x".to_string(),
            action: ReactionAction::Remove,
        }]);
        apply_reactions(&mut store, "chat-1", &wire);
        assert!(reactions_for_message(&store, "chat-1", "msg-1").is_empty());
    }

    #[test]
    fn test_apply_reactions_dedup() {
        let mut store = ReactionsStore::default();
        let mut wire = HashMap::new();
        wire.insert("m1".to_string(), vec![
            WireReaction { emoji: "👍".into(), user: "a@x".into(), action: ReactionAction::Add },
            WireReaction { emoji: "👍".into(), user: "a@x".into(), action: ReactionAction::Add },
            WireReaction { emoji: "❤️".into(), user: "b@x".into(), action: ReactionAction::Add },
        ]);
        apply_reactions(&mut store, "chat", &wire);
        assert_eq!(reactions_for_message(&store, "chat", "m1"), vec!["👍".to_string(), "❤️".to_string()]);
    }

    #[test]
    fn test_empty_reactions() {
        let store = ReactionsStore::default();
        assert!(reactions_for_message(&store, "chat", "m1").is_empty());
    }

    #[test]
    fn test_add_remove_via_methods() {
        let mut store = ReactionsStore::default();
        store.add_reaction("msg-1", "👍", "alice@x");
        assert_eq!(reactions_for_message(&store, "__local__", "msg-1"), vec!["👍".to_string()]);
        store.remove_reaction("msg-1", "👍", "alice@x");
        assert!(reactions_for_message(&store, "__local__", "msg-1").is_empty());
    }

    /// Валидация эмодзи: непустой, до 4 code points, без пробелов. Это ввод
    /// пользователя — серверная проверка, а не украшение.
    /// Мутационный гейт Rust-ядра выловил, что на эти правила теста не было.
    #[test]
    fn test_is_valid_emoji_rules() {
        assert!(ReactionStore::is_valid_emoji("👍"), "обычный эмодзи валиден");
        assert!(ReactionStore::is_valid_emoji("❤"), "одно code point — валидно");
        assert!(!ReactionStore::is_valid_emoji(""), "пустая строка — не эмодзи");
        assert!(
            !ReactionStore::is_valid_emoji("👍👍👍👍👍"),
            "больше 4 code points — не эмодзи"
        );
        assert!(
            !ReactionStore::is_valid_emoji("👍 "),
            "эмодзи с пробелом — не эмодзи"
        );
        // Путь CLI (repl.rs) валидирует через StoredReaction::is_valid_emoji —
        // правило должно вести себя ОДИНАКОВО в обеих точках.
        assert!(StoredReaction::is_valid_emoji("👍"));
        assert!(!StoredReaction::is_valid_emoji(""));
        assert!(!StoredReaction::is_valid_emoji("👍👍👍👍👍"));
        assert!(!StoredReaction::is_valid_emoji("👍 "));
    }

    /// Одна и та же пара (эмодзи, пользователь) не добавляется дважды:
    /// иначе в чате появляются «двойные» реакции.
    #[test]
    fn test_add_reaction_dedup() {
        let mut store = ReactionsStore::default();
        store.add_reaction("msg-1", "👍", "alice@x");
        store.add_reaction("msg-1", "👍", "alice@x");
        // Считаем СЫРУЮ карту: reactions_for_message отдаёт список УНИКАЛЬНЫХ
        // эмодзи, а нам нужно знать, сколько ЗАПИСЕЙ (реакция = эмодзи+пользователь).
        let raw = store.inner().get("__local__").unwrap().get("msg-1").unwrap();
        assert_eq!(
            raw.len(),
            1,
            "повтор той же реакции от того же пользователя не добавляется"
        );
        // Другой пользователь — другая реакция, она добавляется.
        store.add_reaction("msg-1", "👍", "bob@x");
        let raw2 = store.inner().get("__local__").unwrap().get("msg-1").unwrap();
        assert_eq!(raw2.len(), 2, "реакция другого пользователя добавляется");
        assert_eq!(reactions_for_message(&store, "__local__", "msg-1").len(), 1, "эмодзи один");
    }

    /// Снятие реакции чужого пользователя не работает: реакция принадлежит
    /// автору, а не тому, кто её видит.
    #[test]
    fn test_remove_reaction_of_other_user_does_nothing() {
        let mut store = ReactionsStore::default();
        store.add_reaction("msg-1", "👍", "alice@x");
        store.remove_reaction("msg-1", "👍", "bob@x");
        assert_eq!(
            reactions_for_message(&store, "__local__", "msg-1").len(),
            1,
            "чужая реакция не должна сниматься"
        );
    }

    /// Снятая последняя реакция убирает запись сообщения из карты — иначе в
    /// карте чата копятся пустые записи.
    #[test]
    fn test_empty_reaction_entry_is_dropped() {
        let mut store = ReactionsStore::default();
        store.add_reaction("msg-1", "👍", "alice@x");
        store.remove_reaction("msg-1", "👍", "alice@x");
        assert!(
            !store.inner().get("__local__").unwrap().contains_key("msg-1"),
            "пустая запись реакций должна исчезнуть из карты"
        );
    }

    /// ReactionStore (API для repl) отвечает: true — снято, false — не было.
    #[test]
    fn test_reaction_store_reports_whether_removed() {
        let mut rs = ReactionStore::new();
        assert!(rs.add_reaction("msg-1", "👍", "alice@x").unwrap());
        assert!(
            !rs.add_reaction("msg-1", "👍", "alice@x").unwrap(),
            "дубль не добавляется (иначе CLI повторно отправит уведомление)"
        );
        assert!(!rs.add_reaction("msg-2", "", "alice@x").unwrap(), "пустой эмодзи не добавляется");
        assert!(rs.remove_reaction("msg-1", "👍", "alice@x").unwrap(), "снятие сообщает true");
        assert!(
            !rs.remove_reaction("msg-1", "👍", "alice@x").unwrap(),
            "повторное снятие сообщает false"
        );
        assert!(
            !rs.remove_reaction("msg-1", "", "alice@x").unwrap(),
            "невалидный эмодзи при снятии — false"
        );
    }
}
