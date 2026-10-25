// ЗАЧЕМ. Очередь моста `t_61bd5090`, пункт 8. `groups.rs` — дыра ратчета
// плотности (ни одной мутации при 43 обычных тестах). Здесь два живых контракта:
//   1) токен приглашения `inv_<group_id>_<16-hex>`: пишет его `group_invite`,
//      читает `accept_invite` — две половины одного формата, разъехаться они
//      могут молча (разделитель, префикс, кусок, длина энтропии); group_id сам
//      содержит `_`, поэтому разбор делит ПО ПОСЛЕДНЕМУ подчёркиванию;
//   2) `apply_rename`: при смене почты переименовывается и `created_by`. Если
//      ветка не срабатывает, группа остаётся с несуществующим владельцем; если
//      она возвращает «не тронуто», правка не доходит до файла (`rename_address`
//      пишет только когда затронуты группы) — и наоборот, лишняя `true` на
//      холостом проходе перезаписывает `groups.json` каждую миграцию.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (не измеримо в изоляции, а не «забыто»):
//   * `get_groups_path`/`VAULT_GROUPS_FILE` — страж редиректа хранилища. Мутант,
//     снимающий его, писал бы ЖИВОЙ `~/.vault/groups.json` того, кто запустил
//     гейт (то же правило, что записано для `TEST_CHANNELS_FILE`).
//   * `Utc::now().to_rfc3339()` в `created_at`/`joined_at` — wall-часы.
//   * `rand::thread_rng().fill_bytes(&mut id_bytes)` — недетерминированно:
//     под генератор ничего не подменяют, поэтому меряется ДЛИНА энтропии
//     (мутация «8 байт → 4»), а уникальность двух токенов одной группы —
//     простым `assert_ne!` (шанс совпадения 2^-64, флейк не создаёт).
//
// ПОЛЯ `smoke` В RUST-ГЕЙТЕ ПОКА ДЕКОРАТИВНО (вердикт даёт весь либ-прогон,
// долг записан отдельной задачей), поэтому имена проб обязаны попадать под
// фильтр вручную — иначе «зелёный» набор может быть пойман соседним тестом:
//   invite_token_carries_the_group_id_and_its_entropy_suffix
//   accept_invite_rejects_a_token_without_an_entropy_suffix
//   accept_invite_splits_the_token_at_the_last_underscore
//   accept_invite_registers_the_member_exactly_once
//   invite_refuses_a_member_whose_address_differs_only_in_form
//   rename_address_of_an_already_renamed_creator_reports_nothing_touched

export default {
  id: 'rust-bridge-groups-invite',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/groups.rs',
  smoke: 'cargo test -p vault-desktop --lib invite',
  timeoutMs: 900_000,
  mutations: [
    { name: 'формат: из токена убрана anti-replay часть (только group_id)',
      pattern: '    let token = format!("inv_{}_{}", gid, hex::encode(id_bytes));',
      replacement: '    let token = format!("inv_{}", gid);' },
    { name: 'формат: разделитель токена изменён (читатель его не найдёт)',
      pattern: '    let token = format!("inv_{}_{}", gid, hex::encode(id_bytes));',
      replacement: '    let token = format!("inv_{}%{}", gid, hex::encode(id_bytes));' },
    { name: 'формат: энтропия токена урезана вдвое',
      pattern: `    let mut id_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut id_bytes);
    let token = format!("inv_{}_{}", gid, hex::encode(id_bytes));`,
      replacement: `    let mut id_bytes = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut id_bytes);
    let token = format!("inv_{}_{}", gid, hex::encode(id_bytes));` },
    { name: 'разбор: префикс inv_ не снимается',
      pattern: '    let body = token.strip_prefix("inv_").unwrap_or(token);',
      replacement: '    let body = token;' },
    { name: 'разбор: деление по ПЕРВОМУ подчёркиванию (group_id содержит "_")',
      pattern: '    let parts: Vec<&str> = body.rsplitn(2, "_").collect();',
      replacement: '    let parts: Vec<&str> = body.splitn(2, "_").collect();' },
    { name: 'разбор: вместо group_id взят кусок энтропии',
      pattern: '    let group_id = parts[1].to_string();',
      replacement: '    let group_id = parts[0].to_string();' },
    { name: 'разбор: хвост токена не проверяется (индекс вне массива)',
      pattern: '    if parts.len() < 2 {',
      replacement: '    if parts.len() < 1 {' },
    { name: 'приглашение: «уже участник» сверяется точной строкой (форма адреса игнорируется)',
      pattern: `    if group
        .members
        .iter()
        .any(|m| identity::same_address(&m.email, invitee_email))
    {
        anyhow::bail!(`,
      replacement: `    if group
        .members
        .iter()
        .any(|m| m.email == invitee_email)
    {
        anyhow::bail!(` },
    { name: 'accept: участник не добавляется (идемпотентность вместо регистрации)',
      pattern: '    let needs_push = !group',
      replacement: '    let needs_push = false && !group' },
    { name: 'accept: повторный accept дублирует участника',
      pattern: '    let needs_push = !group',
      replacement: '    let needs_push = true || !group' },
    { name: 'ренейм: created_by не переименовывается',
      pattern: '    if identity::same_address(&group.created_by, old_email) && group.created_by != new_email {',
      replacement: '    if false && identity::same_address(&group.created_by, old_email) {' },
    { name: 'ренейм: created_by даёт ложный «тронуто» на холостом проходе',
      pattern: `    if identity::same_address(&group.created_by, old_email) && group.created_by != new_email {
        group.created_by = new_email.to_string();
        return true;
    }`,
      replacement: `    if identity::same_address(&group.created_by, old_email) {
        group.created_by = new_email.to_string();
        return true;
    }` },
    { name: 'ренейм: переименованный created_by не помечает группу изменённой',
      pattern: `    if identity::same_address(&group.created_by, old_email) && group.created_by != new_email {
        group.created_by = new_email.to_string();
        return true;
    }`,
      replacement: `    if identity::same_address(&group.created_by, old_email) && group.created_by != new_email {
        group.created_by = new_email.to_string();
        return false;
    }` },
    { name: 'ренейм: файл не пишется, даже когда группы затронуты',
      pattern: `    if touched > 0 {
        save_groups(&groups)?;
    }`,
      replacement: `    if touched > usize::MAX {
        save_groups(&groups)?;
    }` },
  ],
};
