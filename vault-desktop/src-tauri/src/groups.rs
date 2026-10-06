use anyhow::Result;
use chrono::Utc;
use hex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

const GROUPS_FILE: &str = "groups.json";

fn get_groups_dir() -> Result<PathBuf> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("Cannot determine home directory"))?;
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
    /// Fingerprint публичного ключа участника
    /// 128-hex id — стабилен при смене почты. Пустой у старых групп —
    /// лениво заполняется фронтендом при первом fingerprint-матче.
    /// Инвайты старых версий его не несут — десериализация остаётся совместимой.
    #[serde(default)]
    pub fingerprint: String,
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
        key_shared: true,
        fingerprint: String::new(), // creator has the key
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
            key_shared: false,
            fingerprint: String::new(), // new member does not have the key yet
        });
        save_groups(&groups)?;
    } else {
        anyhow::bail!("Group not found");
    }
    Ok(())
}

/// Миграция участника группы на новый адрес (смена почты). Старый и новый
/// адреса должны быть привязаны к одному fingerprint (peer_keys) — это
/// проверяет фронт перед вызовом (см. inviteSelectedMembers). Правит:
/// members (email), created_by, invited-метки. Идемпотентно.
pub fn rename_member(group_id: &str, old_email: &str, new_email: &str) -> Result<()> {
    let mut groups = load_groups()?;
    if let Some(group) = groups.get_mut(group_id) {
        let old_lc = old_email.to_lowercase();
        let new_lc = new_email.to_lowercase();
        // Смена почты собеседником. ДВА случая, оба обязательны:
        //
        // (а) Участника под старым адресом нет, но НОВЫЙ адрес уже есть —
        //     ничего не делаем (идемпотентность: повторный ренейм/гонка
        //     писем). Без этой ветки вставка создала бы ВТОРОГО участника.
        // (б) Оба адреса в группе — переименование превратило бы группу в
        //     «участник дважды с одним отпечатком» (живые данные 06.10.2026,
        //     группа «Четыре»). Убираем СТАРУЮ запись, оставляем существующую
        //     НОВУЮ (она авторитетнее: пришла из свежего инвайта/письма).
        let old_idx = group
            .members
            .iter()
            .position(|m| m.email.to_lowercase() == old_lc);
        let new_idx = group
            .members
            .iter()
            .position(|m| m.email.to_lowercase() == new_lc);
        match (old_idx, new_idx) {
            (None, _) => { /* старого нет — ренеймить нечего */ }
            (Some(i), Some(j)) if i != j => {
                // Дубль: удаляем старую запись, новой помечаем общий ключ.
                group.members.remove(i);
                let k = if i < j { j - 1 } else { j };
                if let Some(m) = group.members.get_mut(k) {
                    m.key_shared = true;
                }
            }
            (Some(i), _) => {
                group.members[i].email = new_email.to_string();
                group.members[i].key_shared = true; // ключ группы у него уже есть
            }
        }
        if group.created_by.to_lowercase() == old_lc {
            group.created_by = new_email.to_string();
        }
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
                        fingerprint: String::new(),
                    }),
                }
            }
        }
        if !existing.iter().any(|m| m.email == sender) {
            existing.push(GroupMember {
                email: sender.to_string(),
                role: GroupRole::Member,
                joined_at: now.clone(),
                key_shared: true,
                fingerprint: String::new(), // sender has the key (just invited us)
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
        created_by: created_by
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| sender.to_string()),
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

pub fn rename_group(group_id: &str, new_name: &str) -> Result<Group> {
    let mut groups = load_groups()?;
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        anyhow::bail!("Group name cannot be empty");
    }
    let grp = groups
        .get_mut(group_id)
        .ok_or_else(|| anyhow::anyhow!("Group not found: {group_id}"))?;
    grp.name = trimmed.to_string();
    let cloned = grp.clone();
    save_groups(&groups)?;
    Ok(cloned)
}

/// Стереть ВСЕ локальные группы.
pub fn delete_all_local() -> Result<()> {
    let path = get_groups_path()?;
    if path.exists() {
        fs::remove_file(&path)?;
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

/// Чистая функция: «мои группы» — fp-first, адрес как fallback.
///
/// Идентичность участника = fingerprint публичного ключа; он не меняется при
/// смене почты. Адрес (email) — это транспорт и legacy-fallback: он работает
/// только когда fp недоступен (старые группы/базы).
///
/// История: регрессия 05–06.10.2026 — строгое сравнение по email отсекало все
/// группы после смены почты (группы «исчезали», данные были целы).
pub fn filter_own_groups(
    groups: &[Group],
    my_email: &str,
    my_fingerprint: &str,
    aliases: &[String],
) -> Vec<Group> {
    let email = my_email.trim().to_lowercase();
    let fp = my_fingerprint.trim().to_lowercase();
    let mut mine: std::collections::HashSet<String> = std::iter::once(email.clone()).collect();
    for a in aliases {
        let v = a.trim().to_lowercase();
        if !v.is_empty() {
            mine.insert(v);
        }
    }

    groups
        .iter()
        .filter(|g| {
            let cb = g.created_by.trim().to_lowercase();
            if !cb.is_empty() && (cb == email || mine.contains(&cb)) {
                return true;
            }
            g.members.iter().any(|m| {
                let me = m.email.trim().to_lowercase();
                if !me.is_empty() && mine.contains(&me) {
                    return true;
                }
                let mfp = m.fingerprint.trim().to_lowercase();
                !fp.is_empty() && !mfp.is_empty() && mfp == fp
            })
        })
        .cloned()
        .collect()
}

/// Массовое заполнение СОБСТВЕННОГО fingerprint у участников во ВСЕХ группах.
///
/// Заполняет поле `fingerprint` участников, чей email совпадает с данным
/// (без учёта регистра) и у которых поле пустое — ленивая миграция старых
/// groups.json, которые никто не открывал в UI (там fp заполняется только
/// при открытии группы). Без этого fp-only фильтр `filter_own_groups` такие
/// группы не находит.
///
/// Идемпотентно (как groups_save_member_fingerprints): существующие НЕПУСТЫЕ
/// fingerprint не затираются; пустой fingerprint после trim — no-op (ничего
/// не пишем, возвращаем 0). Сохранение — только если что-то обновилось.
///
/// Возвращает число обновлённых участников.
pub fn backfill_my_fingerprint(email: &str, fingerprint: &str) -> Result<usize> {
    let fp = fingerprint.trim().to_lowercase();
    // Защита от затирания пустотой: не пишем ничего.
    if fp.is_empty() {
        return Ok(0);
    }
    let email = email.trim();
    if email.is_empty() {
        return Ok(0);
    }

    let mut groups = load_groups()?;
    let mut updates = 0usize;
    for group in groups.values_mut() {
        for m in group.members.iter_mut() {
            if !m.fingerprint.is_empty() {
                continue; // не затираем существующий (идемпотентность)
            }
            if m.email.eq_ignore_ascii_case(email) {
                m.fingerprint = fp.clone();
                updates += 1;
            }
        }
    }
    if updates > 0 {
        save_groups(&groups)?;
    }
    Ok(updates)
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
        let path = std::env::temp_dir().join(format!(
            "vault-groups-test-{}-{}.json",
            std::process::id(),
            seq
        ));
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
            let imported = import_group(
                &group.id,
                "test group",
                &group.group_key,
                "bob@example.com",
                None,
                None,
            )
            .unwrap();
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
                    fingerprint: String::new(),
                },
                GroupMember {
                    email: "carol@example.com".into(),
                    role: GroupRole::Moderator,
                    joined_at: String::new(),
                    key_shared: false,
                    fingerprint: String::new(),
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
            let alice = imported
                .members
                .iter()
                .find(|m| m.email == "alice@example.com")
                .unwrap();
            assert_eq!(alice.role, GroupRole::Admin);
            let carol = imported
                .members
                .iter()
                .find(|m| m.email == "carol@example.com")
                .unwrap();
            assert_eq!(carol.role, GroupRole::Moderator);
            assert!(imported
                .members
                .iter()
                .any(|m| m.email == "bob@example.com"));
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

    // ── Membership по fingerprint ─────────────────────────────────

    #[test]
    fn test_rename_member_keeps_membership_on_email_change() {
        // Смена почты участника: адрес мигрирует, роль и факт владения ключом
        // группы сохраняются (главный сценарий fingerprint-membership).
        with_tmp_groups(|| {
            let group = create_group("g", "alice@example.com").unwrap();
            add_member(&group.id, "bob@example.com").unwrap();
            rename_member(&group.id, "bob@example.com", "bob@newmail.com").unwrap();
            let g = load_groups().unwrap().get(&group.id).unwrap().clone();
            assert!(g.members.iter().any(|m| m.email == "bob@newmail.com"));
            assert!(!g.members.iter().any(|m| m.email == "bob@example.com"));
            let bob = g
                .members
                .iter()
                .find(|m| m.email == "bob@newmail.com")
                .unwrap();
            assert_eq!(bob.role, GroupRole::Member);
            assert!(bob.key_shared); // ключ группы остался у него
        });
    }

    #[test]
    fn test_rename_member_does_not_duplicate_when_new_email_already_member() {
        // Живые данные 06.10.2026 (группа «Четыре»): телефон сменил почту, и в
        // группе оказались ОБА адреса с одним отпечатком. Наивный ренейм
        // превратил бы это в «участник дважды» — а второй участник ломает
        // счётчик, роли и права. Проверяем: остаётся ОДНА запись с новым
        // адресом, старая исчезает, дубля нет.
        with_tmp_groups(|| {
            let group = create_group("g", "alice@example.com").unwrap();
            add_member(&group.id, "bob@ya.ru").unwrap();
            add_member(&group.id, "bob@new.ru").unwrap();
            rename_member(&group.id, "bob@ya.ru", "bob@new.ru").unwrap();

            let g = load_groups().unwrap().get(&group.id).unwrap().clone();
            let bobs: Vec<_> = g
                .members
                .iter()
                .filter(|m| m.email == "bob@new.ru")
                .collect();
            assert_eq!(
                bobs.len(),
                1,
                "должен остаться РОВНО один участник с новым адресом"
            );
            assert!(
                !g.members.iter().any(|m| m.email == "bob@ya.ru"),
                "старый адрес обязан исчезнуть"
            );
            assert!(bobs[0].key_shared, "ключ группы у участника уже есть");

            // Идемпотентность: повторный ренейм не создаёт дубль и не падает.
            rename_member(&group.id, "bob@ya.ru", "bob@new.ru").unwrap();
            let g2 = load_groups().unwrap().get(&group.id).unwrap().clone();
            let n = g2
                .members
                .iter()
                .filter(|m| m.email == "bob@new.ru")
                .count();
            assert_eq!(n, 1, "повторный вызов не должен добавлять участника");
        });
    }

    #[test]
    fn test_fingerprint_field_backfill_and_compat() {
        // Поле fingerprint: serde default — старые groups.json (без поля)
        // десериализуются; заполнение не затирает существующее значение.
        with_tmp_groups(|| {
            let group = create_group("g", "alice@example.com").unwrap();
            // Ручная запись «старого» формата (без fingerprint) читается.
            let raw = serde_json::json!({
                "grp_legacy": {
                    "id": "grp_legacy",
                    "name": "old",
                    "created_by": "a@x.com",
                    "created_at": "2026-01-01T00:00:00Z",
                    "members": [
                        {"email": "a@x.com", "role": "Admin", "joined_at": "", "key_shared": true}
                    ],
                    "encrypted": true,
                    "group_key": "aa"
                }
            });
            std::fs::write(
                std::env::var("VAULT_GROUPS_FILE").unwrap(),
                serde_json::to_string(
                    &serde_json::from_str::<HashMap<String, Group>>(&raw.to_string()).unwrap(),
                )
                .unwrap(),
            )
            .unwrap();
            let groups = load_groups().unwrap();
            let legacy = groups.get("grp_legacy").unwrap();
            assert!(legacy.members[0].fingerprint.is_empty()); // default = ""
        });
    }

    // ─── Смена СОБСТВЕННОЙ почты (регрессия 05–06.10.2026) ───
    //
    // На телефоне после смены koanmak@ya.ru → vault-msg@ya.ru группы исчезли из
    // UI: в groups.json оставался старый адрес, а UI сравнивал строго по email.
    // Ниже — проверка данных на уровне Rust, где им и место: после переименования
    // старый адрес не должен оставаться НИГДЕ, а fingerprint участника (то, что
    // реально не меняется при смене почты) обязан выжить.

    #[test]
    fn test_own_email_change_renames_across_all_groups_and_keeps_fingerprint() {
        with_tmp_groups(|| {
            let g1 = create_group("Моя", "me@old.com").unwrap();
            let g2 = create_group("Чужая", "other@x.com").unwrap();
            add_member(&g2.id, "me@old.com").unwrap();
            add_member(&g2.id, "third@y.com").unwrap();

            // Проставляем fingerprint владельцу (как при обмене ключами).
            let mut groups = load_groups().unwrap();
            for id in [&g1.id, &g2.id] {
                let gm = groups.get_mut(id).unwrap();
                for m in gm.members.iter_mut() {
                    if m.email == "me@old.com" {
                        m.fingerprint = "fp-mine-0123456789".into();
                    }
                }
            }
            save_groups(&groups).unwrap();

            // Смена почты: владелец переименовывает себя в ОБЕИХ группах.
            rename_member(&g1.id, "me@old.com", "me@new.com").unwrap();
            rename_member(&g2.id, "me@old.com", "me@new.com").unwrap();

            let groups = load_groups().unwrap();
            // Ни в одной группе не осталось старого адреса…
            for (id, g) in groups.iter() {
                assert!(
                    !g.members.iter().any(|m| m.email == "me@old.com"),
                    "старый адрес остался участником в группе {id}"
                );
                assert_ne!(
                    g.created_by, "me@old.com",
                    "старый адрес остался создателем {id}"
                );
            }
            // …а новый есть в обеих, с тем же fingerprint и правами.
            for id in [&g1.id, &g2.id] {
                let me = groups
                    .get(id)
                    .unwrap()
                    .members
                    .iter()
                    .find(|m| m.email == "me@new.com")
                    .unwrap_or_else(|| panic!("новый адрес не найден в {id}"));
                assert_eq!(
                    me.fingerprint, "fp-mine-0123456789",
                    "fingerprint обязан пережить смену почты"
                );
                assert!(me.key_shared, "факт владения ключом группы сохраняется");
            }
            // Чужой участник не тронут.
            assert!(groups
                .get(&g2.id)
                .unwrap()
                .members
                .iter()
                .any(|m| m.email == "third@y.com"));
            // Права создателя сохранены.
            assert_eq!(groups.get(&g1.id).unwrap().created_by, "me@new.com");
        });
    }

    #[test]
    fn test_email_change_is_idempotent_and_does_not_touch_absent_member() {
        with_tmp_groups(|| {
            let g = create_group("g", "alice@old.com").unwrap();
            add_member(&g.id, "bob@old.com").unwrap();

            // Переименование отсутствующего участника не должно падать…
            rename_member(&g.id, "nobody@old.com", "nobody@new.com").unwrap();
            let after = load_groups().unwrap();
            assert!(after
                .get(&g.id)
                .unwrap()
                .members
                .iter()
                .any(|m| m.email == "bob@old.com"));

            // …а повторное переименование того же адреса — тоже (нет дублей).
            rename_member(&g.id, "bob@old.com", "bob@new.com").unwrap();
            rename_member(&g.id, "bob@new.com", "bob@newer.com").unwrap();
            let stored = load_groups().unwrap();
            let bobs: Vec<_> = stored
                .get(&g.id)
                .unwrap()
                .members
                .iter()
                .filter(|m| m.email.starts_with("bob@"))
                .collect();
            assert_eq!(bobs.len(), 1, "не должно появляться дублей участника");
            assert_eq!(bobs[0].email, "bob@newer.com");
        });
    }

    #[test]
    fn test_rename_member_on_missing_group_errors_instead_of_silently_ok() {
        with_tmp_groups(|| {
            let err = rename_member("no-such-group", "a@x.com", "b@y.com");
            assert!(
                err.is_err(),
                "переименование в несуществующей группе — ошибка"
            );
        });
    }

    // ─── filter_own_groups: fp-first, адрес как fallback ───

    fn mk_group(id: &str, created_by: &str, members: &[(&str, &str)]) -> Group {
        Group {
            id: id.into(),
            name: format!("группа {}", id),
            created_by: created_by.into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            members: members
                .iter()
                .map(|(e, f)| GroupMember {
                    email: e.to_string(),
                    role: GroupRole::Member,
                    joined_at: String::new(),
                    key_shared: false,
                    fingerprint: f.to_string(),
                })
                .collect(),
            blocked: vec![],
            encrypted: true,
            group_key: String::new(),
        }
    }

    #[test]
    fn test_filter_own_groups_fp_first_email_fallback() {
        let new = "me@new.com";
        let old = "me@old.com";
        let my_fp = "aabb11223344";

        let all = vec![
            // Мой адрес уже переименован при смене почты
            mk_group("g1", "someone@x.com", &[("me@new.com", "")]),
            // Адрес не переименован (старый остался в groups.json)
            mk_group("g2", "other@x.com", &[(old, "")]),
            // Опознаю только по отпечатку (адрес вообще другой)
            mk_group("g3", "third@x.com", &[("elsewhere@y.com", my_fp)]),
            // Чужая группа: другой fp, другой адрес
            mk_group(
                "g4",
                "somebody@z.com",
                &[("somebody@z.com", "deadbeef0099")],
            ),
        ];

        let got = filter_own_groups(&all, new, my_fp, &[old.to_string()]);
        assert_eq!(
            got.len(),
            3,
            "свои: g1 (новый адрес), g2 (старый адрес = алиас), g3 (по отпечатку)"
        );
        assert!(got.iter().all(|g| g.id != "g4"), "чужая группа не попала");
    }

    #[test]
    fn test_filter_own_groups_without_fp_or_aliases_uses_email_only() {
        let renamed = mk_group("g1", "s@x.com", &[("me@new.com", "")]);
        let stale = mk_group("g2", "s@x.com", &[("me@old.com", "")]);
        // Нет fp, нет алиасов — находится только группа с текущим адресом.
        let got = filter_own_groups(&[renamed, stale], "me@new.com", "", &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "g1");
    }

    #[test]
    fn test_filter_own_groups_empty_fp_never_matches() {
        // Участник с fp, но мой fp пуст — матчиться не должен.
        let tricky = mk_group("g5", "x@y.com", &[("who@y.com", "aabb")]);
        let got = filter_own_groups(std::slice::from_ref(&tricky), "me@new.com", "", &[]);
        assert!(got.is_empty(), "пустой fp не должен матчиться");
    }

    #[test]
    fn test_filter_own_groups_case_and_whitespace_insensitive() {
        let weird = mk_group("g6", "  Admin@X.COM ", &[("ME@NEW.com", "  ")]);
        let got = filter_own_groups(std::slice::from_ref(&weird), "me@new.com", "", &[]);
        assert_eq!(got.len(), 1);
    }

    // ─── backfill_my_fingerprint: ленивое заполнение своего fp ───

    #[test]
    fn test_backfill_fills_empty_fingerprints_across_all_groups() {
        with_tmp_groups(|| {
            // 2 группы, участник с пустым fp в обеих.
            let mut all = HashMap::new();
            let g1 = mk_group("g1", "a@x.com", &[("me@x.com", "")]);
            let g2 = mk_group("g2", "b@x.com", &[("me@x.com", "")]);
            all.insert(g1.id.clone(), g1);
            all.insert(g2.id.clone(), g2);
            save_groups(&all).unwrap();

            let updated = backfill_my_fingerprint("me@x.com", "  AABB112233445566  ").unwrap();
            assert_eq!(updated, 2, "обе группы с пустым fp должны обновиться");

            let groups = load_groups().unwrap();
            for id in ["g1", "g2"] {
                let m = &groups.get(id).unwrap().members[0];
                // trim + lowercase применяются.
                assert_eq!(m.fingerprint, "aabb112233445566", "fp в {id}");
            }
        });
    }

    #[test]
    fn test_backfill_does_not_overwrite_existing_fingerprint() {
        with_tmp_groups(|| {
            let mut all = HashMap::new();
            let g1 = mk_group("g1", "a@x.com", &[("me@x.com", "existing")]);
            all.insert(g1.id.clone(), g1);
            save_groups(&all).unwrap();

            let updated = backfill_my_fingerprint("me@x.com", "newfp123").unwrap();
            assert_eq!(updated, 0, "непустой fp не должен перезаписываться");

            let groups = load_groups().unwrap();
            assert_eq!(groups.get("g1").unwrap().members[0].fingerprint, "existing");
        });
    }

    #[test]
    fn test_backfill_empty_fingerprint_is_noop() {
        with_tmp_groups(|| {
            let mut all = HashMap::new();
            let g1 = mk_group("g1", "a@x.com", &[("me@x.com", "")]);
            all.insert(g1.id.clone(), g1);
            save_groups(&all).unwrap();

            let path = std::env::var("VAULT_GROUPS_FILE").unwrap();
            let before = std::fs::read_to_string(&path).unwrap();

            let updated = backfill_my_fingerprint("me@x.com", "   ").unwrap();
            assert_eq!(updated, 0, "пустой fp — no-op");

            let after = std::fs::read_to_string(&path).unwrap();
            assert_eq!(before, after, "файл не должен измениться");
        });
    }

    #[test]
    fn test_backfill_case_insensitive_email() {
        with_tmp_groups(|| {
            // Email в groups.json записан в другом регистре.
            let mut all = HashMap::new();
            let g1 = mk_group("g1", "a@x.com", &[("Me@X.COM", "")]);
            all.insert(g1.id.clone(), g1);
            save_groups(&all).unwrap();

            let updated = backfill_my_fingerprint("me@x.com", "FPAA").unwrap();
            assert_eq!(updated, 1, "регистр email не должен мешать");

            let groups = load_groups().unwrap();
            assert_eq!(groups.get("g1").unwrap().members[0].fingerprint, "fpaa");
        });
    }
}
