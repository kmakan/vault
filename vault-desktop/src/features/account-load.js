// Загрузка данных аккаунта: контакты, группы, профиль, локальные кэши —
// ADR-005 W3 (финальная партия W3).
//
// Четыре загрузки, которые выполняются при входе и при смене адреса. Раньше
// они жили в компоненте, и каждая писала в его поля напрямую — состояние
// принадлежало компоненту, а не владельцам.
//
// ПРАВИЛО ПРО ГРУППЫ: файлы групп лежат в ~/.vault/groups.json, и адрес в них
// может быть старым (пользователь сменил почту). Если адрес не совпадёт с
// нашим, группа отфильтруется и исчезнет из UI — поэтому при смене почты
// старый адрес переименовывается в группах (migrateOwnGroups).
//
// ПРАВИЛО ПРО КЭШИ: локальные кэши (томбстоуны, курсоры) грузятся в
// компонент, но состояние — у владельцев; здесь только перенос значений.
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами.

// Загрузить контакты и их адреса-алиасы (владелец — contactsStore).
export async function loadContacts(deps) {
  // ADR-004 J.5a: proxy на contactsStore singleton owner.
  await deps.contactsStore.loadContacts(deps.email());
  deps.setContacts(deps.contactsStore.state.contacts);
  deps.setContactAliases(deps.contactsStore.state.contactAliases);
}

// Загрузить группы (список, ключи, аватары, иконки) и новые контакты.
export async function loadGroups(deps) {
  const r = await deps.loadGroupsData({
    email: deps.email(),
    fingerprint: deps.fingerprint(),
    aliasesOf: deps.aliasesOf,
    contacts: deps.contacts(),
    requestGroupAvatarHeal: deps.requestGroupAvatarHeal,
  });
  if (r.groups) deps.setGroups(r.groups);
  deps.groupsStore.mergeGroupKeys(r.keys || {});
  deps.groupsStore.mergeGroupAvatars(r.avatars || {});
  deps.groupsStore.mergeGroupIcons(r.icons);
  for (const c of r.newContacts) deps.contacts().push(c);
}

// Смена СВОЕЙ почты: переименовать старый адрес в группах, где мы участник
// или создатель. Без этого groups.json остаётся со старым адресом, и после
// смены все группы исчезают из UI (фильтр loadGroups сравнивает по email).
// Для ПИРОВ этот путь не нужен — у них он срабатывает автоматически при
// fingerprint-матчинге.
export async function migrateOwnProfile(deps, oldEmail, newEmail) {
  const r = await deps.migrateOwnProfileData(oldEmail, newEmail);
  if (!r) return;
  const profiles = deps.profiles();
  if (profiles && typeof profiles === 'object') profiles[r.key] = r.profile;
  deps.setUserAvatarUrl((r.profile || {}).avatar || deps.userAvatarUrl());
}

// Локальные кэши аккаунта: томбстоуны и курсоры.
export async function initLocalDb(deps) {
  const r = await deps.loadLocalCaches(deps.email());
  if (r.tombstones) deps.setTombstonesCache(r.tombstones);
  if (r.midTombstones) deps.setMidTombstonesCache(r.midTombstones);
  if (r.cursors) deps.setCursorsCache(r.cursors);
}
