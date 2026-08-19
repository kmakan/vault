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
    // Инвайт передаёт список участников только с email+role — при десериализации
    // отсутствующие поля получают значения по умолчанию.
    #[serde(default)]
    pub joined_at: String,
    #[serde(default)]
    pub key_shared: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum GroupRole {
    Admin,
    Moderator,
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
    // Атомарная запись: временный файл + rename. Прямой fs::write при
    // параллельном доступе (несколько окон/процессов) может оставить файл
    // обрезанным → следующий load получит пустой HashMap → потеря групп.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, &path)?;
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

pub fn import_group(
    group_id: &str,
    name: &str,
    group_key: &str,
    sender: &str,
    created_by: Option<&str>,
    invite_members: Option<&[GroupMember]>,
) -> Result<Group> {
    let mut groups = load_groups()?;
    let now = Utc::now().to_rfc3339();

    // Слить список участников инвайта с локальным: роли из инвайта авторитетны
    // для уже известных участников; новые участники добавляются с ролью из
    // инвайта (обычно Member). Отправитель инвайта всегда присутствует.
    let merge_members = |existing: &mut Vec<GroupMember>| {
        if let Some(inv) = invite_members {
            for im in inv {
                if im.email.is_empty() {
                    continue;
                }
                match existing.iter_mut().find(|m| m.email == im.email) {
                    Some(m) => m.role = im.role.clone(),
                    None => existing.push(GroupMember {
                        email: im.email.clone(),
                        role: im.role.clone(),
                        joined_at: now.clone(),
                        key_shared: false,
                    }),
                }
            }
        }
        if !existing.iter().any(|m| m.email == sender) {
            existing.push(GroupMember {
                email: sender.to_string(),
                role: GroupRole::Member,
                joined_at: now.clone(),
                key_shared: true, // sender has the key (just invited us)
            });
        }
    };

    if let Some(existing) = groups.get_mut(group_id) {
        // Update existing group
        existing.name = name.to_string();
        existing.group_key = group_key.to_string();
        if let Some(cb) = created_by {
            if !cb.is_empty() {
                existing.created_by = cb.to_string();
            }
        }
        merge_members(&mut existing.members);
        // Clone before releasing the mutable borrow, then persist.
        let cloned = existing.clone();
        save_groups(&groups)?;
        return Ok(cloned);
    }

    // Create new group
    let mut members = Vec::new();
    merge_members(&mut members);
    let group = Group {
        id: group_id.to_string(),
        name: name.to_string(),
        // Реальный создатель группы приходит в инвайте; без него — отправитель.
        created_by: created_by.filter(|s| !s.is_empty()).map(|s| s.to_string()).unwrap_or_else(|| sender.to_string()),
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
        // The group creator cannot be removed by anyone — only leave voluntarily.
        if email == group.created_by {
            anyhow::bail!("Cannot remove group creator");
        }
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

pub fn set_member_role(group_id: &str, email: &str, role: GroupRole) -> Result<()> {
    let mut groups = load_groups()?;
    if let Some(group) = groups.get_mut(group_id) {
        // The group creator cannot be demoted from Admin.
        if email == group.created_by && role != GroupRole::Admin {
            anyhow::bail!("Cannot change creator role");
        }
        let member = group.members.iter_mut().find(|m| m.email == email);
        match member {
            Some(m) => {
                m.role = role;
                save_groups(&groups)?;
            }
            None => anyhow::bail!("Member not found in group"),
        }
    } else {
        anyhow::bail!("Group not found");
    }
    Ok(())
}

pub fn delete_group(group_id: &str) -> Result<()> {
    let mut groups = load_groups()?;
    if groups.remove(group_id).is_some() {
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
    fn test_set_member_role() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            let id = group.id.clone();
            add_member(&id, "bob@example.com").unwrap();

            set_member_role(&id, "bob@example.com", GroupRole::Moderator).unwrap();
            let groups = load_groups().unwrap();
            let g = groups.get(&id).unwrap();
            assert_eq!(g.members[1].role, GroupRole::Moderator);

            set_member_role(&id, "bob@example.com", GroupRole::Member).unwrap();
            set_member_role(&id, "bob@example.com", GroupRole::Admin).unwrap();
            let groups = load_groups().unwrap();
            let g = groups.get(&id).unwrap();
            assert_eq!(g.members[1].role, GroupRole::Admin);

            // Creator cannot be brought below Admin.
            assert!(set_member_role(&id, "alice@example.com", GroupRole::Member).is_err());
            assert!(set_member_role(&id, "alice@example.com", GroupRole::Moderator).is_err());
            // Creator staying Admin is allowed (no-op).
            set_member_role(&id, "alice@example.com", GroupRole::Admin).unwrap();

            // Unknown member.
            assert!(set_member_role(&id, "nobody@example.com", GroupRole::Member).is_err());
            // Unknown group.
            assert!(set_member_role("grp_missing", "bob@example.com", GroupRole::Member).is_err());
        });
    }

    #[test]
    fn test_remove_member_protects_creator() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            let id = group.id.clone();
            add_member(&id, "bob@example.com").unwrap();

            // Creator cannot be removed by anyone (only voluntary leave).
            assert!(remove_member(&id, "alice@example.com").is_err());
            let groups = load_groups().unwrap();
            assert_eq!(groups.get(&id).unwrap().members.len(), 2);

            // Regular member removal still works.
            remove_member(&id, "bob@example.com").unwrap();
            let groups = load_groups().unwrap();
            assert_eq!(groups.get(&id).unwrap().members.len(), 1);

            // Unknown member / unknown group.
            assert!(remove_member(&id, "nobody@example.com").is_err());
            assert!(remove_member("grp_missing", "bob@example.com").is_err());
        });
    }

    #[test]
    fn test_import_group() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            let imported = import_group(&group.id, "test group", &group.group_key, "bob@example.com", None, None).unwrap();
            assert_eq!(imported.members.len(), 2);
            assert_eq!(imported.members[1].email, "bob@example.com");
            assert_eq!(imported.members[1].role, GroupRole::Member);
            assert_eq!(imported.group_key, group.group_key);
        });
    }

    #[test]
    fn test_import_group_with_roles() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            // Инвайт несёт создателя и список участников с ролями — импорт
            // должен сохранить их (иначе приглашённый видит всех как Member).
            let invite_members = vec![
                GroupMember {
                    email: "alice@example.com".into(),
                    role: GroupRole::Admin,
                    joined_at: String::new(),
                    key_shared: false,
                },
                GroupMember {
                    email: "carol@example.com".into(),
                    role: GroupRole::Moderator,
                    joined_at: String::new(),
                    key_shared: false,
                },
            ];
            let imported = import_group(
                &group.id,
                "test group",
                &group.group_key,
                "bob@example.com",
                Some("alice@example.com"),
                Some(&invite_members),
            )
            .unwrap();
            assert_eq!(imported.created_by, "alice@example.com");
            let alice = imported.members.iter().find(|m| m.email == "alice@example.com").unwrap();
            assert_eq!(alice.role, GroupRole::Admin);
            let carol = imported.members.iter().find(|m| m.email == "carol@example.com").unwrap();
            assert_eq!(carol.role, GroupRole::Moderator);
            assert!(imported.members.iter().any(|m| m.email == "bob@example.com"));
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

    #[test]
    fn test_delete_group() {
        with_tmp_groups(|| {
            let group = create_group("test group", "alice@example.com").unwrap();
            assert!(load_groups().unwrap().contains_key(&group.id));
            delete_group(&group.id).unwrap();
            assert!(!load_groups().unwrap().contains_key(&group.id));
            assert!(delete_group(&group.id).is_err()); // второй раз — уже нет
        });
    }
}