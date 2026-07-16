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

    /// Promote member to admin
    pub fn promote_member(
        &mut self,
        group_id: &str,
        email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(group) = self.groups.get_mut(group_id) {
            let member = group.members.iter_mut().find(|m| m.email == email);
            match member {
                Some(m) => {
                    m.role = GroupRole::Admin;
                    self.save()?;
                    Ok(())
                }
                None => Err("Member not found in group".into()),
            }
        } else {
            Err("Group not found".into())
        }
    }

    /// Demote admin to member
    pub fn demote_member(
        &mut self,
        group_id: &str,
        email: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        if let Some(group) = self.groups.get_mut(group_id) {
            // Cannot demote the group creator
            if group.created_by == email {
                return Err("Cannot demote the group creator".into());
            }
            let member = group.members.iter_mut().find(|m| m.email == email);
            match member {
                Some(m) => {
                    m.role = GroupRole::Member;
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
        std::fs::write(&self.storage_path, data)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_group() {
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test Group", "admin@test.com").unwrap();
        assert_eq!(group.name, "Test Group");
        assert_eq!(group.members.len(), 1);
        assert!(group.encrypted);
    }

    #[test]
    fn test_add_member() {
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        let g = mgr.get_group(&group.id).unwrap();
        assert_eq!(g.members.len(), 2);
    }

    #[test]
    fn test_remove_member() {
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        mgr.remove_member(&group.id, "user@test.com").unwrap();
        let g = mgr.get_group(&group.id).unwrap();
        assert_eq!(g.members.len(), 1);
    }

    #[test]
    fn test_duplicate_member() {
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        assert!(mgr.add_member(&group.id, "admin@test.com").is_err());
    }

    #[test]
    fn test_promote_member() {
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        mgr.promote_member(&group.id, "user@test.com").unwrap();
        let g = mgr.get_group(&group.id).unwrap();
        let m = g
            .members
            .iter()
            .find(|m| m.email == "user@test.com")
            .unwrap();
        assert!(matches!(m.role, GroupRole::Admin));
    }

    #[test]
    fn test_demote_member() {
        let mut mgr = GroupManager::new();
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
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        assert!(mgr.demote_member(&group.id, "admin@test.com").is_err());
    }

    #[test]
    fn test_block_user() {
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.add_member(&group.id, "user@test.com").unwrap();
        mgr.block_user(&group.id, "user@test.com").unwrap();
        assert!(mgr.is_blocked(&group.id, "user@test.com"));
        assert_eq!(mgr.get_blocked(&group.id).len(), 1);
    }

    #[test]
    fn test_unblock_user() {
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.block_user(&group.id, "user@test.com").unwrap();
        mgr.unblock_user(&group.id, "user@test.com").unwrap();
        assert!(!mgr.is_blocked(&group.id, "user@test.com"));
        assert_eq!(mgr.get_blocked(&group.id).len(), 0);
    }

    #[test]
    fn test_block_already_blocked() {
        let mut mgr = GroupManager::new();
        let group = mgr.create_group("Test", "admin@test.com").unwrap();
        mgr.block_user(&group.id, "user@test.com").unwrap();
        assert!(mgr.block_user(&group.id, "user@test.com").is_err());
    }
}
