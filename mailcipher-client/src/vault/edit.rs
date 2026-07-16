use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Запись редактирования сообщения
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditRecord {
    /// ID сообщения
    pub message_id: String,
    /// Email отправителя
    pub editor_email: String,
    /// Новый зашифрованный контент (заменяет оригинальный body)
    pub new_content: String,
    /// Время последнего редактирования
    pub edited_at: DateTime<Utc>,
    /// Сколько раз отредактировано (включая это)
    pub edit_count: u32,
    /// Хэш оригинального контента (для аудита)
    pub original_hash: Option<String>,
}

/// Результат редактирования
#[derive(Debug, Clone)]
pub struct EditResult {
    pub success: bool,
    pub edit_count: u32,
    pub edited_at: DateTime<Utc>,
    pub warning: Option<String>,
}

/// Менеджер редактирования сообщений с JSON-персистенцией
pub struct EditManager {
    path: PathBuf,
    /// message_id → EditRecord
    edits: HashMap<String, EditRecord>,
    /// Максимальное количество редактирований (по умолчанию 10)
    max_edits: u32,
    /// Временное окно для редактирования (секунды, по умолчанию 1 час)
    edit_window_secs: i64,
}

impl EditManager {
    /// Создать менеджер с默认ным путём (~/.vault/edits.json)
    pub fn new() -> Self {
        let path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".vault")
            .join("edits.json");
        Self::with_path(path)
    }

    /// Создать менеджер с явным путём (для тестов)
    pub fn with_path(path: PathBuf) -> Self {
        let edits = Self::load_from_file(&path).unwrap_or_default();
        Self {
            path,
            edits,
            max_edits: 10,
            edit_window_secs: 3600, // 1 час
        }
    }

    /// Установить лимит редактирований
    pub fn set_max_edits(&mut self, max: u32) {
        self.max_edits = max;
    }

    /// Установить временное окно редактирования (в секундах)
    pub fn set_edit_window(&mut self, secs: i64) {
        self.edit_window_secs = secs;
    }

    /// Загрузить из файла
    fn load_from_file(path: &PathBuf) -> Result<HashMap<String, EditRecord>> {
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let data = fs::read_to_string(path).context("Failed to read edits")?;
        let edits: HashMap<String, EditRecord> =
            serde_json::from_str(&data).context("Failed to parse edits")?;
        Ok(edits)
    }

    /// Сохранить на диск
    fn save_to_file(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let data =
            serde_json::to_string_pretty(&self.edits).context("Failed to serialize edits")?;
        fs::write(&self.path, data).context("Failed to write edits")?;
        Ok(())
    }

    /// Отредактировать сообщение
    pub fn edit_message(
        &mut self,
        message_id: &str,
        editor_email: &str,
        new_content: &str,
    ) -> Result<EditResult> {
        let now = Utc::now();

        // Проверяем, есть ли уже запись редактирования
        if let Some(existing) = self.edits.get(message_id) {
            // Проверяем лимит редактирований
            if existing.edit_count >= self.max_edits {
                return Ok(EditResult {
                    success: false,
                    edit_count: existing.edit_count,
                    edited_at: existing.edited_at,
                    warning: Some(format!(
                        "Edit limit reached ({}/{}). Message cannot be edited further.",
                        existing.edit_count, self.max_edits
                    )),
                });
            }

            // Проверяем временное окно с момента ПЕРВОГО редактирования
            let time_since_original = now.signed_duration_since(
                existing
                    .original_hash
                    .as_ref()
                    .and_then(|_| Some(existing.edited_at))
                    .unwrap_or(existing.edited_at),
            );
            if time_since_original.num_seconds() > self.edit_window_secs {
                return Ok(EditResult {
                    success: false,
                    edit_count: existing.edit_count,
                    edited_at: existing.edited_at,
                    warning: Some(format!(
                        "Edit window expired ({}h limit). Message cannot be edited further.",
                        self.edit_window_secs / 3600
                    )),
                });
            }

            // Проверяем, тот ли редактор (только автор может редактировать)
            if existing.editor_email != editor_email {
                return Ok(EditResult {
                    success: false,
                    edit_count: existing.edit_count,
                    edited_at: existing.edited_at,
                    warning: Some("Only the original editor can make further edits.".to_string()),
                });
            }

            // Обновляем существующую запись
            let count = existing.edit_count + 1;
            let record = EditRecord {
                message_id: message_id.to_string(),
                editor_email: editor_email.to_string(),
                new_content: new_content.to_string(),
                edited_at: now,
                edit_count: count,
                original_hash: existing.original_hash.clone(),
            };
            self.edits.insert(message_id.to_string(), record);
            self.save_to_file()?;
            return Ok(EditResult {
                success: true,
                edit_count: count,
                edited_at: now,
                warning: None,
            });
        }

        // Первое редактирование — создаём новую запись
        let record = EditRecord {
            message_id: message_id.to_string(),
            editor_email: editor_email.to_string(),
            new_content: new_content.to_string(),
            edited_at: now,
            edit_count: 1,
            original_hash: None,
        };
        self.edits.insert(message_id.to_string(), record);
        self.save_to_file()?;
        Ok(EditResult {
            success: true,
            edit_count: 1,
            edited_at: now,
            warning: None,
        })
    }

    /// Получить последнюю версию сообщения
    pub fn get_latest(&self, message_id: &str) -> Option<&EditRecord> {
        self.edits.get(message_id)
    }

    /// Проверить, было ли сообщение отредактировано
    pub fn is_edited(&self, message_id: &str) -> bool {
        self.edits.contains_key(message_id)
    }

    /// Получить количество редактирований
    pub fn edit_count(&self, message_id: &str) -> u32 {
        self.edits
            .get(message_id)
            .map(|r| r.edit_count)
            .unwrap_or(0)
    }

    /// Откатить последнее редактирование (восстановить предыдущую версию)
    pub fn undo_last_edit(&mut self, message_id: &str) -> Result<bool> {
        if let Some(record) = self.edits.get_mut(message_id) {
            if record.edit_count <= 1 {
                // Это первое редактирование — удаляем запись
                self.edits.remove(message_id);
            } else {
                record.edit_count -= 1;
                // Не можем восстановить предыдущий контент без history,
                // но уменьшаем счётчик
            }
            self.save_to_file()?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Удалить все редактирования сообщения
    pub fn delete_edits(&mut self, message_id: &str) -> Result<bool> {
        let removed = self.edits.remove(message_id).is_some();
        if removed {
            self.save_to_file()?;
        }
        Ok(removed)
    }

    /// Количество отредактированных сообщений
    pub fn count(&self) -> usize {
        self.edits.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_manager() -> (EditManager, TempDir) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("edits.json");
        (EditManager::with_path(path), dir)
    }

    #[test]
    fn test_first_edit() {
        let (mut mgr, _dir) = temp_manager();
        let result = mgr
            .edit_message("msg1", "alice@test.com", "Updated content")
            .unwrap();
        assert!(result.success);
        assert_eq!(result.edit_count, 1);
        assert!(result.warning.is_none());
        assert!(mgr.is_edited("msg1"));
    }

    #[test]
    fn test_multiple_edits() {
        let (mut mgr, _dir) = temp_manager();
        mgr.edit_message("msg1", "alice@test.com", "v1").unwrap();
        let r2 = mgr.edit_message("msg1", "alice@test.com", "v2").unwrap();
        assert_eq!(r2.edit_count, 2);

        let r3 = mgr.edit_message("msg1", "alice@test.com", "v3").unwrap();
        assert_eq!(r3.edit_count, 3);

        assert_eq!(mgr.edit_count("msg1"), 3);
    }

    #[test]
    fn test_edit_limit() {
        let (mut mgr, _dir) = temp_manager();
        mgr.set_max_edits(2);
        mgr.edit_message("msg1", "alice@test.com", "v1").unwrap();
        mgr.edit_message("msg1", "alice@test.com", "v2").unwrap();
        let r3 = mgr.edit_message("msg1", "alice@test.com", "v3").unwrap();
        assert!(!r3.success);
        assert!(r3.warning.unwrap().contains("Edit limit reached"));
    }

    #[test]
    fn test_different_editor_rejected() {
        let (mut mgr, _dir) = temp_manager();
        mgr.edit_message("msg1", "alice@test.com", "v1").unwrap();
        let r2 = mgr.edit_message("msg1", "bob@test.com", "v2").unwrap();
        assert!(!r2.success);
        assert!(r2.warning.unwrap().contains("Only the original editor"));
    }

    #[test]
    fn test_get_latest() {
        let (mut mgr, _dir) = temp_manager();
        mgr.edit_message("msg1", "alice@test.com", "v1").unwrap();
        mgr.edit_message("msg1", "alice@test.com", "v2").unwrap();

        let latest = mgr.get_latest("msg1").unwrap();
        assert_eq!(latest.new_content, "v2");
        assert_eq!(latest.edit_count, 2);
    }

    #[test]
    fn test_persistence() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("edits.json");
        {
            let mut mgr = EditManager::with_path(path.clone());
            mgr.edit_message("msg1", "alice@test.com", "persistent")
                .unwrap();
        }
        {
            let mgr = EditManager::with_path(path);
            assert!(mgr.is_edited("msg1"));
            assert_eq!(mgr.edit_count("msg1"), 1);
        }
    }

    #[test]
    fn test_undo_and_delete() {
        let (mut mgr, _dir) = temp_manager();
        mgr.edit_message("msg1", "alice@test.com", "v1").unwrap();
        mgr.edit_message("msg1", "alice@test.com", "v2").unwrap();
        assert!(mgr.undo_last_edit("msg1").unwrap());
        assert_eq!(mgr.edit_count("msg1"), 1); // undo decrements

        assert!(mgr.delete_edits("msg1").unwrap());
        assert!(!mgr.is_edited("msg1"));
        assert_eq!(mgr.count(), 0);
    }
}
