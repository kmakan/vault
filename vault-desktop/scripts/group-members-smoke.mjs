// Node-смоук features/group-members.js — состав группы и роли.
//
// Что ловится: удаление участника и смена роли — операции, которые меняют
// доступ. Защита «только админ» повторяется в фиче (а не только прячется в
// шаблоне) — иначе действие, доступное из консоли, меняло бы состав группы.
// Проверяем: админскую защиту, неприкосновенность создателя, отказ от
// повторного добавления участника и то, что серверные изменения долетают до
// перечитывания состава.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-members-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/group-members.js',
  MOCKS + '/group-members.mjs',
  {},
  MOCKS,
);
const G = await import(MOCKS + '/group-members.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const st = {
    form: { addMemberQuery: '', addMemberSelected: [] },
    modals: {},
    alerts: [],
    apiCalls: [],
    refreshed: 0,
    created: 0,
  };
  // Группа — ОДИН объект на стенд: иначе «обновление роли в локальном
  // составе» проверяло бы разные объекты (и всегда давало бы «не обновилось»).
  const group = { id: 'g1', created_by: 'owner@x.ru', members: [{ email: 'owner@x.ru', role: 'owner' }, { email: 'a@x.ru', role: 'member' }] };
  const deps = {
    st,
    group: () => group,
    isGroupAdmin: () => true,
    api: {
      removeGroupMember: async (gid, email) => { st.apiCalls.push(['remove', gid, email]); },
      setGroupMemberRole: async (gid, email, role) => { st.apiCalls.push(['role', gid, email, role]); },
    },
    refreshGroupMembers: async () => { st.refreshed += 1; },
    getFormField: (name) => st.form[name],
    setFormField: (name, v) => { st.form[name] = v; },
    setModal: (name, v) => { st.modals[name] = v; },
    openAddMemberPopup: () => { st.opened = (st.opened || 0) + 1; },
    alert: (msg) => { st.alerts.push(msg); },
    toast: (msg) => { st.toasts = (st.toasts || []).concat([msg]); },
    tr: (key) => key,
    createGroup: () => { st.created += 1; },
    ...over,
  };
  return deps;
}

// ── Попап выбора участников ───────────────────────────────────────────
{
  const deps = makeDeps();
  deps.st.form.addMemberQuery = 'старый';
  deps.st.form.addMemberSelected = ['old@x.ru'];
  G.openAddMemberPopup(deps);
  check('попап: форма очищена', deps.st.form.addMemberQuery === '' && deps.st.form.addMemberSelected.length === 0, deps.st.form);
  check('попап: показан', deps.st.modals.showAddMemberPopup === true, deps.st.modals);
}
{
  const deps = makeDeps();
  G.toggleAddMember(deps, 'a@x.ru');
  check('отметка: участник добавлен', deps.st.form.addMemberSelected.length === 1, deps.st.form);
  G.toggleAddMember(deps, 'a@x.ru');
  check('отметка: повтор снимает', deps.st.form.addMemberSelected.length === 0, deps.st.form);
}
{
  const deps = makeDeps();
  G.toggleAddMember(deps, 'a@x.ru');
  G.toggleAddMember(deps, 'b@x.ru');
  check('отметка: несколько участников', deps.st.form.addMemberSelected.length === 2, deps.st.form);
}

// ── Ввод адреса вручную ────────────────────────────────────────────────
{
  const deps = makeDeps();
  check('ручной ввод: пусто — ничего', G.addManualEmail(deps) === false && deps.st.form.addMemberSelected.length === 0);
  deps.st.form.addMemberQuery = 'не-адрес';
  check('ручной ввод: без @ — ничего', G.addManualEmail(deps) === false);
}
{
  const deps = makeDeps();
  deps.st.form.addMemberQuery = 'a@x.ru';
  check('ручной ввод: уже в группе — отказ с объяснением',
    G.addManualEmail(deps) === false && deps.st.alerts.length === 1, deps.st.alerts);
  check('ручной ввод: уже в группе — в выборку не попал',
    deps.st.form.addMemberSelected.length === 0, deps.st.form);
}
{
  const deps = makeDeps();
  deps.st.form.addMemberQuery = ' new@x.ru ';
  check('ручной ввод: новый адрес добавлен', G.addManualEmail(deps) === true);
  check('ручной ввод: адрес обрезан и добавлен',
    deps.st.form.addMemberSelected[0] === 'new@x.ru', deps.st.form);
  check('ручной ввод: поле очищено', deps.st.form.addMemberQuery === '', deps.st.form);
}
{
  const deps = makeDeps();
  deps.st.form.addMemberQuery = 'new@x.ru';
  G.addManualEmail(deps);
  deps.st.form.addMemberQuery = 'new@x.ru';
  G.addManualEmail(deps);
  check('ручной ввод: повтор не дублирует', deps.st.form.addMemberSelected.length === 1, deps.st.form);
}

// ── Основной UX добавления ────────────────────────────────────────────
{
  const deps = makeDeps();
  G.addMember(deps, 'a@x.ru');
  check('добавление: открыт попап выбора', deps.st.opened === 1, deps.st);
}

// ── Удаление участника ────────────────────────────────────────────────
{
  const deps = makeDeps({ group: () => null });
  check('удаление: без группы — ничего', (await G.removeMember(deps, 'a@x.ru')) === false);
  check('удаление: без группы — сервер не трогаем', deps.st.apiCalls.length === 0, deps.st.apiCalls);
}
{
  const deps = makeDeps({ isGroupAdmin: () => false });
  check('удаление: не админ — ничего', (await G.removeMember(deps, 'a@x.ru')) === false);
  check('удаление: не админ — сервер не трогаем', deps.st.apiCalls.length === 0, deps.st.apiCalls);
}
{
  const deps = makeDeps();
  check('удаление: участника нет — ничего', (await G.removeMember(deps, 'no@x.ru')) === false);
}
{
  const deps = makeDeps();
  check('удаление: создателя нельзя', (await G.removeMember(deps, 'owner@x.ru')) === false);
  check('удаление: создателя — объяснение', deps.st.alerts.length === 1, deps.st.alerts);
  check('удаление: создателя — сервер не трогаем', deps.st.apiCalls.length === 0, deps.st.apiCalls);
}
{
  const deps = makeDeps();
  check('удаление: участника — ок', (await G.removeMember(deps, 'a@x.ru')) === true);
  check('удаление: участника — сервер получил группу и адрес',
    deps.st.apiCalls.length === 1 && deps.st.apiCalls[0][1] === 'g1' && deps.st.apiCalls[0][2] === 'a@x.ru',
    deps.st.apiCalls);
  check('удаление: состав перечитан', deps.st.refreshed === 1, deps.st.refreshed);
}
{
  const deps = makeDeps({
    api: { removeGroupMember: async () => { throw new Error('сеть недоступна'); } },
  });
  check('удаление: сбой сервера не пробрасывается', (await G.removeMember(deps, 'a@x.ru')) === false);
}

// ── Смена роли ─────────────────────────────────────────────────────────
{
  const deps = makeDeps({ isGroupAdmin: () => false });
  check('роль: не админ — ничего', (await G.changeMemberRole(deps, 'a@x.ru', 'admin')) === false);
  check('роль: не админ — сервер не трогаем', deps.st.apiCalls.length === 0, deps.st.apiCalls);
}
{
  const deps = makeDeps();
  check('роль: смена — ок', (await G.changeMemberRole(deps, 'a@x.ru', 'admin')) === true);
  check('роль: сервер получил роль',
    deps.st.apiCalls.length === 1 && deps.st.apiCalls[0][3] === 'admin', deps.st.apiCalls);
  check('роль: обновлена в локальном составе',
    (deps.group().members.find((m) => m.email === 'a@x.ru') || {}).role === 'admin',
    deps.group().members);
}
{
  const deps = makeDeps({
    api: { setGroupMemberRole: async () => { throw new Error('отказ'); } },
  });
  check('роль: сбой сервера — сообщение пользователю',
    (await G.changeMemberRole(deps, 'a@x.ru', 'admin')) === false && deps.st.alerts.length === 1,
    deps.st.alerts);
}

// ── Создание группы и закрытие окна ───────────────────────────────────
{
  const deps = makeDeps();
  G.createGroupAndClose(deps);
  check('создание: группа создана', deps.st.created === 1, deps.st);
  check('создание: окно закрыто', deps.st.modals.showCreateGroup === false, deps.st.modals);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
