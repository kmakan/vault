// Node-смоук features/account-load.js — загрузка контактов, групп, профиля и
// локальных кэшей.
//
// Проверяем ПЕРЕНОС ДАННЫХ в состояние: раньше эти загрузки писали прямо в
// поля компонента, и «получили пустой список» выглядело как «контактов нет».
// Особенно важно: при смене почты старый адрес переименовывается в группах —
// без этого группы исчезают из UI (фильтр сравнивает по email).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/account-load-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/account-load.js',
  MOCKS + '/account-load.mjs',
  {},
  MOCKS,
);
const A = await import(MOCKS + '/account-load.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const s = {
    contacts: [], aliases: {}, groups: [],
    profiles: {}, avatarUrl: '',
    tombstones: null, midTombstones: null, cursors: null,
    merged: { keys: [], avatars: [], icons: [] },
    groupsStore: {
      mergeGroupKeys: (k) => { s.merged.keys.push(k); },
      mergeGroupAvatars: (a) => { s.merged.avatars.push(a); },
      mergeGroupIcons: (i) => { s.merged.icons.push(i); },
    },
    contactsStore: {
      state: { contacts: [{ email: 'a@x.ru' }], contactAliases: { 'a@x.ru': 'a2@x.ru' } },
      loaded: [],
      async loadContacts(email) { this.loaded.push(email); },
    },
  };
  const deps = {
    s,
    email: () => 'me@x.ru',
    fingerprint: () => 'FP',
    aliasesOf: (e) => e,
    contacts: () => s.contacts,
    groupsStore: s.groupsStore,
    profiles: () => s.profiles,
    userAvatarUrl: () => s.avatarUrl,
    contactsStore: s.contactsStore,
    setContacts: (v) => { s.contacts = v; },
    setContactAliases: (v) => { s.aliases = v; },
    setGroups: (v) => { s.groups = v; },
    setUserAvatarUrl: (v) => { s.avatarUrl = v; },
    setTombstonesCache: (v) => { s.tombstones = v; },
    setMidTombstonesCache: (v) => { s.midTombstones = v; },
    setCursorsCache: (v) => { s.cursors = v; },
    loadGroupsData: async () => ({
      groups: [{ id: 'g1' }],
      keys: { g1: 'GK' },
      avatars: { g1: 'AV' },
      icons: { g1: 'IC' },
      newContacts: [{ email: 'new@x.ru' }],
    }),
    migrateOwnProfileData: async () => ({ key: 'FP', profile: { avatar: 'NEWAV' } }),
    loadLocalCaches: async () => ({
      tombstones: { t: 1 }, midTombstones: { m: 1 }, cursors: { inbox: 'uid' },
    }),
    ...over,
  };
  return deps;
}

// ── Контакты ───────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await A.loadContacts(deps);
  check('контакты: владелец загружен под нашим адресом',
    deps.s.contactsStore.loaded[0] === 'me@x.ru', deps.s.contactsStore.loaded);
  check('контакты: список перенесён в состояние',
    deps.s.contacts.length === 1 && deps.s.contacts[0].email === 'a@x.ru', deps.s.contacts);
  check('контакты: алиасы перенесены', deps.s.aliases['a@x.ru'] === 'a2@x.ru', deps.s.aliases);
}

// ── Группы ─────────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await A.loadGroups(deps);
  check('группы: список перенесён', deps.s.groups.length === 1 && deps.s.groups[0].id === 'g1', deps.s.groups);
  check('группы: ключи отданы владельцу', deps.s.merged.keys.length === 1, deps.s.merged.keys);
  check('группы: аватары отданы владельцу', deps.s.merged.avatars.length === 1, deps.s.merged.avatars);
  check('группы: иконки отданы владельцу', deps.s.merged.icons.length === 1, deps.s.merged.icons);
  check('группы: новые контакты добавлены', deps.s.contacts.some((c) => c.email === 'new@x.ru'), deps.s.contacts);
}
{
  const deps = makeDeps({ loadGroupsData: async () => ({ newContacts: [] }) });
  await A.loadGroups(deps);
  check('группы: без групп состояние не трогаем', deps.s.groups.length === 0, deps.s.groups);
}

// ── Профиль при смене почты ────────────────────────────────────────────
{
  const deps = makeDeps();
  await A.migrateOwnProfile(deps, 'old@x.ru', 'new@x.ru');
  check('профиль: запись по ключу добавлена', deps.s.profiles['FP'] && deps.s.profiles['FP'].avatar === 'NEWAV', deps.s.profiles);
  check('профиль: аватар обновлён', deps.s.avatarUrl === 'NEWAV', deps.s.avatarUrl);
}
{
  const deps = makeDeps({ migrateOwnProfileData: async () => null });
  await A.migrateOwnProfile(deps, 'old@x.ru', 'new@x.ru');
  check('профиль: при отсутствии миграции ничего не портим', deps.s.avatarUrl === '', deps.s.avatarUrl);
}

// ── Локальные кэши ─────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await A.initLocalDb(deps);
  check('кэши: тombстоуны загружены', deps.s.tombstones && deps.s.tombstones.t === 1, deps.s.tombstones);
  check('кэши: mid-томбстоуны загружены', deps.s.midTombstones && deps.s.midTombstones.m === 1, deps.s.midTombstones);
  check('кэши: курсоры загружены', deps.s.cursors && deps.s.cursors.inbox === 'uid', deps.s.cursors);
}
{
  const deps = makeDeps({ loadLocalCaches: async () => ({}) });
  await A.initLocalDb(deps);
  check('кэши: пустые кэши не затирают состояние',
    deps.s.tombstones === null && deps.s.cursors === null, deps.s);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
