// Node-смоук features/group-management.js — управление группой.
//
// Что ловится: восемь операций, меняющих состояние группы. Две из них
// особенно опасны тихо: (1) отпечатки участников — без них группа остаётся с
// двумя участниками на один отпечаток, и при смене почты «участник»
// превращается в чужого; (2) выход из группы — если не убрать группу из
// списка и не закрыть настройки, пользователь остаётся «в группе», которой
// уже нет. Проверяем оба, а также рассылку аватара и обработку битой картинки.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-management-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const invokeCalls = [];
globalThis.__invokeMock = async (cmd, args) => {
  invokeCalls.push([cmd, args]);
  if (cmd === 'groups_backfill_member_fingerprints') {
    // Мост сам читает peer_keys и считает отпечаток; фронту возвращается
    // готовый состав. Пустое поле у nobody@x.ru — ключа нет.
    return {
      id: 'g1',
      members: [
        { email: 'peer@x.ru', fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:****' },
        { email: 'nobody@x.ru', fingerprint: '' },
      ],
    };
  }
  return null;
};
writeFileSync(MOCKS + '/tauri-core.js', 'export const invoke = (...a) => globalThis.__invokeMock(...a);\n');

prepareModuleCopy(
  ROOT + '/src/features/group-management.js',
  MOCKS + '/group-management.mjs',
  { '@tauri-apps/api/core': 'tauri-core.js' },
  MOCKS,
);
const GM = await import(MOCKS + '/group-management.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const st = {
    groups: [{ id: 'g1' }, { id: 'g2' }],
    group: { id: 'g1', members: [{ email: 'a@x.ru' }] },
    activeChat: 'group:g1',
    settingsOpen: true,
    chatMessages: ['x'],
    loaded: [],
    scrolled: 0,
    kv: [],
    broadcasts: [],
    avatar: null,
    newAvatar: null,
    alerts: [],
  };
  const deps = {
    st,
    group: () => st.group,
    groups: () => st.groups,
    setGroups: (l) => { st.groups = l; },
    setCurrentGroup: (v) => { st.group = v; },
    setGroupSettings: (v) => { st.settingsOpen = v; },
    activeChat: () => st.activeChat,
    setActiveChat: (v) => { st.activeChat = v; },
    chat: { set: (list) => { st.chatMessages = list; } },
    peerKeys: () => ({ 'peer@x.ru': 'KEY1', 'other@x.ru': 'KEY2' }),
    groupKeys: () => ({ g1: 'GKEY' }),
    cryptoReady: () => true,
    api: {
      getGroupMembers: async (gid) => [{ email: 'a@x.ru', role: 'member' }, { email: 'b@x.ru', role: 'member' }],
      leaveGroup: async (gid) => { st.left = gid; },
      deleteGroup: async (gid) => { st.deleted = gid; },
    },
    db: { kvSet: async (acc, k, v) => { st.kv.push([acc, k, v]); } },
    loadGroupMessages: async (id, force) => { st.loaded.push([id, force]); },
    scrollToBottom: (smooth) => { st.scrolled += 1; },
    setGroupAvatar: (id, av) => { st.avatar = [id, av]; },
    setNewGroupAvatar: (av) => { st.newAvatar = av; },
    avatarTooBig: (size) => size > 1000,
    fileToAvatarDataUrl: async (file, kind) => 'data:' + kind + ':' + file.name,
    GROUP_AVATAR: 'group',
    broadcastGroupMeta: async (gid, payload) => { st.broadcasts.push([gid, payload]); return { sent: true }; },
    alert: (msg) => { st.alerts.push(msg); },
    tr: (key) => key,
    ...over,
  };
  return deps;
}

// ── Перечитывание группы ───────────────────────────────────────────────
{
  const deps = makeDeps();
  await GM.refreshGroupFull(deps);
  check('обновление: сообщения перечитаны с пересканированием',
    deps.st.loaded.length === 1 && deps.st.loaded[0][0] === 'g1' && deps.st.loaded[0][1] === true, deps.st.loaded);
  check('обновление: прокрутка вниз', deps.st.scrolled === 1, deps.st.scrolled);
}
{
  const deps = makeDeps({ group: () => null });
  await GM.refreshGroupFull(deps);
  check('обновление: без группы — ничего', deps.st.loaded.length === 0 && deps.st.scrolled === 0, deps.st);
}
{
  const deps = makeDeps();
  await GM.refreshGroupMembers(deps);
  check('состав: перечитан', deps.st.group.members.length === 2, deps.st.group.members);
}
{
  const deps = makeDeps({
    api: { getGroupMembers: async () => { throw new Error('сеть'); } },
  });
  let threw = false;
  try { await GM.refreshGroupMembers(deps); } catch (e) { threw = true; }
  check('состав: сбой сети не пробрасывается', threw === false, threw);
}

// ── Аватар новой группы (черновик) ─────────────────────────────────────
{
  const deps = makeDeps();
  const e = { target: { files: [], value: 'x' } };
  await GM.onNewGroupAvatarSelected(deps, e);
  check('аватар: без файла — ничего', deps.st.newAvatar === null, deps.st.newAvatar);
}
{
  const deps = makeDeps();
  const e = { target: { files: [{ name: 'big.png', size: 5000 }], value: 'x' } };
  await GM.onNewGroupAvatarSelected(deps, e);
  check('аватар: слишком большой — предупреждение', deps.st.alerts.length === 1, deps.st.alerts);
  check('аватар: слишком большой — в превью не пошёл', deps.st.newAvatar === null);
  check('аватар: слишком большой — поле сброшено (тот же файл можно выбрать снова)', e.target.value === '', e.target.value);
}
{
  const deps = makeDeps();
  const e = { target: { files: [{ name: 'ok.png', size: 10 }], value: 'x' } };
  await GM.onNewGroupAvatarSelected(deps, e);
  check('аватар: файл принят в превью', deps.st.newAvatar === 'data:group:ok.png', deps.st.newAvatar);
  check('аватар: поле сброшено', e.target.value === '', e.target.value);
}
{
  const deps = makeDeps({
    fileToAvatarDataUrl: async () => { throw new Error('битый файл'); },
  });
  const e = { target: { files: [{ name: 'bad.png', size: 10 }], value: 'x' } };
  await GM.onNewGroupAvatarSelected(deps, e);
  check('аватар: битый файл — сообщение пользователю (а не тишина)',
    deps.st.alerts.length === 1, deps.st.alerts);
}

// ── Аватар группы: сохранение и рассылка ──────────────────────────────
{
  const deps = makeDeps();
  await GM.onGroupAvatarUpdate(deps, { groupId: 'g1', avatar: 'data:img' });
  check('аватар группы: записан в владельца', deps.st.avatar[0] === 'g1' && deps.st.avatar[1] === 'data:img', deps.st.avatar);
  check('аватар группы: записан в kv',
    deps.st.kv.length === 1 && deps.st.kv[0][1] === 'group-avatar:g1', deps.st.kv);
  check('аватар группы: разослан участникам',
    deps.st.broadcasts.length === 1 && deps.st.broadcasts[0][1].avatar === 'data:img', deps.st.broadcasts);
}
{
  const deps = makeDeps();
  await GM.onGroupAvatarUpdate(deps, { groupId: 'g1', avatar: '' });
  check('аватар группы: пустой — kv очищен', deps.st.kv[0][2] === '', deps.st.kv);
  check('аватар группы: пустой — рассылки нет (нечего рассылать)',
    deps.st.broadcasts.length === 0, deps.st.broadcasts);
}

// ── Отпечатки (смена почты) ────────────────────────────────────────────
{
  const deps = makeDeps();
  check('отпечатки: один и тот же ключ → один человек',
    GM.emailSharesFingerprint(deps, 'peer@x.ru', 'peer@x.ru') === true);
  check('отпечатки: разные ключи → разные люди',
    GM.emailSharesFingerprint(deps, 'peer@x.ru', 'other@x.ru') === false);
  check('отпечатки: неизвестный адрес → не делим',
    GM.emailSharesFingerprint(deps, 'peer@x.ru', 'unknown@x.ru') === false);
}
{
  const deps = makeDeps();
  const group = { id: 'g1', members: [{ email: 'peer@x.ru' }, { email: 'nobody@x.ru' }] };
  await GM.backfillGroupFingerprints(deps, group);
  check('отпечатки: мост вернул починенный состав',
    group.members[0].fingerprint === 'aa:bb:cc:dd:ee:ff:00:11:****', group.members);
  check('отпечатки: у кого ключа нет — остаётся пустым',
    !group.members[1].fingerprint, group.members[1]);
  check('отпечатки: фронт просит починку у моста',
    invokeCalls.some((c) => c[0] === 'groups_backfill_member_fingerprints' && c[1].groupId === 'g1'),
    invokeCalls);
  check('отпечатки: публичные ключи из peerKeys в поле не пишутся',
    !invokeCalls.some((c) => c[0] === 'groups_save_member_fingerprints'), invokeCalls);
}
{
  const deps = makeDeps();
  const group = { id: 'g1', members: [{ email: 'peer@x.ru', fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:****' }] };
  invokeCalls.length = 0;
  await GM.backfillGroupFingerprints(deps, group);
  check('отпечатки: решение «менять ли» — в мосте, вызов один',
    invokeCalls.filter((c) => c[0] === 'groups_backfill_member_fingerprints').length === 1, invokeCalls);
  check('отпечатки: выясненный отпечаток не перетёрт',
    group.members[0].fingerprint === 'aa:bb:cc:dd:ee:ff:00:11:****', group.members[0]);
}

// ── Выход и удаление ───────────────────────────────────────────────────
for (const [name, fn, marker] of [['выход', GM.leaveGroup, 'left'], ['удаление', GM.deleteGroup, 'deleted']]) {
  const deps = makeDeps();
  await fn(deps);
  check(`${name}: сервер вызван`, deps.st[marker] === 'g1', deps.st[marker]);
  check(`${name}: группа убрана из списка`, deps.st.groups.length === 1 && deps.st.groups[0].id === 'g2', deps.st.groups);
  check(`${name}: настройки закрыты`, deps.st.settingsOpen === false);
  check(`${name}: текущая группа сброшена`, deps.st.group === null);
  check(`${name}: открытый чат группы закрыт и очищен`,
    deps.st.activeChat === null && deps.st.chatMessages.length === 0, deps.st);
}
{
  const deps = makeDeps({ activeChat: () => 'chat:peer@x.ru' });
  await GM.leaveGroup(deps);
  check('выход: чужой открытый чат не трогаем', deps.activeChat() === 'chat:peer@x.ru', deps.activeChat());
}
{
  const deps = makeDeps({ group: () => null });
  await GM.leaveGroup(deps);
  check('выход: без группы — ничего', deps.st.left === undefined, deps.st);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
