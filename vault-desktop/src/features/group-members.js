// Управление участниками группы — ADR-005 W3.
//
// Логика вынесена из App.vue: состав группы и роли — это правила, а не
// поведение компонента. Здесь шесть операций: открыть попап выбора, отметить
// участника, ввести адрес вручную, добавить, удалить, сменить роль.
//
// ЗАЩИТА ОТ ОБХОДА UI (это важно): удаление участников и смена ролей — только
// у админов. Проверка «я админ» повторяется в фиче, а не только прячется в
// шаблоне: иначе действие, доступное из консоли, меняло бы состав группы.
//
// СОЗДАТЕЛЬ НЕПРИКОСНОВЕНЕН: удалить его нельзя — может только выйти сам
// («Покинуть группу»). Попытка удаления показывает объяснение.
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами:
//   group() / isGroupAdmin() — что открыто и наши ли мы админ;
//   api.removeGroupMember / api.setGroupMemberRole — изменения на сервере;
//   refreshGroupMembers() — перечитать состав после изменения;
//   getFormField / setFormField — поля формы выбора участников (uiStore);
//   setModal(name, value) — флаги модалок (uiStore);
//   alert(msg) / toast(msg) / tr(key) — обратная связь;
//   createGroup() / closeCreateGroup() — создание группы (для «создать и закрыть»).

// Открыть попап выбора участников.
export function openAddMemberPopup(deps) {
  deps.setFormField('addMemberQuery', '');
  deps.setFormField('addMemberSelected', []);
  deps.setModal('showAddMemberPopup', true);
}

// Отметить/снять отметку участника в выбранных.
export function toggleAddMember(deps, email) {
  const selected = deps.getFormField('addMemberSelected') || [];
  const next = selected.slice();
  const i = next.indexOf(email);
  if (i >= 0) next.splice(i, 1);
  else next.push(email);
  deps.setFormField('addMemberSelected', next);
}

// Ввести email вручную: добавляем в выборку, отправка — кнопкой «Пригласить».
export function addManualEmail(deps) {
  const email = (deps.getFormField('addMemberQuery') || '').trim();
  if (!email || !email.includes('@')) return false;
  const members = (deps.group() && deps.group().members) || [];
  if (members.some((m) => m.email === email)) {
    deps.alert(deps.tr('already_in_group') || 'Этот участник уже в группе');
    return false;
  }
  const selected = deps.getFormField('addMemberSelected') || [];
  if (!selected.includes(email)) deps.setFormField('addMemberSelected', selected.concat([email]));
  deps.setFormField('addMemberQuery', '');
  return true;
}

// Основной UX добавления участника — попап выбора контактов.
export function addMember(deps, email) {
  deps.openAddMemberPopup();
}

// Удалить участника. Только админ, и не создателя.
export async function removeMember(deps, email) {
  const group = deps.group();
  if (!group) return false;
  if (!deps.isGroupAdmin()) return false;
  const member = (group.members || []).find((m) => m.email === email);
  if (!member) return false;
  if (email === group.created_by) {
    deps.alert(deps.tr('cannot_remove_creator') || 'Создателя группы нельзя удалить');
    return false;
  }
  try {
    await deps.api.removeGroupMember(group.id, email);
    await deps.refreshGroupMembers();
    return true;
  } catch (e) {
    console.error('removeMember failed:', e);
    return false;
  }
}

// Сменить роль участника. Только админ: участники пользуются чатом, но
// ролями и составом не управляют.
export async function changeMemberRole(deps, email, role) {
  const group = deps.group();
  if (!group) return false;
  if (!deps.isGroupAdmin()) return false;
  try {
    await deps.api.setGroupMemberRole(group.id, email, role);
    const m = (group.members || []).find((x) => x.email === email);
    if (m) m.role = role;
    return true;
  } catch (e) {
    deps.alert('Failed to set role: ' + e.message);
    return false;
  }
}

// Создать группу и закрыть окно создания.
export function createGroupAndClose(deps) {
  deps.createGroup();
  deps.setModal('showCreateGroup', false);
}
