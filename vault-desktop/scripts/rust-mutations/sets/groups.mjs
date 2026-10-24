// Набор мутаций: группы — роли, состав, блокировки (Rust-ядро).
//
// Правила: участник не добавляется дважды (по ФОРМЕ адреса, `identity`);
// роль повышается Member → Admin, Admin остаётся Admin, legacy Moderator
// становится Member; блокировка списывается один раз и снимается по той же
// форме адреса, что и состав. Паттерны — текст ПОСЛЕ rustfmt: цепочка
// `.iter().any(...)` развёрнута на строки, одной строкой её не найти.
export default {
  id: 'groups',
  file: 'vault-client/src/vault/groups.rs',
  smoke: 'cargo test -p vault-client --lib',
  kind: 'lib',
  mutations: [
    { name: 'участник добавляется дважды (дубль в составе группы)',
      pattern: '            if group\n                .members\n                .iter()\n                .any(|m| crate::vault::identity::same_address(&m.email, email))\n            {\n                return Err("Member already in group".into());\n            }',
      replacement: '            if false {\n                return Err("Member already in group".into());\n            }' },
    { name: 'дубль участника сравнивается точным адресом (регистр и пробелы плодят вторую запись)',
      pattern: '                .any(|m| crate::vault::identity::same_address(&m.email, email))',
      replacement: '                .any(|m| m.email == email)' },
    { name: 'роль не повышается (Member остаётся Member)',
      pattern: '                        GroupRole::Member => GroupRole::Admin,',
      replacement: '                        GroupRole::Member => GroupRole::Member,' },
    { name: 'модератор становится админом (повышение прав чужого участника)',
      pattern: '                        GroupRole::Moderator => GroupRole::Member,',
      replacement: '                        GroupRole::Moderator => GroupRole::Admin,' },
    { name: 'блокировка добавляется дважды',
      pattern: '            if group\n                .blocked\n                .iter()\n                .any(|e| crate::vault::identity::same_address(e, email))\n            {\n                return Err("User already blocked".into());\n            }',
      replacement: '            if false {\n                return Err("User already blocked".into());\n            }' },
    { name: 'список блокировки сравнивает адрес точно (блокировка в другом написании не скрывает письма)',
      pattern: '            .map(|g| {\n                g.blocked\n                    .iter()\n                    .any(|e| crate::vault::identity::same_address(e, email))\n            })',
      replacement: '            .map(|g| g.blocked.iter().any(|e| e == email))' },
    { name: 'снятие блокировки не работает (заблокированный остаётся в списке)',
      pattern: '            group\n                .blocked\n                .retain(|e| !crate::vault::identity::same_address(e, email));',
      replacement: '            group.blocked.retain(|_| true);' },
    // Цель — ИМЕННО add_member: строка `key_shared: false` встречается ещё в
    // create_group (создатель) и в import_group, и без контекста мутация била
    // не туда строку (урок ADR-005: «мутация не в той функции»).
    { name: 'новый участник сразу считается имеющим ключ (key_shared)',
      pattern: '            group.members.push(GroupMember {\n                email: email.to_string(),\n                role: GroupRole::Member,\n                joined_at: chrono::Utc::now().to_rfc3339(),\n                key_shared: false,\n                fingerprint: String::new(),\n                invited: false,\n            });',
      replacement: '            group.members.push(GroupMember {\n                email: email.to_string(),\n                role: GroupRole::Member,\n                joined_at: chrono::Utc::now().to_rfc3339(),\n                key_shared: true,\n                fingerprint: String::new(),\n                invited: false,\n            });' },
  ],
};
