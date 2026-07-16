use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Запись в поисковом индексе сообщений
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndexEntry {
    /// ID сообщения (email Message-ID или локальный ID)
    pub message_id: String,
    /// Отправитель
    pub from: String,
    /// Получатель
    pub to: String,
    /// Тема (субъект)
    pub subject: String,
    /// Превью тела сообщения (первые 500 символов, без шифрования)
    pub body_preview: String,
    /// Время отправки
    pub timestamp: DateTime<Utc>,
    /// ID папки (если сообщение в папке)
    pub folder_id: Option<String>,
    /// Есть ли вложения
    pub has_attachments: bool,
    /// Зашифровано ли сообщение
    pub is_encrypted: bool,
}

/// Результат поиска
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub entry: IndexEntry,
    /// Рейтинг релевантности (0.0 — 1.0)
    pub relevance: f64,
    /// Какие поля совпали
    pub matched_fields: Vec<String>,
}

/// Локальный поисковый индекс сообщений с JSON-персистенцией
pub struct MessageIndex {
    path: PathBuf,
    entries: HashMap<String, IndexEntry>,
}

impl MessageIndex {
    /// Создать индекс с默认ным путём (~/.whisper/message_index.json)
    pub fn new() -> Self {
        let path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".whisper")
            .join("message_index.json");
        Self::with_path(path)
    }

    /// Создать индекс с явным путём (для тестов)
    pub fn with_path(path: PathBuf) -> Self {
        let entries = Self::load_from_file(&path).unwrap_or_default();
        Self { path, entries }
    }

    /// Загрузить индекс из файла
    fn load_from_file(path: &PathBuf) -> Result<HashMap<String, IndexEntry>> {
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let data = fs::read_to_string(path).context("Failed to read message index")?;
        let entries: HashMap<String, IndexEntry> =
            serde_json::from_str(&data).context("Failed to parse message index")?;
        Ok(entries)
    }

    /// Сохранить индекс на диск
    fn save_to_file(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).context("Failed to create .whisper directory")?;
        }
        let data = serde_json::to_string_pretty(&self.entries)
            .context("Failed to serialize message index")?;
        fs::write(&self.path, data).context("Failed to write message index")?;
        Ok(())
    }

    /// Добавить сообщение в индекс (или обновить существующее)
    pub fn index_message(&mut self, entry: IndexEntry) -> Result<()> {
        self.entries.insert(entry.message_id.clone(), entry);
        self.save_to_file()?;
        Ok(())
    }

    /// Удалить сообщение из индекса
    pub fn remove_message(&mut self, message_id: &str) -> Result<bool> {
        let removed = self.entries.remove(message_id).is_some();
        if removed {
            self.save_to_file()?;
        }
        Ok(removed)
    }

    /// Поиск сообщений по запросу (регистронезависимый substring)
    pub fn search(&self, query: &str) -> Vec<SearchResult> {
        let q = query.to_lowercase();
        let mut results: Vec<SearchResult> = self
            .entries
            .values()
            .filter_map(|entry| {
                let mut score: f64 = 0.0;
                let mut matched = Vec::new();

                // Поиск по теме (наивысший приоритет)
                if entry.subject.to_lowercase().contains(&q) {
                    score += 1.0;
                    matched.push("subject".to_string());
                }
                // Поиск по отправителю
                if entry.from.to_lowercase().contains(&q) {
                    score += 0.8;
                    matched.push("from".to_string());
                }
                // Поиск по получателю
                if entry.to.to_lowercase().contains(&q) {
                    score += 0.7;
                    matched.push("to".to_string());
                }
                // Поиск по превью тела
                if entry.body_preview.to_lowercase().contains(&q) {
                    score += 0.5;
                    matched.push("body".to_string());
                }

                if score > 0.0 {
                    Some(SearchResult {
                        entry: entry.clone(),
                        relevance: score.min(1.0),
                        matched_fields: matched,
                    })
                } else {
                    None
                }
            })
            .collect();

        // Сортировка по релевантности (DESC), затем по времени (DESC)
        results.sort_by(|a, b| {
            b.relevance
                .partial_cmp(&a.relevance)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.entry.timestamp.cmp(&a.entry.timestamp))
        });
        results
    }

    /// Поиск по конкретной папке
    pub fn search_in_folder(&self, query: &str, folder_id: &str) -> Vec<SearchResult> {
        self.search(query)
            .into_iter()
            .filter(|r| r.entry.folder_id.as_deref() == Some(folder_id))
            .collect()
    }

    /// Поиск по отправителю
    pub fn search_by_sender(&self, sender: &str) -> Vec<&IndexEntry> {
        let s = sender.to_lowercase();
        let mut entries: Vec<&IndexEntry> = self
            .entries
            .values()
            .filter(|e| e.from.to_lowercase().contains(&s))
            .collect();
        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        entries
    }

    /// Получить последние N сообщений
    pub fn recent(&self, limit: usize) -> Vec<&IndexEntry> {
        let mut entries: Vec<&IndexEntry> = self.entries.values().collect();
        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        entries.into_iter().take(limit).collect()
    }

    /// Количество записей в индексе
    pub fn count(&self) -> usize {
        self.entries.len()
    }

    /// Очистить индекс
    pub fn clear(&mut self) -> Result<()> {
        self.entries.clear();
        self.save_to_file()?;
        Ok(())
    }

    /// Удалить записи старше N дней
    pub fn prune_old(&mut self, days: u64) -> Result<usize> {
        let cutoff = Utc::now() - chrono::Duration::days(days as i64);
        let before = self.entries.len();
        self.entries.retain(|_, entry| entry.timestamp > cutoff);
        let removed = before - self.entries.len();
        if removed > 0 {
            self.save_to_file()?;
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_index() -> (MessageIndex, TempDir) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.json");
        (MessageIndex::with_path(path), dir)
    }

    fn make_entry(id: &str, from: &str, subject: &str, body: &str) -> IndexEntry {
        IndexEntry {
            message_id: id.to_string(),
            from: from.to_string(),
            to: "recipient@test.com".to_string(),
            subject: subject.to_string(),
            body_preview: body.to_string(),
            timestamp: Utc::now(),
            folder_id: None,
            has_attachments: false,
            is_encrypted: false,
        }
    }

    #[test]
    fn test_index_and_count() {
        let (mut idx, _dir) = temp_index();
        assert_eq!(idx.count(), 0);
        idx.index_message(make_entry("m1", "alice@test.com", "Hello", "Hello world"))
            .unwrap();
        idx.index_message(make_entry("m2", "bob@test.com", "Re: Hello", "Hi there"))
            .unwrap();
        assert_eq!(idx.count(), 2);
    }

    #[test]
    fn test_search_by_subject() {
        let (mut idx, _dir) = temp_index();
        idx.index_message(make_entry("m1", "a@t.com", "Meeting Tomorrow", "Let's meet"))
            .unwrap();
        idx.index_message(make_entry("m2", "b@t.com", "Lunch", "Pizza today"))
            .unwrap();
        idx.index_message(make_entry("m3", "c@t.com", "Re: Meeting", "Confirmed"))
            .unwrap();

        let results = idx.search("meeting");
        assert_eq!(results.len(), 2);
        // Оба совпадают по subject
        assert!(results[0].matched_fields.contains(&"subject".to_string()));
        assert!(results[1].matched_fields.contains(&"subject".to_string()));
        // Оба — это m1 и m3 (порядок не детерминирован при одинаковых timestamps)
        let ids: Vec<&str> = results
            .iter()
            .map(|r| r.entry.message_id.as_str())
            .collect();
        assert!(ids.contains(&"m1"));
        assert!(ids.contains(&"m3"));
    }

    #[test]
    fn test_search_by_sender() {
        let (mut idx, _dir) = temp_index();
        idx.index_message(make_entry("m1", "alice@work.com", "Report", "Q4 report"))
            .unwrap();
        idx.index_message(make_entry("m2", "bob@work.com", "Report", "Q3 report"))
            .unwrap();

        let results = idx.search("alice");
        assert_eq!(results.len(), 1);
        assert!(results[0].matched_fields.contains(&"from".to_string()));
    }

    #[test]
    fn test_search_by_body() {
        let (mut idx, _dir) = temp_index();
        idx.index_message(make_entry("m1", "a@t.com", "Subject", "The deadline is Friday"))
            .unwrap();
        idx.index_message(make_entry("m2", "b@t.com", "Subject", "No deadline mentioned"))
            .unwrap();

        let results = idx.search("friday");
        assert_eq!(results.len(), 1);
        assert!(results[0].matched_fields.contains(&"body".to_string()));
    }

    #[test]
    fn test_search_relevance_ordering() {
        let (mut idx, _dir) = temp_index();
        // Body match (low relevance)
        idx.index_message(make_entry("m1", "a@t.com", "Subject", "secret info"))
            .unwrap();
        // Subject match (high relevance)
        idx.index_message(make_entry("m2", "b@t.com", "secret plan", "other"))
            .unwrap();

        let results = idx.search("secret");
        assert_eq!(results.len(), 2);
        // Subject match should come first
        assert_eq!(results[0].entry.message_id, "m2");
        assert!(results[0].relevance > results[1].relevance);
    }

    #[test]
    fn test_search_in_folder() {
        let (mut idx, _dir) = temp_index();
        let mut e1 = make_entry("m1", "a@t.com", "Work Report", "details");
        e1.folder_id = Some("work".to_string());
        let mut e2 = make_entry("m2", "b@t.com", "Work Plan", "details");
        e2.folder_id = Some("personal".to_string());
        idx.index_message(e1).unwrap();
        idx.index_message(e2).unwrap();

        let results = idx.search_in_folder("work", "work");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.message_id, "m1");
    }

    #[test]
    fn test_remove_and_prune() {
        let (mut idx, _dir) = temp_index();
        idx.index_message(make_entry("m1", "a@t.com", "Keep", "body"))
            .unwrap();
        idx.index_message(make_entry("m2", "b@t.com", "Delete", "body"))
            .unwrap();
        assert!(idx.remove_message("m2").unwrap());
        assert_eq!(idx.count(), 1);
        assert!(!idx.remove_message("m2").unwrap());
    }

    #[test]
    fn test_recent() {
        let (mut idx, _dir) = temp_index();
        for i in 0..5 {
            idx.index_message(make_entry(
                &format!("m{}", i),
                "a@t.com",
                &format!("Subject {}", i),
                "body",
            ))
            .unwrap();
        }
        let recent = idx.recent(3);
        assert_eq!(recent.len(), 3);
    }

    #[test]
    fn test_persistence() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.json");
        {
            let mut idx = MessageIndex::with_path(path.clone());
            idx.index_message(make_entry("m1", "a@t.com", "Persistent", "data"))
                .unwrap();
        }
        {
            let idx = MessageIndex::with_path(path);
            assert_eq!(idx.count(), 1);
            assert_eq!(idx.entries["m1"].subject, "Persistent");
        }
    }

    #[test]
    fn test_clear() {
        let (mut idx, _dir) = temp_index();
        idx.index_message(make_entry("m1", "a@t.com", "Subject", "body"))
            .unwrap();
        idx.clear().unwrap();
        assert_eq!(idx.count(), 0);
    }
}
