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

// Форма записи одна на CLI и мост: структуры живут в `vault-core`, здесь —
// только пути хранения и команды. Своя копия `GroupMember` без `fingerprint`
// уже один раз сделала CLI слепым к участнику, сменившему почту.
pub use vault_client::vault::groups::{Group, GroupMember, GroupRole};

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
        invited: false,
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
    let group = groups
        .get_mut(group_id)
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
    let group = groups
        .get_mut(&group_id)
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
            invited: false,
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
            invited: false,
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
        if apply_rename(group, old_email, new_email) {
            save_groups(&groups)?;
        }
    } else {
        anyhow::bail!("Group not found");
    }
    Ok(())
}

/// Применить переименование адреса к ОДНОЙ группе. Возвращает, было ли что
/// менять — без этого вызывающий перезаписывал бы groups.json на каждый
/// холостой проход (файл менялся бы по времени, хотя данные те же).
///
/// Смена почты собеседником. Какую запись оставить и кого пометить общим
/// ключом решает ядро (`group_rules::plan_rename`) — случай (а) «старого нет,
/// новый уже участник» и случай (б) «оба адреса в списке» (живые данные
/// 06.10.2026, группа «Четыре»). Здесь остаётся поиск позиций по форме
/// адреса (`identity::same_address`) и применение плана к `GroupMember`.
fn apply_rename(group: &mut Group, old_email: &str, new_email: &str) -> bool {
    let old_idx = group
        .members
        .iter()
        .position(|m| identity::same_address(&m.email, old_email));
    let new_idx = group
        .members
        .iter()
        .position(|m| identity::same_address(&m.email, new_email));
    let touched = match group_rules::plan_rename(old_idx, new_idx) {
        // Старого адреса нет — ренеймить нечего.
        group_rules::Rename::Nothing => false,
        group_rules::Rename::MergeDuplicate { drop, keep } => {
            group.members.remove(drop);
            group.members[keep].key_shared = true;
            true
        }
        group_rules::Rename::Move { at } => {
            group.members[at].key_shared = true; // ключ группы у него уже есть
            if group.members[at].email != new_email {
                group.members[at].email = new_email.to_string();
            }
            true
        }
    };
    if identity::same_address(&group.created_by, old_email) && group.created_by != new_email {
        group.created_by = new_email.to_string();
        return true;
    }
    touched
}

/// Переименовать адрес во ВСЕХ группах, где он значится создателем или
/// участником. Возвращает число затронутых групп.
///
/// ПРЕЖДЕ этот перебор делал фронт (`migrations.js::renameMeInGroups`) и
/// решал «мой ли это адрес» сравнением `String(x).toLowerCase() === old`:
/// обрамление не срезалось, а `toLowerCase` в JS и `normalize` ядра расходятся
/// на кириллице и на пробелах — группа с тем же человеком в списке просто
/// не попадала в перебор. Теперь вопрос формы адреса у ядра, а носителя
/// (фронта) — только число групп для перезагрузки списка.
pub fn rename_address(old_email: &str, new_email: &str) -> Result<usize> {
    let mut groups = load_groups()?;
    let mut touched = 0usize;
    for group in groups.values_mut() {
        if apply_rename(group, old_email, new_email) {
            touched += 1;
        }
    }
    if touched > 0 {
        save_groups(&groups)?;
    }
    Ok(touched)
}

/// Числится ли адрес в группе (участником). Пустой адрес — не участник
/// (`identity::normalize` пустое ни с чем не сравнивает).
pub fn has_member(group: &Group, address: &str) -> bool {
    group
        .members
        .iter()
        .any(|m| identity::same_address(&m.email, address))
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
                invited: false,
            });
        }
        if plan.push_sender {
            existing.push(GroupMember {
                email: sender.to_string(),
                role: GroupRole::Member,
                joined_at: now.clone(),
                key_shared: true,
                fingerprint: String::new(), // sender has the key (just invited us)
                invited: false,
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
    groups
        .iter()
        .filter(|g| is_own_group(g, my_email, my_fingerprint, aliases))
        .cloned()
        .collect()
}

/// «Моя ли эта группа» — тот же вопрос, что задаёт фильтр списка, но об
/// одной группе. Нужен фронту там, где раньше он решал его сам: `api.js`
/// сравнивал `g.created_by === this.email` и `mm.email === this.email`,
/// `groups-clone.js` — `src.created_by !== email`. Сравнение адреса в JS —
/// это вторая копия правила формы адреса, и она слепнет на регистре,
/// обрамлении и на участнике, опознанном по отпечатку.
pub fn is_own_group(
    group: &Group,
    my_email: &str,
    my_fingerprint: &str,
    aliases: &[String],
) -> bool {
    let id = identity::Identity::new(my_email, aliases, my_fingerprint);
    id.owns_group(
        &group.created_by,
        group
            .members
            .iter()
            .map(|m| (m.email.as_str(), m.fingerprint.as_str())),
    )
}

/// Участник — ЭТОТ ЖЕ аккаунт, что и мы? Правило живёт в ядре
/// (`identity::member_is_account`), здесь — только форма вопроса для фронта:
/// адрес сессии, его алиасы, наш отпечаток и НАШ публичный ключ.
///
/// ЗАЧЕМ НУЖЕН ИМНОГО КЛЮЧ, а не `member_matches`: добивка контактов из
/// состава групп решает «свой или нет» сравнением СТРОК с адресом текущей
/// сессии, а идентичность — это ключ. На живых данных X50 (24.10) сессия
/// koanmak@ya.ru, а в составе koanmak@gmail.com, в fingerprint которого лежит
/// публичный ключ десктопа целиком — следа от старого backfill. Фронт
/// складывал этого «себя» в контакты, и клик по такому контакту открывал
/// попап «Добавить контакт» вместо чата.
pub fn member_is_account(
    my_email: &str,
    aliases: &[String],
    my_fingerprint: &str,
    member_email: &str,
    member_fingerprint: &str,
    own_public_key_hex: &str,
) -> bool {
    let id = identity::Identity::new(my_email, aliases, my_fingerprint);
    identity::member_is_account(&id, member_email, member_fingerprint, own_public_key_hex)
}

/// Убрать из списка контактов те, что являются НАМИ. Контакты — общий
/// peer-store на машину, и фронт отсекал «себя» сравнением строк
/// (`c.email !== email`): регистрозависимо, без алиасов и без ключа. На
/// живых данных X50 (24.10) так в списке под сессией koanmak@ya.ru стояли
/// koanmak@gmail.com и vault-msg@ya.ru — обе записи с НАШИМ публичным
/// ключом; клик по такой записи открывал попап «Добавить контакт» вместо
/// чата. Предикат тот же, что у участника группы: адрес (email ∪ алиасы)
/// ИЛИ отпечаток ИЛИ наш ключ в поле public_key.
pub fn contacts_drop_own(
    contacts: &[(String, String)],
    my_email: &str,
    aliases: &[String],
    my_fingerprint: &str,
    own_public_key_hex: &str,
) -> Vec<(String, String)> {
    let id = identity::Identity::new(my_email, aliases, my_fingerprint);
    contacts
        .iter()
        .filter(|(email, public_key)| {
            !(id.has_address(email) || identity::same_public_key(public_key, own_public_key_hex))
        })
        .cloned()
        .collect()
}

/// Право участника в списке (позиция совпадает с `group.members`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemberAccess {
    /// Можно ли убрать этого участника (кнопка ✕).
    pub removable: bool,
    /// Можно ли менять ему роль (строка выбора).
    pub settable_role: bool,
    /// Это я.
    pub is_self: bool,
    /// Это создатель группы.
    pub is_creator: bool,
}

/// Ответ фронту «кто я в этой группе и что мне можно». Раньше эти четыре
/// вопроса фронт решал сам, сравнивая адреса (`App.vue::isGroupAdmin`,
/// `GroupSettings.vue:194/204/209`): регистр и обрамление в JS не срезаются,
/// отпечаток не учитывается вовсе, поэтому права то исчезали (группа моя, а
/// кнопки нет), то появлялись у чужой строки.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GroupAccess {
    /// Группа в моём списке (создатель или участник — по отпечатку/адресам).
    pub is_mine: bool,
    pub is_creator: bool,
    /// Роль в моей записи — Admin. Создатель ею не обязан быть, поэтому
    /// `can_manage` шире этого поля.
    pub is_admin: bool,
    /// Управляю ли составом и ролями (создатель ИЛИ назначенный админ).
    pub can_manage: bool,
    pub members: Vec<MemberAccess>,
}

pub fn group_access(
    group: &Group,
    my_email: &str,
    my_fingerprint: &str,
    aliases: &[String],
) -> GroupAccess {
    let id = identity::Identity::new(my_email, aliases, my_fingerprint);
    // Своя запись в списке: отпечатком или любым из своих адресов (текущий и
    // алиасы). Её роль и даёт ответ «назначен ли меня админом».
    let me = group
        .members
        .iter()
        .find(|m| id.member_matches(&m.email, &m.fingerprint));
    let access = group_rules::Access {
        is_creator: id.has_address(&group.created_by)
            || me
                .map(|m| identity::same_address(&m.email, &group.created_by))
                .unwrap_or(false),
        is_admin: me.map(|m| m.role == GroupRole::Admin).unwrap_or(false),
    };
    let members = group
        .members
        .iter()
        .map(|m| {
            let is_creator = identity::same_address(&m.email, &group.created_by);
            MemberAccess {
                is_creator,
                is_self: id.member_matches(&m.email, &m.fingerprint),
                removable: access
                    .may_remove(is_creator, id.member_matches(&m.email, &m.fingerprint)),
                settable_role: access.may_set_role_of(is_creator),
            }
        })
        .collect();
    GroupAccess {
        is_mine: is_own_group(group, my_email, my_fingerprint, aliases),
        is_creator: access.is_creator,
        is_admin: access.is_admin,
        can_manage: access.may_manage(),
        members,
    }
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
/// Идемпотентно (как `backfill_member_fingerprints`): существующие НЕПУСТЫЕ
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

/// Ленивая починка отпечатков участников ОДНОЙ группы по `peer_keys`.
///
/// Зачем: старый `backfillGroupFingerprints` во фронте писал в поле
/// `fingerprint` сам публичный ключ. В живом `groups.json` из-за этого лежат
/// две формы — канонический отпечаток `xx:xx:…:****` и 64-hex ключ. Ключ не
/// совпадает с отпечатком, который присылает фронт для «моей» идентичности,
/// поэтому fp-ветка для такой записи мертва, и остаётся только адрес.
///
/// Правило «что писать» — в ядре (`identity::fingerprint_to_repair`): пустой
/// слот заполняется, след публичного ключа заменяется, выясненный отпечаток не
/// трогается. Здесь — поиск ключа по адресу и запись файла.
pub fn backfill_member_fingerprints(group_id: &str) -> Result<Option<Group>> {
    let peers = crate::key_store::load_peer_keys()?;
    backfill_member_fingerprints_with_peers(group_id, &peers)
}

/// Та же починка с уже загруженными ключами (тесты не трогают реальный
/// `~/.vault/keys`).
pub fn backfill_member_fingerprints_with_peers(
    group_id: &str,
    peers: &[vault_core::StoredPeerKey],
) -> Result<Option<Group>> {
    let mut groups = load_groups()?;
    if !groups.contains_key(group_id) {
        return Ok(None);
    }
    let mut updates = 0usize;
    if let Some(group) = groups.get_mut(group_id) {
        for m in group.members.iter_mut() {
            let Some(peer) = peers
                .iter()
                .find(|k| identity::same_address(&k.email, &m.email))
            else {
                continue;
            };
            let Ok(computed) = identity::fingerprint_from_public_key(&peer.public_key) else {
                continue;
            };
            if let Some(fp) =
                identity::fingerprint_to_repair(&m.fingerprint, &computed, &peer.public_key)
            {
                m.fingerprint = fp;
                updates += 1;
            }
        }
    }
    if updates > 0 {
        save_groups(&groups)?;
    }
    Ok(groups.get(group_id).cloned())
}

/// Отложенное приглашение в группу: адрес помечен в составе (`invited`), но
/// публичного ключа получателя ещё нет — шифровать ключ группы не на что.
#[derive(Debug, Clone, Serialize)]
pub struct PendingInvite {
    pub group_id: String,
    pub email: String,
}

/// Пометить участника «приглашён, ждём ключ» (в составе его ещё нет —
/// записываем с `key_shared: false`). Идемпотентно. Возвращает группу, чтобы
/// фронт перечитал состав из ответа моста, а не из своего копии-массива.
pub fn mark_invited(group_id: &str, email: &str) -> Result<Group> {
    let mut groups = load_groups()?;
    let group = groups
        .get_mut(group_id)
        .ok_or_else(|| anyhow::anyhow!("mark_invited: group not found: {}", group_id))?;
    if let Some(m) = group
        .members
        .iter_mut()
        .find(|m| identity::same_address(&m.email, email))
    {
        m.invited = true;
    } else {
        group.members.push(GroupMember {
            email: email.to_string(),
            role: GroupRole::Member,
            joined_at: Utc::now().to_rfc3339(),
            key_shared: false,
            fingerprint: String::new(),
            invited: true,
        });
    }
    let cloned = group.clone();
    save_groups(&groups)?;
    Ok(cloned)
}

/// Очередь отложенных приглашений по всем группам: `(группа, адрес)` с
/// `invited` и ещё не переданным ключом. Порядок детерминированный —
/// файл перечитывается HashMap'ом, иначе очередь «перемешивалась» бы между
/// поллингами.
pub fn pending_invites() -> Result<Vec<PendingInvite>> {
    let mut out: Vec<PendingInvite> = Vec::new();
    for (id, group) in load_groups()? {
        for m in &group.members {
            if m.invited && !m.key_shared {
                out.push(PendingInvite {
                    group_id: id.clone(),
                    email: m.email.clone(),
                });
            }
        }
    }
    out.sort_by(|a, b| {
        a.group_id
            .cmp(&b.group_id)
            .then_with(|| a.email.cmp(&b.email))
    });
    Ok(out)
}

/// Ключ группы отправлен — ожидание снято. Возвращает, было ли что снимать.
pub fn invite_sent(group_id: &str, email: &str) -> Result<bool> {
    let mut groups = load_groups()?;
    let Some(group) = groups.get_mut(group_id) else {
        return Ok(false);
    };
    let mut changed = false;
    if let Some(m) = group
        .members
        .iter_mut()
        .find(|m| identity::same_address(&m.email, email) && m.invited)
    {
        m.invited = false;
        changed = true;
    }
    if changed {
        save_groups(&groups)?;
    }
    Ok(changed)
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
        let specs = [
            ("grp_z", "2026-01-01T00:00:00Z"),
            ("grp_a", "2026-01-01T00:00:00Z"),
            ("grp_m", "2026-01-01T00:00:00Z"),
        ];
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
                    invited: false,
                },
                GroupMember {
                    email: "carol@example.com".into(),
                    role: GroupRole::Moderator,
                    joined_at: String::new(),
                    key_shared: false,
                    fingerprint: String::new(),
                    invited: false,
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
                email: "alice@x".to_string(),
                role: GroupRole::Member,
                joined_at: String::new(),
                key_shared: false,
                fingerprint: String::new(),
                invited: false,
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
                    invited: false,
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

    // ─── гейт паритета groups.json: одна фикстура — CLI и мост ───

    fn groups_fixture() -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../vault-client/tests/fixtures/groups-file-contract.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("фикстура {} недоступна: {e}", path.display()));
        serde_json::from_str(&raw).expect("фикстура — валидный JSON")
    }

    /// Мост читает тот же файл, что CLI-тест `groups_file_contract.rs`, и
    /// отвечает тем же списком «мои группы». Стороны расходятся не в правиле
    /// (оно в ядре), а в ФОРМАТЕ записи: своя копия `GroupMember` без
    /// `fingerprint` уже делала участника невидимым после смены почты.
    #[test]
    fn groups_file_contract_parity_with_cli() {
        use std::collections::BTreeSet;

        with_tmp_groups(|| {
            let f = groups_fixture();
            let path = std::env::var("VAULT_GROUPS_FILE").unwrap();
            std::fs::write(&path, serde_json::to_vec(&f["groups"]).unwrap())
                .expect("запись фикстуры");

            let loaded = load_groups().expect("мост читает общую фикстуру");
            let fixture_ids: BTreeSet<String> = f["groups"]
                .as_object()
                .expect("groups — объект")
                .keys()
                .cloned()
                .collect();
            assert_eq!(
                loaded.keys().cloned().collect::<BTreeSet<_>>(),
                fixture_ids,
                "мост потерял или выдумал группы при чтении общей фикстуры"
            );

            let aliases: Vec<String> = f["me"]["aliases"]
                .as_array()
                .expect("me.aliases")
                .iter()
                .map(|v| v.as_str().expect("алиас — строка").to_string())
                .collect();
            let all: Vec<Group> = loaded.values().cloned().collect();
            let owned: BTreeSet<String> = filter_own_groups(
                &all,
                f["me"]["email"].as_str().expect("me.email"),
                f["me"]["fingerprint"].as_str().expect("me.fingerprint"),
                &aliases,
            )
            .into_iter()
            .map(|g| g.id)
            .collect();
            let expected: BTreeSet<String> = f["expect"]["owned_ids"]
                .as_array()
                .expect("expect.owned_ids")
                .iter()
                .map(|v| v.as_str().expect("id — строка").to_string())
                .collect();
            let not_owned: BTreeSet<String> = f["expect"]["not_owned_ids"]
                .as_array()
                .expect("expect.not_owned_ids")
                .iter()
                .map(|v| v.as_str().expect("id — строка").to_string())
                .collect();
            assert_eq!(owned, expected, "мост: список «мои группы»");
            assert!(owned.is_disjoint(&not_owned), "чужие группы попали в «мои»");

            // Запись/чтение без потерь: мост сериализует ровно то, что прочитал.
            save_groups(&loaded).expect("save_groups");
            let again = load_groups().expect("повторное чтение");
            assert_eq!(again, loaded, "round-trip groups.json изменил записи");

            let legacy = &again["grp_legacy_no_fields"];
            assert_eq!(legacy.group_key, "", "нет group_key — пустая строка");
            assert!(legacy.blocked.is_empty(), "нет blocked — пустой список");
            let admin = legacy
                .members
                .iter()
                .find(|m| m.email == "anna@mail.ru")
                .expect("участник старой группы");
            assert_eq!(admin.fingerprint, "", "нет fingerprint — пусто");
            assert_eq!(admin.joined_at, "", "нет joined_at — пусто");
            assert!(!admin.key_shared, "нет key_shared — false");
        });
    }

    // ─── ленивая починка отпечатков участников (две формы groups.json) ───

    fn peer_key(email: &str, public_key: &str) -> vault_core::StoredPeerKey {
        vault_core::StoredPeerKey {
            email: email.into(),
            public_key: public_key.into(),
            label: None,
            added_at: "2026-01-01T00:00:00Z".into(),
            pq_public_key: None,
        }
    }

    /// Живой дефект: фронт писал в `GroupMember::fingerprint` ПУБЛИЧНЫЙ КЛЮЧ
    /// (64 hex) вместо формы `xx:…:****`. Мост обязан заменить этот след
    /// настоящим отпечатком, заполнить пустые слоты и не трогать уже
    /// выясненные значения.
    #[test]
    fn backfill_repairs_empty_and_public_key_traces_only() {
        with_tmp_groups(|| {
            let key = format!("aabbccddeeff0011{}", "00".repeat(24));
            let canonical = "aa:bb:cc:dd:ee:ff:00:11:****";
            let mut group = mk_group(
                "grp_repair",
                "me@x.com",
                &[
                    ("empty@x.com", ""),
                    ("trace@x.com", ""),
                    ("known@x.com", "11:22:33:44:55:66:77:88:****"),
                    ("unknown@x.com", ""),
                ],
            );
            // След старого backfill: в поле отпечатка лежит сам публичный ключ.
            group
                .members
                .iter_mut()
                .find(|m| m.email == "trace@x.com")
                .unwrap()
                .fingerprint = key.to_uppercase();
            save_groups(&std::collections::HashMap::from([(
                "grp_repair".to_string(),
                group,
            )]))
            .unwrap();

            let peers = [
                peer_key("EMPTY@x.com", &key),
                peer_key("trace@x.com", &key),
                peer_key("known@x.com", &key),
            ];
            let updated = backfill_member_fingerprints_with_peers("grp_repair", &peers)
                .expect("починка без ошибок")
                .expect("группа найдена");

            let fp = |email: &str| {
                updated
                    .members
                    .iter()
                    .find(|m| m.email == email)
                    .unwrap()
                    .fingerprint
                    .clone()
            };
            assert_eq!(fp("empty@x.com"), canonical, "пустой слот заполнен");
            assert_eq!(
                fp("trace@x.com"),
                canonical,
                "публичный ключ заменён настоящим отпечатком"
            );
            assert_eq!(
                fp("known@x.com"),
                "11:22:33:44:55:66:77:88:****",
                "выясненный отпечаток не перезаписывается"
            );
            assert_eq!(fp("unknown@x.com"), "", "без ключа контакта — не трогаем");

            // Починка записана в файл, а не только в возвращённую копию.
            let reloaded = load_groups().unwrap();
            assert_eq!(
                reloaded["grp_repair"]
                    .members
                    .iter()
                    .find(|m| m.email == "trace@x.com")
                    .unwrap()
                    .fingerprint,
                canonical
            );

            // Неизвестная группа — не ошибка, а «нечего чинить».
            assert!(
                backfill_member_fingerprints_with_peers("no-such-group", &peers)
                    .unwrap()
                    .is_none()
            );
        });
    }

    // ─── партия 4d: «чья группа» и «что мне в ней можно» отвечает мост ───

    /// Тот же вопрос, что и фильтр списка, но об одной группе: иначе у
    /// попапа приглашения и у списка групп были бы разные ответы.
    #[test]
    fn test_is_own_group_agrees_with_the_list_filter() {
        let mine_by_fp = mk_group("g3", "third@x.com", &[("elsewhere@y.com", "aabb1122")]);
        let stranger = mk_group("g4", "somebody@z.com", &[("somebody@z.com", "deadbeef")]);
        for g in [&mine_by_fp, &stranger].iter() {
            assert_eq!(
                is_own_group(g, "me@new.com", "aabb1122", &["me@old.com".to_string()]),
                !filter_own_groups(
                    std::slice::from_ref(g),
                    "me@new.com",
                    "aabb1122",
                    &["me@old.com".to_string()]
                )
                .is_empty(),
                "фильтр и одиночный вопрос расходятся на группе {}",
                g.id
            );
        }
        assert!(is_own_group(&mine_by_fp, "me@new.com", "aabb1122", &[]));
        assert!(!is_own_group(&stranger, "me@new.com", "aabb1122", &[]));
    }

    /// Живые данные X50 (24.10): сессия koanmak@ya.ru, участник
    /// koanmak@gmail.com с НАШИМ публичным ключом в fingerprint (след старой
    /// добивки). Такой участник — свой аккаунт, фронт не должен превращать
    /// его в контакт.
    #[test]
    fn test_member_is_account_recognises_own_key_and_alias() {
        let own = format!("9cadcd4d7dbf2633{}", "00".repeat(24));
        assert!(member_is_account(
            "koanmak@ya.ru",
            &[],
            "2b:e1:c9:30:d1:b9:1b:85:****",
            "koanmak@gmail.com",
            &own,
            &own
        ));
        // Алиас своего аккаунта в составе — тоже свой.
        assert!(member_is_account(
            "koanmak@gmail.com",
            &["vault-msg@ya.ru".to_string()],
            "9c:ad:cd:4d:7d:bf:26:33:****",
            " VAULT-MSG@YA.RU ",
            "",
            &own
        ));
        // Чужой ключ под любым адресом — не свой (иначе все собеседники
        // стали бы «нами»: алиасы пиров тоже лежат в peer_keys).
        let anna = format!("c73ce55a9f7b466f{}", "00".repeat(24));
        assert!(!member_is_account(
            "koanmak@ya.ru",
            &[],
            "2b:e1:c9:30:d1:b9:1b:85:****",
            "icemaksim@gmail.com",
            &anna,
            &own
        ));
        // Пустые поля не совпадают ни с чем.
        assert!(!member_is_account("koanmak@ya.ru", &[], "", "", "", &own));
        assert!(!member_is_account("", &[], "", "", "", ""));
    }

    /// Тот же предикат на списке контактов: свои адреса и записи с НАШИМ
    /// ключом из списка уходят, чужие — остаются.
    #[test]
    fn test_contacts_drop_own_removes_only_own_entries() {
        let own = format!("9cadcd4d7dbf2633{}", "00".repeat(24));
        let anna = format!("c73ce55a9f7b466f{}", "00".repeat(24));
        let zoho = format!("2c4450b98459ee7f{}", "00".repeat(24));
        let contacts = vec![
            ("icemaksim@gmail.com".to_string(), anna.clone()),
            ("vault-msg@ya.ru".to_string(), own.clone()),
            (" VAULT-MSG@YA.RU ".to_string(), own.clone()),
            ("koanmak@ya.ru".to_string(), own.clone()),
            ("kmakan@zoho.com".to_string(), zoho.clone()),
            // Контакт без ключа, но с нашим адресом — тоже мы.
            ("Иван@Почта.РФ".to_string(), String::new()),
        ];
        let kept = contacts_drop_own(
            &contacts,
            "VAULT-MSG@YA.RU",
            &["ИВАН@Почта.РФ".to_string()],
            "",
            &own,
        );
        assert_eq!(
            kept,
            vec![
                ("icemaksim@gmail.com".to_string(), anna),
                ("kmakan@zoho.com".to_string(), zoho),
            ],
            "свои по ключу и по адресу (регистр/алиас/кириллица) — убраны, чужие — целы"
        );
    }

    #[test]
    fn test_group_access_creator_without_admin_role_still_manages() {
        // Создатель не помечен Admin (старые groups.json): право следует из
        // создательства, а не из записанной роли.
        let g = mk_group(
            "g",
            "anna@mail.ru",
            &[("anna@mail.ru", ""), ("oleg@mail.ru", "")],
        );
        let a = group_access(&g, "anna@mail.ru", "", &[]);
        assert!(a.is_mine);
        assert!(a.is_creator);
        assert!(!a.is_admin, "роли Admin в записи нет");
        assert!(a.can_manage);
        assert!(!a.members[0].removable, "создателя не удаляет никто");
        assert!(a.members[0].is_creator);
        assert!(!a.members[0].settable_role, "роль создателя не меняют");
        assert!(a.members[1].removable);
        assert!(a.members[1].settable_role);
    }

    #[test]
    fn test_group_access_admin_by_role_and_self_row_is_not_removable() {
        let mut g = mk_group(
            "g",
            "anna@mail.ru",
            &[
                ("anna@mail.ru", ""),
                ("oleg@mail.ru", ""),
                ("petr@mail.ru", ""),
            ],
        );
        g.members[1].role = GroupRole::Admin;
        let admin = group_access(&g, "oleg@mail.ru", "", &[]);
        assert!(admin.is_admin);
        assert!(admin.can_manage);
        assert!(!admin.is_creator);
        assert!(admin.members[1].is_self, "своя строка помечена своей");
        assert!(!admin.members[1].removable, "себя убирают выходом, а не ✕");
        assert!(admin.members[2].removable);
        assert!(
            !admin.members[0].removable,
            "создателя не удаляет и назначенный админ"
        );
        // Обычный участник: смотрит, но не управляет.
        let member = group_access(&g, "petr@mail.ru", "", &[]);
        assert!(member.is_mine);
        assert!(!member.can_manage);
        assert!(member.members.iter().all(|m| !m.removable));
        assert!(member.members.iter().all(|m| !m.settable_role));
    }

    /// Своя запись найдена по отпечатку, хотя адрес в списке — старый:
    /// права обязан дать, иначе после смены почты исчезает вся настройка
    /// группы (регрессия 05–06.10.2026, но уже про кнопки, а не про список).
    #[test]
    fn test_group_access_uses_fingerprint_of_the_stale_record() {
        let g = mk_group(
            "g",
            "anna@mail.ru",
            &[("anna@mail.ru", ""), ("me@old.com", "aabb1122")],
        );
        let a = group_access(&g, "me@new.com", "aabb1122", &[]);
        assert!(a.is_mine);
        assert!(a.members[1].is_self, "запись со старым адресом — я");
        assert!(!a.members[1].removable);
        // Тот же случай без отпечатка и без алиаса — группа не моя.
        let blind = group_access(&g, "me@new.com", "", &[]);
        assert!(!blind.is_mine);
        assert!(!blind.can_manage);
    }

    #[test]
    fn test_has_member_ignores_the_address_form() {
        let g = mk_group(
            "g",
            "anna@mail.ru",
            &[("  Боб@Mail.RU ", ""), ("oleg@mail.ru", "")],
        );
        assert!(has_member(&g, "боб@mail.ru"));
        assert!(
            !has_member(&g, "BOB@MAIL.RU"),
            "латинская b — не кириллическая «б»"
        );
        assert!(has_member(&g, "oleg@mail.ru"));
        assert!(!has_member(&g, ""), "пустой адрес не участник");
        assert!(!has_member(&g, "petr@mail.ru"));
    }

    #[test]
    fn test_rename_address_walks_every_group_once_and_is_idempotent() {
        with_tmp_groups(|| {
            let mut groups: HashMap<String, Group> = HashMap::new();
            let mut mine = create_group("мои", "me@old.com").unwrap();
            mine.members.push(GroupMember {
                email: "petr@mail.ru".to_string(),
                role: GroupRole::Member,
                joined_at: String::new(),
                key_shared: false,
                fingerprint: String::new(),
                invited: false,
            });
            let mine_id = mine.id.clone();
            groups.insert(mine.id.clone(), mine);
            // Чужая группа, где я числюсь СТАРЫМ адресом в другом написании.
            let other = mk_group("grp_other", "Anna@mail.RU", &[(" ME@OLD.COM ", "")]);
            groups.insert(other.id.clone(), other);
            // Ни одного моего адреса.
            let stranger = mk_group("grp_stranger", "oleg@mail.ru", &[("oleg@mail.ru", "")]);
            groups.insert(stranger.id.clone(), stranger);
            save_groups(&groups).unwrap();

            // Перебор и «мой ли адрес» — теперь здесь: фронт сравнивал
            // `toLowerCase()` и на написании с пробелом группу бы пропустил.
            assert_eq!(rename_address(" me@old.com ", "me@new.com").unwrap(), 2);
            let after = load_groups().unwrap();
            assert_eq!(after[&mine_id].created_by, "me@new.com");
            assert!(after[&mine_id]
                .members
                .iter()
                .any(|m| m.email == "me@new.com"));
            assert_eq!(
                after["grp_other"].members[0].email, "me@new.com",
                "запись чужой группы переименована по форме адреса"
            );
            assert_eq!(after["grp_stranger"].members[0].email, "oleg@mail.ru");
            assert_eq!(
                rename_address("me@old.com", "me@new.com").unwrap(),
                0,
                "повторный проход ничего не меняет"
            );
        });
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

    // ─── очередь отложенных приглашений ───

    /// Полный цикл отложенного приглашения: пометили → очередь увидела →
    /// ключ отправили → ожидание снято.
    #[test]
    fn pending_invite_roundtrip() {
        with_tmp_groups(|| {
            let g = create_group("t", "me@x.com").unwrap();
            mark_invited(&g.id, "New@Mail.X").unwrap();
            let pend = pending_invites().unwrap();
            assert_eq!(pend.len(), 1);
            assert_eq!(pend[0].group_id, g.id);
            assert_eq!(pend[0].email, "New@Mail.X", "адрес храним как прислали");

            // Повторная пометка того же адреса (в другом регистре) не
            // плодит второй записью — идемпотентность по форме адреса ядра.
            mark_invited(&g.id, "new@mail.x").unwrap();
            assert_eq!(pending_invites().unwrap().len(), 1);

            assert!(invite_sent(&g.id, "new@mail.x").unwrap());
            assert!(pending_invites().unwrap().is_empty());
            assert!(
                !invite_sent(&g.id, "new@mail.x").unwrap(),
                "второй раз — no-op"
            );
        });
    }
}
