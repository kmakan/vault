use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Group chat (Signal model)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub created_by: String,
    pub created_at: String,
    pub members: Vec<GroupMember>,
    #[serde(default)]
    pub blocked: Vec<String>,
    pub encrypted: bool,
    /// Hex-encoded 32-byte key for group encryption (XChaCha20-Poly1305)
    #[serde(default)]
    pub group_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupMember {
    pub email: String,
    pub role: GroupRole,
    pub joined_at: String,
    pub key_shared: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum GroupRole {
    Admin,
    Moderator,
    Member,
}

/// Group manager
pub struct GroupManager {
    groups: HashMap<String, Group>,
    storage_path: PathBuf,
}

impl GroupManager {
    pub fn new() -> Self {
        let storage_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".vault")
            .join("groups.json");

        Self::with_path(storage_path)
    }

    /// Create a manager backed by a specific storage file (used by tests to
    /// keep the real `~/.vault/groups.json` untouched).
    pub fn with_path(storage_path: PathBuf) -> Self {
        let groups = if storage_path.exists() {
            let data = std::fs::read_to_string(&storage_path).unwrap_or_default();
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            HashMap::new()
        };

        Self {
            groups,
            storage_path,
        }
    }

    /// Create a new group
    pub fn create_group(
        &mut self,
        name: &str,
        creator: &str,
    ) -> Result<Group, Box<dyn std::error::Error>> {
        let id = format!("grp_{}", hex::encode(&uuid::Uuid::new_v4().as_bytes()[..8]));
        // Generate a random 32-byte key for the group
        let mut key_bytes = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut key_bytes);
        let group_key = hex::encode(key_bytes);
        let group = Group {
            id: id.clone(),
            name: name.to_string(),
            created_by: creator.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
            members: vec![GroupMember {
                email: creator.to_string(),
                role: GroupRole::Admin,
                joined_at: chrono::Utc::now().to_rfc3339(),
                key_shared: false,
            }],
            blocked: Vec::new(),
            encrypted: true,
            group_key,
        };

        self.groups.insert(id.clone(), group.clone());
        self.save()?;
        Ok(group)
    }

    /// Add member to group
    pub fn add_member(
        &mut self,
        group_id: &str,
        email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(group) = self.groups.get_mut(group_id) {
            if group.members.iter().any(|m| m.email == email) {
                return Err("Member already in group".into());
            }

            group.members.push(GroupMember {
                email: email.to_string(),
                role: GroupRole::Member,
                joined_at: chrono::Utc::now().to_rfc3339(),
                key_shared: false,
            });

            self.save()?;
            Ok(())
        } else {
            Err("Group not found".into())
        }
    }

    /// Remove member from group
    pub fn remove_member(
        &mut self,
        group_id: &str,
        email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(group) = self.groups.get_mut(group_id) {
            group.members.retain(|m| m.email != email);
            self.save()?;
            Ok(())
        } else {
            Err("Group not found".into())
        }
    }

    /// Get group by ID
    pub fn get_group(&self, group_id: &str) -> Option<&Group> {
        self.groups.get(group_id)
    }

    /// List all groups
    pub fn list_groups(&self) -> Vec<&Group> {
        self.groups.values().collect()
    }

    /// Delete group
    pub fn delete_group(&mut self, group_id: &str) -> Result<(), Box<dyn std::error::Error>> {
        self.groups.remove(group_id);
        self.save()?;
        Ok(())
    }

    /// Promote member to Admin (Member -> Admin). Admin promote is a no-op.
    pub fn promote_member(
        &mut self,
        group_id: &str,
        email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(group) = self.groups.get_mut(group_id) {
            let member = group.members.iter_mut().find(|m| m.email == email);
            match member {
                Some(m) => {
                    m.role = match m.role {
                        GroupRole::Member => GroupRole::Admin,
                        GroupRole::Admin => GroupRole::Admin,
                        // Legacy role: a stored Moderator becomes a plain member.
                        GroupRole::Moderator => GroupRole::Member,
                    };
                    self.save()?;
                    Ok(())
                }
                None => Err("Member not found in group".into()),
            }
        } else {
            Err("Group not found".into())
        }
    }

    /// Demote member to Member (Admin -> Member). Member demote is a no-op.
    pub fn demote_member(
        &mut self,
        group_id: &str,
        email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(group) = self.groups.get_mut(group_id) {
            // Cannot demote the group creator while they hold Admin.
            if group.created_by == email {
                let is_admin = group
                    .members
                    .iter()
                    .any(|m| m.email == email && matches!(m.role, GroupRole::Admin));
                if is_admin {
                    return Err("Cannot demote the group creator".into());
                }
            }
            let member = group.members.iter_mut().find(|m| m.email == email);
            match member {
                Some(m) => {
                    m.role = match m.role {
                        GroupRole::Admin => GroupRole::Member,
                        GroupRole::Member => GroupRole::Member,
                        // Legacy role: a stored Moderator becomes a plain member.
                        GroupRole::Moderator => GroupRole::Member,
                    };
                    self.save()?;
                    Ok(())
                }
                None => Err("Member not found in group".into()),
            }
        } else {
            Err("Group not found".into())
        }
    }

    /// Block user in group (messages from blocked users are hidden)
    pub fn block_user(
        &mut self,
        group_id: &str,
        email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(group) = self.groups.get_mut(group_id) {
            if group.blocked.iter().any(|e| e == email) {
                return Err("User already blocked".into());
            }
            group.blocked.push(email.to_string());
            self.save()?;
            Ok(())
        } else {
            Err("Group not found".into())
        }
    }

    /// Unblock user in group
    pub fn unblock_user(
        &mut self,
        group_id: &str,
        email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(group) = self.groups.get_mut(group_id) {
            group.blocked.retain(|e| e != email);
            self.save()?;
            Ok(())
        } else {
            Err("Group not found".into())
        }
    }

    /// Import a group from an invitation (used when accepting a group invite)
    /// Creates the group if it doesn't exist, or updates the group key if it does.
    /// The sender is added as a member with role Member (unless they are the creator).
    pub fn import_group(
        &mut self,
        group_id: &str,
        group_name: &str,
        group_key: &str,
        sender_email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut group = self.groups.remove(group_id).unwrap_or_else(|| Group {
            id: group_id.to_string(),
            name: group_name.to_string(),
            created_by: sender_email.to_string(), // The sender is considered the creator for the imported group
            created_at: chrono::Utc::now().to_rfc3339(),
            members: Vec::new(),
            blocked: Vec::new(),
            encrypted: true,
            group_key: group_key.to_string(),
        });

        // Ensure the group key is set (if the group existed but had no key, we set it)
        if group.group_key.is_empty() {
            group.group_key = group_key.to_string();
        }

        // Add the sender as a member if not already present
        if !group.members.iter().any(|m| m.email == sender_email) {
            group.members.push(GroupMember {
                email: sender_email.to_string(),
                role: GroupRole::Member,
                joined_at: chrono::Utc::now().to_rfc3339(),
                key_shared: false,
            });
        }

        self.groups.insert(group_id.to_string(), group);
        self.save()?;
        Ok(())
    }

    /// Check if user is blocked in group
    pub fn is_blocked(&self, group_id: &str, email: &str) -> bool {
        self.groups
            .get(group_id)
            .map(|g| g.blocked.iter().any(|e| e == email))
            .unwrap_or(false)
    }

    /// Get blocked users list
    pub fn get_blocked(&self, group_id: &str) -> Vec<String> {
        self.groups
            .get(group_id)
            .map(|g| g.blocked.clone())
            .unwrap_or_default()
    }

    fn save(&self) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(parent) = self.storage_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(&self.groups)?;
        // Атомарная запись: сначала во временный файл рядом, затем rename.
        // Прямой fs::write (truncate+write) при параллельном доступе
        // (несколько процессов/тестов) оставляет файл пустым/обрезанным,
        // и следующий load получает пустой HashMap → потеря групп.
        let tmp = self.storage_path.with_extension("json.tmp");
        std::fs::write(&tmp, data)?;
        std::fs::rename(&tmp, &self.storage_path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Каждый тест получает GroupManager с УНИКАЛЬНЫМ временным файлом.
    /// Раньше тесты использовали test_mgr() → писали в реальный
    /// ~/.vault/groups.json; при параллельном прогоне (cargo test) это
    /// гонка read-modify-write, которая затирала живые группы пользователя.
    fn test_mgr() -> GroupManager {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "vault-groups-test-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        GroupManager::with_path(dir.join("groups.json"))
    }

    #[test]
    fn test_create_group() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test Group", "admin@test.com").unwrap();
        assert_eq!(group.name, "Test Group");
        assert_eq!(group.members.len(), 1);
        assert!(group.encrypted);
    }

    #[test]
    fn test_add_member() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        let g = mgr.get_group(&group.id).unwrap();
        assert_eq!(g.members.len(), 2);
    }

    #[test]
    fn test_remove_member() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        mgr.remove_member(&group.id, "user@test.com").unwrap();
        let g = mgr.get_group(&group.id).unwrap();
        assert_eq!(g.members.len(), 1);
    }

    #[test]
    fn test_duplicate_member() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        assert!(mgr.add_member(&group.id, "admin@test.com").is_err());
    }

    #[test]
    fn test_promote_member() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        // Member -> Admin (single step, no Moderator tier)
        mgr.promote_member(&group.id, "user@test.com").unwrap();
        let g = mgr.get_group(&group.id).unwrap();
        let m = g
            .members
            .iter()
            .find(|m| m.email == "user@test.com")
            .unwrap();
        assert!(matches!(m.role, GroupRole::Admin));
        // Admin -> Admin (no-op)
        mgr.promote_member(&group.id, "user@test.com").unwrap();
    }

    #[test]
    fn test_demote_member() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        mgr.promote_member(&group.id, "user@test.com").unwrap();
        mgr.demote_member(&group.id, "user@test.com").unwrap();
        let g = mgr.get_group(&group.id).unwrap();
        let m = g
            .members
            .iter()
            .find(|m| m.email == "user@test.com")
            .unwrap();
        assert!(matches!(m.role, GroupRole::Member));
    }

    #[test]
    fn test_cannot_demote_creator() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        assert!(mgr.demote_member(&group.id, "admin@test.com").is_err());
    }

    #[test]
    fn test_block_user() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        mgr.block_user(&group.id, "user@test.com").unwrap();
        assert!(mgr.is_blocked(&group.id, "user@test.com"));
        assert_eq!(mgr.get_blocked(&group.id).len(), 1);
    }

    #[test]
    fn test_unblock_user() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.block_user(&group.id, "user@test.com").unwrap();
        mgr.unblock_user(&group.id, "user@test.com").unwrap();
        assert!(!mgr.is_blocked(&group.id, "user@test.com"));
        assert_eq!(mgr.get_blocked(&group.id).len(), 0);
    }

    #[test]
    fn test_block_already_blocked() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.block_user(&group.id, "user@test.com").unwrap();
        assert!(mgr.block_user(&group.id, "user@test.com").is_err());
    }

    #[test]
    fn test_create_group_generates_key() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Keyed", "admin@test.com").unwrap();
        assert_eq!(group.group_key.len(), 64, "32 bytes as hex");
        hex::decode(&group.group_key).expect("valid hex");
    }

    #[test]
    fn test_import_group_creates_with_key() {
        let mut mgr = test_mgr();
        mgr.import_group("grp_import", "Imported", &"ab".repeat(32), "alice@test.com")
            .unwrap();
        let g = mgr.get_group("grp_import").unwrap();
        assert_eq!(g.group_key, "ab".repeat(32));
        assert!(g.members.iter().any(|m| m.email == "alice@test.com"));
    }

    #[test]
    fn test_import_group_updates_existing_key() {
        let mut mgr = test_mgr();
        let group = mgr.create_group("Keyed", "admin@test.com").unwrap();
        // Simulate a group without a key (legacy storage)
        let mut g = mgr.get_group(&group.id).unwrap().clone();
        g.group_key = String::new();
        mgr.groups.insert(group.id.clone(), g);
        mgr.import_group(&group.id, "Keyed", &"cd".repeat(32), "bob@test.com")
            .unwrap();
        let g = mgr.get_group(&group.id).unwrap();
        assert_eq!(g.group_key, "cd".repeat(32));
        assert!(g.members.iter().any(|m| m.email == "bob@test.com"));
    }
}
