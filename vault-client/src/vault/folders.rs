use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// Папка для организации чатов (аналог папок в Telegram)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Folder {
    /// Уникальный идентификатор папки
    pub id: String,
    /// Отображаемое имя папки
    pub name: String,
    /// Иконка папки (эмодзи)
    pub icon: String,
    /// Список идентификаторов чатов (email-адреса или group_id)
    pub chats: Vec<String>,
    /// Время создания
    pub created_at: String,
}

impl Folder {
    /// Создать новую папку
    pub fn new(id: &str, name: &str, icon: &str) -> Self {
        Self {
            id: id.to_string(),
            name: name.to_string(),
            icon: icon.to_string(),
            chats: Vec::new(),
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }

    /// Проверить, содержит ли папка данный чат
    pub fn contains_chat(&self, chat_id: &str) -> bool {
        self.chats.contains(&chat_id.to_string())
    }
}

/// Менеджер папок с持久化 в JSON-файл
pub struct FolderStore {
    path: PathBuf,
    folders: HashMap<String, Folder>,
}

impl FolderStore {
    /// Создать хранилище с默认ным путём (~/.vault/folders.json)
    pub fn new() -> Self {
        let path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".vault")
            .join("folders.json");
        Self::with_path(path)
    }

    /// Создать хранилище с явным путём (для тестов)
    pub fn with_path(path: PathBuf) -> Self {
        let folders = Self::load_from_file(&path).unwrap_or_default();
        Self { path, folders }
    }

    /// Загрузить папки из файла
    fn load_from_file(path: &PathBuf) -> Result<HashMap<String, Folder>> {
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let data = fs::read_to_string(path).context("Failed to read folders file")?;
        let folders: HashMap<String, Folder> =
            serde_json::from_str(&data).context("Failed to parse folders file")?;
        Ok(folders)
    }

    /// Сохранить папки на диск
    fn save_to_file(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).context("Failed to create .vault directory")?;
        }
        let data =
            serde_json::to_string_pretty(&self.folders).context("Failed to serialize folders")?;
        fs::write(&self.path, data).context("Failed to write folders file")?;
        Ok(())
    }

    /// Создать новую папку. Возвращает false, если папка с таким именем уже существует.
    pub fn create_folder(&mut self, name: &str, icon: &str) -> Result<bool> {
        // Проверка на дубликат имени
        if self.folders.values().any(|f| f.name == name) {
            return Ok(false);
        }

        let id = format!("folder_{}", uuid_short());
        let folder = Folder::new(&id, name, icon);
        self.folders.insert(id, folder);
        self.save_to_file()?;
        Ok(true)
    }

    /// Удалить папку по ID
    pub fn delete_folder(&mut self, folder_id: &str) -> Result<bool> {
        let removed = self.folders.remove(folder_id).is_some();
        if removed {
            self.save_to_file()?;
        }
        Ok(removed)
    }

    /// Переименовать папку
    pub fn rename_folder(&mut self, folder_id: &str, new_name: &str) -> Result<bool> {
        // Проверка на дубликат имени (до mutable borrow)
        let duplicate = self
            .folders
            .values()
            .any(|f| f.name == new_name && f.id != folder_id);
        if duplicate {
            return Ok(false);
        }
        if let Some(folder) = self.folders.get_mut(folder_id) {
            folder.name = new_name.to_string();
            self.save_to_file()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Изменить иконку папки
    pub fn set_icon(&mut self, folder_id: &str, icon: &str) -> Result<bool> {
        if let Some(folder) = self.folders.get_mut(folder_id) {
            folder.icon = icon.to_string();
            self.save_to_file()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Добавить чат в папку
    pub fn add_chat(&mut self, folder_id: &str, chat_id: &str) -> Result<bool> {
        if let Some(folder) = self.folders.get_mut(folder_id) {
            if folder.contains_chat(chat_id) {
                return Ok(false); // Уже добавлен
            }
            folder.chats.push(chat_id.to_string());
            self.save_to_file()?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Убрать чат из папки
    pub fn remove_chat(&mut self, folder_id: &str, chat_id: &str) -> Result<bool> {
        if let Some(folder) = self.folders.get_mut(folder_id) {
            let before = folder.chats.len();
            folder.chats.retain(|c| c != chat_id);
            let removed = folder.chats.len() < before;
            if removed {
                self.save_to_file()?;
            }
            Ok(removed)
        } else {
            Ok(false)
        }
    }

    /// Получить папку по ID
    pub fn get_folder(&self, folder_id: &str) -> Option<&Folder> {
        self.folders.get(folder_id)
    }

    /// Получить папку по имени
    pub fn get_folder_by_name(&self, name: &str) -> Option<&Folder> {
        self.folders.values().find(|f| f.name == name)
    }

    /// Получить список всех папок
    pub fn list_folders(&self) -> Vec<&Folder> {
        let mut folders: Vec<&Folder> = self.folders.values().collect();
        folders.sort_by(|a, b| a.name.cmp(&b.name));
        folders
    }

    /// Получить список ID всех папок, содержащих данный чат
    pub fn folders_containing_chat(&self, chat_id: &str) -> Vec<&Folder> {
        self.folders
            .values()
            .filter(|f| f.contains_chat(chat_id))
            .collect()
    }

    /// Количество папок
    pub fn count(&self) -> usize {
        self.folders.len()
    }

    /// Удалить чат из всех папок (при удалении контакта)
    pub fn remove_chat_everywhere(&mut self, chat_id: &str) -> Result<usize> {
        let mut total_removed = 0;
        for folder in self.folders.values_mut() {
            let before = folder.chats.len();
            folder.chats.retain(|c| c != chat_id);
            total_removed += before - folder.chats.len();
        }
        if total_removed > 0 {
            self.save_to_file()?;
        }
        Ok(total_removed)
    }
}

/// Генератор короткого UUID (8 символов)
fn uuid_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:08x}", (t & 0xFFFFFFFF) as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn temp_store() -> (FolderStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("folders.json");
        (FolderStore::with_path(path), dir)
    }

    #[test]
    fn test_create_and_list_folders() {
        let (mut store, _dir) = temp_store();
        assert!(store.create_folder("Рабочие", "💼").unwrap());
        assert!(store.create_folder("Личные", "🏠").unwrap());
        assert_eq!(store.count(), 2);

        let list = store.list_folders();
        assert_eq!(list[0].name, "Личные"); // Сортировка по имени
        assert_eq!(list[1].name, "Рабочие");
    }

    #[test]
    fn test_duplicate_name_rejected() {
        let (mut store, _dir) = temp_store();
        assert!(store.create_folder("Work", "💼").unwrap());
        assert!(!store.create_folder("Work", "📋").unwrap());
        assert_eq!(store.count(), 1);
    }

    #[test]
    fn test_delete_folder() {
        let (mut store, _dir) = temp_store();
        store.create_folder("Temp", "🗑️").unwrap();
        let id = store.list_folders()[0].id.clone();
        assert!(store.delete_folder(&id).unwrap());
        assert_eq!(store.count(), 0);
        assert!(!store.delete_folder("nonexistent").unwrap());
    }

    #[test]
    fn test_rename_folder() {
        let (mut store, _dir) = temp_store();
        store.create_folder("Old Name", "📁").unwrap();
        let id = store.list_folders()[0].id.clone();
        assert!(store.rename_folder(&id, "New Name").unwrap());
        assert_eq!(store.get_folder(&id).unwrap().name, "New Name");
    }

    #[test]
    fn test_rename_duplicate_rejected() {
        let (mut store, _dir) = temp_store();
        store.create_folder("A", "📁").unwrap();
        store.create_folder("B", "📁").unwrap();
        let id_b = store.get_folder_by_name("B").unwrap().id.clone();
        assert!(!store.rename_folder(&id_b, "A").unwrap());
    }

    #[test]
    fn test_add_remove_chat() {
        let (mut store, _dir) = temp_store();
        store.create_folder("Friends", "👥").unwrap();
        let id = store.list_folders()[0].id.clone();

        assert!(store.add_chat(&id, "alice@test.com").unwrap());
        assert!(store.add_chat(&id, "bob@test.com").unwrap());
        // Дубликат — не добавляется
        assert!(!store.add_chat(&id, "alice@test.com").unwrap());

        assert!(store.remove_chat(&id, "alice@test.com").unwrap());
        assert!(!store.remove_chat(&id, "alice@test.com").unwrap()); // Уже удалён

        let folder = store.get_folder(&id).unwrap();
        assert_eq!(folder.chats, vec!["bob@test.com"]);
    }

    #[test]
    fn test_folders_containing_chat() {
        let (mut store, _dir) = temp_store();
        store.create_folder("Work", "💼").unwrap();
        store.create_folder("Family", "👨‍👩‍👧").unwrap();
        let ids: Vec<String> = store.list_folders().iter().map(|f| f.id.clone()).collect();

        store.add_chat(&ids[0], "boss@work.com").unwrap();
        store.add_chat(&ids[1], "boss@work.com").unwrap();

        let found = store.folders_containing_chat("boss@work.com");
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn test_remove_chat_everywhere() {
        let (mut store, _dir) = temp_store();
        store.create_folder("A", "📁").unwrap();
        store.create_folder("B", "📁").unwrap();
        let ids: Vec<String> = store.list_folders().iter().map(|f| f.id.clone()).collect();

        store.add_chat(&ids[0], "x@test.com").unwrap();
        store.add_chat(&ids[1], "x@test.com").unwrap();

        let removed = store.remove_chat_everywhere("x@test.com").unwrap();
        assert_eq!(removed, 2);
        assert!(store.get_folder(&ids[0]).unwrap().chats.is_empty());
        assert!(store.get_folder(&ids[1]).unwrap().chats.is_empty());
    }

    #[test]
    fn test_persistence() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("folders.json");

        // Создаём и сохраняем
        {
            let mut store = FolderStore::with_path(path.clone());
            store.create_folder("Persistent", "💾").unwrap();
            let id = store.list_folders()[0].id.clone();
            store.add_chat(&id, "test@test.com").unwrap();
        }

        // Загружаем из файла и проверяем
        {
            let store = FolderStore::with_path(path);
            assert_eq!(store.count(), 1);
            let folder = store.list_folders()[0];
            assert_eq!(folder.name, "Persistent");
            assert_eq!(folder.chats, vec!["test@test.com"]);
        }
    }

    #[test]
    fn test_folder_contains_chat() {
        let folder = Folder::new("f1", "Test", "📁");
        assert!(!folder.contains_chat("alice@test.com"));

        let mut folder = folder;
        folder.chats.push("alice@test.com".to_string());
        assert!(folder.contains_chat("alice@test.com"));
    }

    #[test]
    fn test_set_icon() {
        let (mut store, _dir) = temp_store();
        store.create_folder("Test", "📁").unwrap();
        let id = store.list_folders()[0].id.clone();
        assert!(store.set_icon(&id, "⭐").unwrap());
        assert_eq!(store.get_folder(&id).unwrap().icon, "⭐");
        assert!(!store.set_icon("nonexistent", "⭐").unwrap());
    }
}
