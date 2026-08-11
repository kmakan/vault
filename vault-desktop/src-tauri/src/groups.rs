use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use anyhow::Result;
use rand::RngCore;
use chrono::Utc;
use hex;

const GROUPS_FILE: &str = "groups.json";

fn get_groups_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
    Ok(home.join(".vault"))
}

fn get_groups_path() -> Result<PathBuf> {
    // Tests (and power users) can redirect the storage file; keeps the real
    // `~/.vault/groups.json` untouched.
    if let Ok(p) = std::env::var("VAULT_GROUPS_FILE") {
        return Ok(PathBuf::from(p));
    }
    let dir = get_groups_dir()?;
    Ok(dir.join(GROUPS_FILE))
}
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum GroupRole {
    Admin,
    Member,
}
pub fn load_groups() -> Result<HashMap<String, Group>> {
    let path = get_groups_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let data = fs::read_to_string(&path)?;
    let groups: HashMap<String, Group> = serde_json::from_str(&data)?;
    Ok(groups)
}

pub fn save_groups(groups: &HashMap<String, Group>) -> Result<()> {
    let path = get_groups_path()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(groups)?;
    fs::write(&path, json)?;
    Ok(())
}

pub fn create_group(name: &str, creator: &str) -> Result<Group> {
    // Generate group id: grp_ + 16 hex chars (8 bytes)
    let mut id_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut id_bytes);
    let id = format!("grp_{}", hex::encode(id_bytes));

    // Generate group key: 32 bytes (64 hex chars)
    let mut key_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key_bytes);
    let group_key = hex::encode(key_bytes);

    let now = Utc::now().to_rfc3339();
    let mut members = Vec::new();
    members.push(GroupMember {
        email: creator.to_string(),
        role: GroupRole::Admin,
        joined_at: now.clone(),
        key_shared: true, // creator has the key
    });

    let group = Group {
        id,
        name: name.to_string(),
        created_by: creator.to_string(),
        created_at: now,
        members,
        blocked: Vec::new(),
        encrypted: true,
        group_key,
    };

    // Save to file
    let mut groups = load_groups()?;
    groups.insert(group.id.clone(), group.clone());
    save_groups(&groups)?;

    Ok(group)
}

pub fn add_member(group_id: &str, email: &str) -> Result<()> {
    let mut groups = load_groups()?;
    if let Some(group) = groups.get_mut(group_id) {
        // Check if member already exists
        if group.members.iter().any(|m| m.email == email) {
            return Ok(()); // already a member
        }
        let now = Utc::now().to_rfc3339();
        group.members.push(GroupMember {
            email: email.to_string(),
            role: GroupRole::Member,
            joined_at: now,
            key_shared: false, // new member does not have the key yet
        });
        save_groups(&groups)?;
    } else {
        anyhow::bail!("Group not found");
    }
    Ok(())
}

pub fn import_group(group_id: &str, name: &str, group_key: &str, sender: &str) -> Result<Group> {
    let mut groups = load_groups()?;
    let now = Utc::now().to_rfc3339();
    let mut members = Vec::new();

    if let Some(existing) = groups.get_mut(group_id) {
        // Update existing group
        existing.name = name.to_string();
        existing.group_key = group_key.to_string();
        // Ensure sender is in members
        if !existing.members.iter().any(|m| m.email == sender) {
            existing.members.push(GroupMember {
                email: sender.to_string(),
                role: GroupRole::Member,
                joined_at: now.clone(),
                key_shared: true, // sender has the key (just imported)
            });
        }
        // Clone before releasing the mutable borrow, then persist.
        let cloned = existing.clone();
        save_groups(&groups)?;
        return Ok(cloned);
    } else {
        // Create new group
        members.push(GroupMember {
            email: sender.to_string(),
            role: GroupRole::Member, // sender is added as a member with role Member
            joined_at: now.clone(),
            key_shared: true,
        });
        let group = Group {
            id: group_id.to_string(),
            name: name.to_string(),
            created_by: sender.to_string(), // Actually, created_by should be the original creator? But we don't have that info. We'll set to sender for now.
            created_at: now,
            members,
            blocked: Vec::new(),
            encrypted: true,
            group_key: group_key.to_string(),
        };
        groups.insert(group.id.clone(), group.clone());
        save_groups(&groups)?;
        Ok(group)
    }
}

pub fn set_group_key(group_id: &str, group_key: &str) -> Result<()> {
    let mut groups = load_groups()?;
    if let Some(group) = groups.get_mut(group_id) {
        group.group_key = group_key.to_string();
        save_groups(&groups)?;
    } else {
        anyhow::bail!("Group not found");
    }
    Ok(())
}
pub fn remove_member(group_id: &str, email: &str) -> Result<()> {
    let mut groups = load_groups()?;
    if let Some(group) = groups.get_mut(group_id) {
        let before_len = group.members.len();
        group.members.retain(|m| m.email != email);
        if group.members.len() == before_len {
            // member not found
            anyhow::bail!("Member not found in group");
        }
        save_groups(&groups)?;
    } else {
        anyhow::bail!("Group not found");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);
    /// Env vars are process-global, so tests that redirect VAULT_GROUPS_FILE
    /// must run one at a time (cargo runs tests in parallel by default).
    static TMP_LOCK: Mutex<()> = Mutex::new(());

    /// Point VAULT_GROUPS_FILE at a fresh temp file so tests never touch the
    /// real `~/.vault/groups.json`.
    fn with_tmp_groups<T>(f: impl FnOnce() -> T) -> T {
        let _guard = TMP_LOCK.lock().unwrap();
        let seq = TMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("vault-groups-test-{}-{}.json", std::process::id(), seq));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("VAULT_GROUPS_FILE", &path);
        let result = f();
        let _ = std::fs::remove_file(&path);
        std::env::remove_var("VAULT_GROUPS_FILE");
        result
    }

    #[test]
    fn test_create_group() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            assert_eq!(group.name, "test group");
            assert_eq!(group.created_by, "alice@example.com");
            assert_eq!(group.members.len(), 1);
            assert_eq!(group.members[0].email, "alice@example.com");
            assert_eq!(group.members[0].role, GroupRole::Admin);
            assert!(group.group_key.len() == 64); // 32 bytes hex
            assert!(group.id.starts_with("grp_"));
        });
    }

    #[test]
    fn test_add_member() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            add_member(&group.id, "bob@example.com").unwrap();
            let groups = load_groups().unwrap();
            let g = groups.get(&group.id).unwrap();
            assert_eq!(g.members.len(), 2);
            assert_eq!(g.members[1].email, "bob@example.com");
            assert_eq!(g.members[1].role, GroupRole::Member);
            assert!(!g.members[1].key_shared);
        });
    }

    #[test]
    fn test_import_group() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            let imported = import_group(&group.id, "test group", &group.group_key, "bob@example.com").unwrap();
            assert_eq!(imported.members.len(), 2);
            assert_eq!(imported.members[1].email, "bob@example.com");
            assert_eq!(imported.members[1].role, GroupRole::Member);
            assert_eq!(imported.group_key, group.group_key);
        });
    }

    #[test]
    fn test_set_group_key() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            let new_key = hex::encode([0u8; 32]);
            set_group_key(&group.id, &new_key).unwrap();
            let groups = load_groups().unwrap();
            let g = groups.get(&group.id).unwrap();
            assert_eq!(g.group_key, new_key);
        });
    }
}