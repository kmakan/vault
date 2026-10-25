// ЗАЧЕМ. Очередь моста `t_61bd5090`, пункт 9. `group_access` (groups.rs:647) —
// единственная точка, где мост превращает список участников в ответ фронта
// «что мне можно в этой группе». Сами ПРАВИЛА (`Access::may_manage`,
// `may_remove`, `may_set_role_of`, форма адреса и опознание участника)
// измерены в ядре — наборами `rust-group-rules` (27) и `rust-identity` (49).
// Здесь же измеряется только ПРОВОДКА: ядро было право, а мост передал не тот
// аргумент, подставил не то поле или свернул вопрос к более узкому — и UI
// получил «создателя можно удалить», «админ не админ», «это не моя группа».
// Такие дефекты не видны ни в одном ядровом наборе: там предикаты верны.
//
// ПОЧЕМУ ЭТО ДОРОГО: `group_access` кормит `GroupSettings.vue` (кнопки
// «удалить/роль»), `filter_own_groups`-подобную разметку списка и выход из
// группы. Ошибка здесь — это либо отказ в праве владельцу, либо разрешение
// чужому.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (не измеримо в изоляции, а не «забыто»):
//   * тела ядровых правил (`group_rules::Access::*`, `identity::*`) — они
//     мутируются СВОИМИ наборами, здесь мутируем только вызовы;
//   * `load_groups`/`save_groups` и редирект `VAULT_GROUPS_FILE` — страж
//     хранилища (см. правило `TEST_CHANNELS_FILE`): мутант писал бы живой
//     `~/.vault/groups.json`;
//   * `Utc::now()` — wall-часы.
//
// ИМЕНА ПРОБ (смоук `group_access` обязан собрать все четыре; поле `smoke` в
// rust-гейте пока декоративно — долг записан отдельной задачей):
//   group_access_creator_by_alias_keeps_management
//   group_access_assigned_admin_manages_but_creator_row_stays_locked
//   group_access_finds_me_by_fingerprint_under_another_address
//   group_access_stranger_without_membership_gets_no_rights

export default {
  id: 'rust-bridge-group-access',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/groups.rs',
  smoke: 'cargo test -p vault-desktop --lib group_access',
  timeoutMs: 900_000,
  mutations: [
    { name: 'алиас создателя не учитывается (группа «не моя» после смены почты)',
      pattern: `        is_creator: id.has_address(&group.created_by)
            || me
                .map(|m| identity::same_address(&m.email, &group.created_by))
                .unwrap_or(false),`,
      replacement: `        is_creator: me
            .map(|m| identity::same_address(&m.email, &group.created_by))
            .unwrap_or(false),` },
    { name: 'создателем считает себя тот, кого не нашли в списке',
      pattern: `                .map(|m| identity::same_address(&m.email, &group.created_by))
                .unwrap_or(false),`,
      replacement: `                .map(|m| identity::same_address(&m.email, &group.created_by))
                .unwrap_or(true),` },
    { name: 'назначенный админ не получает прав (роль сверяется с Member)',
      pattern: '        is_admin: me.map(|m| m.role == GroupRole::Admin).unwrap_or(false),',
      replacement: '        is_admin: me.map(|m| m.role == GroupRole::Member).unwrap_or(false),' },
    { name: 'своя запись ищется неправильно: первым участником считается любой',
      pattern: '        .find(|m| id.member_matches(&m.email, &m.fingerprint));',
      replacement: '        .find(|_m| true);' },
    { name: 'фронт не видит, какая строка списка — это я (кнопка «выйти» теряется)',
      pattern: '                is_self: id.member_matches(&m.email, &m.fingerprint),',
      replacement: '                is_self: false,' },
    // `may_remove` симметричен по своим двум булевым аргументам
    // (`&& !creator && !self`), поэтому «переставить аргументы» — ЭКВИВАЛЕНТНЫЙ
    // мутант, он ловится всегда и ничего не измеряет. Вместо него два настоящих:
    // снять учёт себя и снять учёт создателя.
    { name: 'себя можно удалить этим действием (выход — отдельная операция)',
      pattern: `                removable: access
                    .may_remove(is_creator, id.member_matches(&m.email, &m.fingerprint)),`,
      replacement: '                removable: access.may_remove(is_creator, false),' },
    { name: 'создателя можно удалить из списка участников',
      pattern: `                removable: access
                    .may_remove(is_creator, id.member_matches(&m.email, &m.fingerprint)),`,
      replacement: '                removable: access.may_remove(false, id.member_matches(&m.email, &m.fingerprint)),' },
    { name: 'роль можно ставить всем, включая создателя',
      pattern: '                settable_role: access.may_set_role_of(is_creator),',
      replacement: '                settable_role: access.may_set_role_of(false),' },
    { name: 'создатель без роли Admin теряет управление составом',
      pattern: '        can_manage: access.may_manage(),',
      replacement: '        can_manage: access.is_admin,' },
    { name: '«моя группа» свёрнута в «я создатель» (fp-only участники теряются)',
      pattern: '        is_mine: is_own_group(group, my_email, my_fingerprint, aliases),',
      replacement: '        is_mine: access.is_creator,' },
    { name: 'создателем помечен каждый участник списка',
      pattern: '            let is_creator = identity::same_address(&m.email, &group.created_by);',
      replacement: '            let is_creator = identity::same_address(&group.created_by, &group.created_by);' },
  ],
};
