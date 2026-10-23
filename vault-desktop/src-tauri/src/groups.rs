use anyhow::Result;
use chrono::Utc;
use hex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use vault_client::vault::group_rules;
use vault_client::vault::identity;

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
    // Сериализуем через BTreeMap: serde_json по HashMap пишет ключи в
    // случайном порядке, и каждая перезапись groups.json переставляла группы
    // в файле. С BTreeMap порядок в файле стабилен — файл перестаёт «моргать»
    // в git/дифф и даёт предсказуемое поведение при чтении.
    let ordered: std::collections::BTreeMap<&String, &Group> = groups.iter().collect();
    let json = serde_json::to_string_pretty(&ordered)?;
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

/// M2.1: Generate a group invite token for ADR-001 sync (group invite/accept).
///
/// Invite token = `inv_<group_id>_<16-hex>`. Creator (admin) generates, sends
/// token via out-of-band (email relay / QR). Acceptor calls
/// `groups_accept_invite(token, invitee_email)` → triggers `import_group`
/// с encrypted key share (done on JS layer via ctx).
///
/// Токен не хранит ключ (key передаётся зашифрованным в конверте — parity с
/// JS inviteSelectedMembers). Токен — лишь ссылка на группу + anti-replay
/// (один токен = один invite; повторный accept идемпотентен через import_group).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InviteToken {
    pub token: String,
    pub group_id: String,
    pub group_name: String,
    pub created_by: String,
    pub created_at: String,
}

pub fn group_invite(group_id: &str, invitee_email: &str) -> Result<InviteToken> {
    let mut groups = load_groups()?;
    let group = groups.get_mut(group_id)
        .ok_or_else(|| anyhow::anyhow!("group_invite: group not found: {}", group_id))?;
    let gid = group.id.clone();
    let gname = group.name.clone();
    let creator = group.created_by.clone();
    if group
        .members
        .iter()
        .any(|m| identity::same_address(&m.email, invitee_email))
    {
        anyhow::bail!(
            "group_invite: {} already a member of {}",
            invitee_email,
            gid
        );
    }
    let mut id_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut id_bytes);
    let token = format!("inv_{}_{}", gid, hex::encode(id_bytes));
    let now = Utc::now().to_rfc3339();
    Ok(InviteToken {
        token,
        group_id: gid,
        group_name: gname,
        created_by: creator,
        created_at: now,
    })
}

/// M2.1: Accept an invite token — validates + ensures invitee registered as
/// member (idempotent). Returns the resolved group_id so JS can fetch the
/// encrypted key share separately via import_group.
pub fn accept_invite(token: &str, invitee_email: &str) -> Result<String> {
    let body = token.strip_prefix("inv_").unwrap_or(token);
    // body = "<group_id>_<16hex>"; group_id может содержать '_' → split
    // только по LAST '_' (hex — фиксированная длина, id нет).
    let parts: Vec<&str> = body.rsplitn(2, "_").collect();
    if parts.len() < 2 {
        anyhow::bail!("accept_invite: malformed token");
    }
    let group_id = parts[1].to_string();
    let mut groups = load_groups()?;
    let group = groups.get_mut(&group_id)
        .ok_or_else(|| anyhow::anyhow!("accept_invite: group not found: {}", group_id))?;
    // Ensure invitee registered (idempotent: skip if already member).
    let needs_push = !group
        .members
        .iter()
        .any(|m| identity::same_address(&m.email, invitee_email));
    if needs_push {
        let now = Utc::now().to_rfc3339();
        group.members.push(GroupMember {
            email: invitee_email.to_string(),
            role: GroupRole::Member,
            joined_at: now,
            key_shared: false,
            fingerprint: String::new(),
        });
        let gid = group.id.clone();
        save_groups(&groups)?;
        Ok(gid)
    } else {
        Ok(group.id.clone())
    }
}

pub fn add_member(group_id: &str, email: &str) -> Result<()> {
    let mut groups = load_groups()?;
    if let Some(group) = groups.get_mut(group_id) {
        // Check if member already exists. Форма адреса — ядро: точное
        // сравнение заводило ВТОРОГО участника с тем же ключом, если адрес
        // пришёл в другом регистре или с обрамлением.
        if group
            .members
            .iter()
            .any(|m| identity::same_address(&m.email, email))
        {
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
        // Смена почты собеседником. Какую запись оставить и кого пометить
        // общим ключом решает ядро (`group_rules::plan_rename`) — случай (а)
        // «старого нет, новый уже участник» и случай (б) «оба адреса в списке»
        // (живые данные 06.10.2026, группа «Четыре»). Здесь остаётся поиск
        // позиций по форме адреса (`identity::same_address`) и применение
        // плана к `GroupMember`.
        let old_idx = group
            .members
            .iter()
            .position(|m| identity::same_address(&m.email, old_email));
        let new_idx = group
            .members
            .iter()
            .position(|m| identity::same_address(&m.email, new_email));
        match group_rules::plan_rename(old_idx, new_idx) {
            // Старого адреса нет — ренеймить нечего.
            group_rules::Rename::Nothing => {}
            group_rules::Rename::MergeDuplicate { drop, keep } => {
                group.members.remove(drop);
                group.members[keep].key_shared = true;
            }
            group_rules::Rename::Move { at } => {
                group.members[at].email = new_email.to_string();
                group.members[at].key_shared = true; // ключ группы у него уже есть
            }
        }
        if identity::same_address(&group.created_by, old_email) {
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
    //
    // РЕШЕНИЕ О СЛИЯНИИ — в ядре (`group_rules::plan_invite`): какие строки
    // обновить, каких добавить, добавлять ли отправителя. Здесь только
    // применение плана к `GroupMember` и запись файла.
    let merge_members = |existing: &mut Vec<GroupMember>| {
        let no_invitation: Vec<GroupMember> = Vec::new();
        let inv: &[GroupMember] = invite_members.unwrap_or(&no_invitation);
        let known: Vec<&str> = existing.iter().map(|m| m.email.as_str()).collect();
        let invited: Vec<&str> = inv.iter().map(|m| m.email.as_str()).collect();
        let plan = group_rules::plan_invite(&known, &invited, sender);
        for (at, from) in plan.update {
            existing[at].role = inv[from].role.clone();
        }
        for from in plan.push {
            existing.push(GroupMember {
                email: inv[from].email.clone(),
                role: inv[from].role.clone(),
                joined_at: now.clone(),
                key_shared: false,
                fingerprint: String::new(),
            });
        }
        if plan.push_sender {
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
        // The group creator cannot be removed by anyone — only leave
        // voluntarily. Правило «кого защищаем» — в ядре
        // (`group_rules::may_remove_member`), форма адреса — в `identity`.
        if !group_rules::may_remove_member(email, &group.created_by) {
            anyhow::bail!("Cannot remove group creator");
        }
        let before_len = group.members.len();
        group
            .members
            .retain(|m| !identity::same_address(&m.email, email));
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
        // The group creator cannot be demoted from Admin — правило в ядре
        // (`group_rules::may_set_role`).
        if !group_rules::may_set_role(email, &group.created_by, role == GroupRole::Admin) {
            anyhow::bail!("Cannot change creator role");
        }
        let member = group
            .members
            .iter_mut()
            .find(|m| identity::same_address(&m.email, email));
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
///
/// САМО ПРАВИЛО — в ядре (`vault_client::vault::identity`): вопрос «запись моя?»
/// задают и десктоп, и CLI, и он обязан иметь один носитель, потому что
/// иначе один клиент видит группу своей, а другой — нет. Здесь остаётся
/// только форма: `Group` → пары (адрес участника, отпечаток).
pub fn filter_own_groups(
    groups: &[Group],
    my_email: &str,
    my_fingerprint: &str,
    aliases: &[String],
) -> Vec<Group> {
    let id = identity::Identity::new(my_email, aliases, my_fingerprint);
    groups
        .iter()
        .filter(|g| {
            id.owns_group(
                &g.created_by,
                g.members
                    .iter()
                    .map(|m| (m.email.as_str(), m.fingerprint.as_str())),
            )
        })
        .cloned()
        .collect()
}

/// Массовое заполнение СОБСТВЕННОГО fingerprint у участников во ВСЕХ группах.
///
/// Заполняет поле `fingerprint` участников, чей email совпадает с данным
/// (форма адреса — ядро, `identity::same_address`: обрамление срезано, регистр
/// нижний по Юникоду) и у которых поле пустое — ленивая миграция старых
/// groups.json,
/// которые никто не открывал в UI (там fp заполняется только при открытии
/// группы). Без этого fp-only фильтр `filter_own_groups` такие группы не
/// находит.
///
/// Идемпотентно (как groups_save_member_fingerprints): существующие НЕПУСТЫЕ
/// fingerprint не затираются; пустой fingerprint после trim — no-op (ничего
/// не пишем, возвращаем 0). Сохранение — только если что-то обновилось.
///
/// Возвращает число обновлённых участников.
pub fn backfill_my_fingerprint(email: &str, fingerprint: &str) -> Result<usize> {
    // Ни «пустой отпечаток», ни «пустой адрес», ни «совпали ли адреса» не
    // решаются здесь: это правила ядра (`identity::fingerprint_to_write`).
    let mut groups = load_groups()?;
    let mut updates = 0usize;
    for group in groups.values_mut() {
        for m in group.members.iter_mut() {
            if let Some(fp) =
                identity::fingerprint_to_write(&m.fingerprint, &fingerprint, &m.email, email)
            {
                m.fingerprint = fp;
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

    // ── Стабильность порядка групп (регресс: «список групп прыгает») ──
    //
    // load_groups() отдаёт HashMap, а итерация по нему в Rust рандомизирована
    // на каждый процесс. Если отдавать UI «как есть», порядок групп меняется
    // сам — пользователь теряет место в списке. Сортировка обязана быть
    // детерминированной: created_at убыв., тай-брейкер id.

    fn mk_group_at(id: &str, created_at: &str) -> Group {
        let mut g = mk_group(id, "owner@x.ru", &[("owner@x.ru", "")]);
        g.created_at = created_at.to_string();
        g
    }

    /// Сортировка для UI: свежие сверху, при равенстве created_at — по id.
    fn ui_sort(mut v: Vec<Group>) -> Vec<Group> {
        v.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        v
    }

    #[test]
    fn group_order_is_independent_of_hashmap_iteration_order() {
        // Ключевой регресс: раскладываем ОДНИ И ТЕ ЖЕ группы в HashMap
        // многократно — сырой порядок итерации плавает, отсортированный нет.
        let specs = [
            ("grp_a", "2026-01-01T10:00:00Z"),
            ("grp_b", "2026-03-01T10:00:00Z"),
            ("grp_c", "2026-02-01T10:00:00Z"),
        ];
        let mut expected: Option<Vec<String>> = None;
        for round in 0..50 {
            let map: HashMap<String, Group> = specs
                .iter()
                .map(|(id, ca)| (id.to_string(), mk_group_at(id, ca)))
                .collect();
            let raw: Vec<String> = map.values().map(|g| g.id.clone()).collect();
            let sorted: Vec<String> = ui_sort(map.into_values().collect())
                .into_iter()
                .map(|g| g.id)
                .collect();
            match &expected {
                None => expected = Some(sorted.clone()),
                Some(exp) => assert_eq!(
                    *exp, sorted,
                    "раунд {round}: отсортированный порядок обязан быть стабилен"
                ),
            }
            // Сырой порядок может совпасть, но не обязан — это и есть суть бага.
            let _ = raw;
        }
        assert_eq!(
            expected.unwrap(),
            vec!["grp_b", "grp_c", "grp_a"],
            "свежие сверху, по created_at убыв."
        );
    }

    #[test]
    fn group_order_tiebreaker_is_stable_on_equal_created_at() {
        // Одинаковый created_at: порядок обязан определяться id, а не тем,
        // в каком порядке HashMap выдал элементы.
        let specs = [("grp_z", "2026-01-01T00:00:00Z"), ("grp_a", "2026-01-01T00:00:00Z"), ("grp_m", "2026-01-01T00:00:00Z")];
        let map: HashMap<String, Group> = specs
            .iter()
            .map(|(id, ca)| (id.to_string(), mk_group_at(id, ca)))
            .collect();
        let sorted: Vec<String> = ui_sort(map.into_values().collect())
            .into_iter()
            .map(|g| g.id)
            .collect();
        assert_eq!(sorted, vec!["grp_a", "grp_m", "grp_z"], "тай-брейкер по id");
    }

    #[test]
    fn groups_json_is_written_in_stable_key_order() {
        // save_groups обязан писать ключи отсортированно: иначе каждая
        // перезапись переставляет группы в файле (файл «моргает» в диффе).
        with_tmp_groups(|| {
            let map: HashMap<String, Group> = [
                ("grp_c", "2026-01-03T00:00:00Z"),
                ("grp_a", "2026-01-01T00:00:00Z"),
                ("grp_b", "2026-01-02T00:00:00Z"),
            ]
            .iter()
            .map(|(id, ca)| (id.to_string(), mk_group_at(id, ca)))
            .collect();
            save_groups(&map).expect("save_groups");
            let path = std::env::var("VAULT_GROUPS_FILE").unwrap();
            let raw = std::fs::read_to_string(&path).unwrap();
            let order: Vec<usize> = ["grp_a", "grp_b", "grp_c"]
                .iter()
                .map(|k| raw.find(&format!("\"{k}\"")).expect("key present"))
                .collect();
            assert!(
                order[0] < order[1] && order[1] < order[2],
                "ключи в groups.json должны идти по алфавиту, получено {order:?}"
            );
        });
    }

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
        crate::set_env_safe("VAULT_GROUPS_FILE", &path);
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

    /// Все сравнения адресов участника идут через форму ядра
    /// (`identity::same_address`): до партии 4 каждый вызов сравнивал по-своему
    /// (`==`, `to_lowercase()` без обрезки, `eq_ignore_ascii_case`), и адрес из
    /// письма в другом регистре или с обрамляющим пробелом давал ВТОРОУЮ запись
    /// об том же человеке — а создателя в другом регистре можно было удалить.
    #[test]
    fn test_membership_lookup_uses_the_normalized_address_form() {
        with_tmp_groups(|| {
            let group = create_group("test group", "Alice@Example.com").unwrap();
            let id = group.id.clone();
            add_member(&id, "bob@example.com").unwrap();

            // Тот же участник в другом регистре и с пробелами — не дубль.
            add_member(&id, " BOB@Example.COM ").unwrap();
            let groups = load_groups().unwrap();
            assert_eq!(
                groups.get(&id).unwrap().members.len(),
                2,
                "второй записи о bob быть не должно"
            );

            // Роли ищет по той же форме.
            set_member_role(&id, "BOB@example.com", GroupRole::Moderator).unwrap();
            let groups = load_groups().unwrap();
            assert_eq!(
                groups.get(&id).unwrap().members[1].role,
                GroupRole::Moderator
            );

            // Создатель защищён, даже если его адрес написан иначе.
            assert!(remove_member(&id, "alice@EXAMPLE.com").is_err());
            assert!(set_member_role(&id, " ALICE@example.com ", GroupRole::Member).is_err());

            // Удаление по варианту написания убирает запись, а не оставляет «сироту».
            remove_member(&id, "Bob@Example.com").unwrap();
            let groups = load_groups().unwrap();
            assert_eq!(groups.get(&id).unwrap().members.len(), 1);
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

    /// Второе направление слияния: новый адрес стоит в списке ДО старого.
    /// Тогда сдвигать индекс некуда, и ошибка в сторону условия (`i > j` вместо
    /// `i < j`) пометила бы общим ключом соседа.
    #[test]
    fn test_rename_member_merge_marks_the_right_record_when_new_email_comes_first() {
        with_tmp_groups(|| {
            let group = create_group("g", "alice@example.com").unwrap();
            add_member(&group.id, "bob@new.ru").unwrap();
            add_member(&group.id, "carol@ya.ru").unwrap();
            add_member(&group.id, "bob@ya.ru").unwrap();
            rename_member(&group.id, "bob@ya.ru", "bob@new.ru").unwrap();

            let g = load_groups().unwrap().get(&group.id).unwrap().clone();
            assert_eq!(g.members.len(), 3, "старая запись удалена, новых нет");
            let by = |e: &str| g.members.iter().find(|m| m.email == e).unwrap();
            assert!(by("bob@new.ru").key_shared, "общий ключ у переехавшего");
            assert!(
                !by("carol@ya.ru").key_shared,
                "сосед не получил чужую отметку"
            );
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

    #[test]
    fn test_group_invite_generates_token() {
        with_tmp_groups(|| {
            let g = create_group("dev", "creator@x").unwrap();
            let inv = group_invite(&g.id, "invitee@x").unwrap();
            assert!(inv.token.starts_with("inv_"));
            assert_eq!(inv.group_id, g.id);
            assert_eq!(inv.created_by, "creator@x");
            let mut groups = load_groups().unwrap();
            groups.get_mut(&g.id).unwrap().members.push(GroupMember {
                email: "alice@x".to_string(), role: GroupRole::Member,
                joined_at: String::new(), key_shared: false, fingerprint: String::new(),
            });
            save_groups(&groups).unwrap();
            assert!(group_invite(&g.id, "alice@x").is_err());
        });
    }

    #[test]
    fn test_accept_invite_idempotent() {
        with_tmp_groups(|| {
            let g = create_group("team", "creator@x").unwrap();
            let inv = group_invite(&g.id, "bob@x").unwrap();
            let gid = accept_invite(&inv.token, "bob@x").unwrap();
            assert_eq!(gid, g.id);
            let gid2 = accept_invite(&inv.token, "bob@x").unwrap();
            assert_eq!(gid2, g.id);
            let groups = load_groups().unwrap();
            let gm = groups.get(&g.id).unwrap();
            assert!(gm.members.iter().any(|m| m.email == "bob@x"));
        });
    }

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
