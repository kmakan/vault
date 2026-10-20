// Набор мутаций: группы — роли, состав, блокировки (Rust-ядро).
//
// Правила: участник не добавляется дважды; роль повышается Member → Admin,
// Admin остаётся Admin, legacy Moderator становится Member; блокировка
// списывается один раз и снимается по адресу.
export default {
  id: 'groups',
  file: 'vault-client/src/vault/groups.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'участник добавляется дважды (дубль в составе группы)',
      pattern: '            if group.members.iter().any(|m| m.email == email) {\n                return Err("Member already in group".into());\n            }',
      replacement: '            if false {\n                return Err("Member already in group".into());\n            }' },
    { name: 'роль не повышается (Member остаётся Member)',
      pattern: '                        GroupRole::Member => GroupRole::Admin,',
      replacement: '                        GroupRole::Member => GroupRole::Member,' },
    { name: 'модератор становится админом (повышение прав чужого участника)',
      pattern: '                        GroupRole::Moderator => GroupRole::Member,',
      replacement: '                        GroupRole::Moderator => GroupRole::Admin,' },
    { name: 'блокировка добавляется дважды',
      pattern: '            if group.blocked.iter().any(|e| e == email) {\n                return Err("User already blocked".into());\n            }',
      replacement: '            if false {\n                return Err("User already blocked".into());\n            }' },
    { name: 'снятие блокировки не работает (заблокированный остаётся в списке)',
      pattern: '            group.blocked.retain(|e| e != email);',
      replacement: '            group.blocked.retain(|_| true);' },
    // Цель — ИМЕННО add_member: строка `key_shared: false` встречается ещё в
    // create_group (создатель) и в import_group, и без контекста мутация била
    // не туда строку (урок ADR-005: «мутация не в той функции»).
    { name: 'новый участник сразу считается имеющим ключ (key_shared)',
      pattern: '            group.members.push(GroupMember {\n                email: email.to_string(),\n                role: GroupRole::Member,\n                joined_at: chrono::Utc::now().to_rfc3339(),\n                key_shared: false,\n            });',
      replacement: '            group.members.push(GroupMember {\n                email: email.to_string(),\n                role: GroupRole::Member,\n                joined_at: chrono::Utc::now().to_rfc3339(),\n                key_shared: true,\n            });' },
  ],
};
