// Управление группой: перечитывание, аватар, отпечатки, выход и удаление —
// ADR-005 W3.
//
// Логика вынесена из App.vue. Восемь операций, которые меняют или читают
// состояние группы; между собой они связаны тем, что все работают с ОДНОЙ
// группой (текущей) и одним её составом.
//
// ПРАВИЛО ПРО ОТПЕЧАТКИ (emailSharesFingerprint): два адреса могут указывать
// на одного и того же человека — смена почты оставляет старый адрес в
// peer_keys с тем же публичным ключом. Поэтому «участник группы» и
// «адрес» — не одно и то же: сравнивать надо ключи, а не строки.
// Сам отпечаток участника и его починку считает мост: здесь остаётся только
// вопрос «один ли это человек по двум адресам» для списка контактов.
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами:
//   group() / groups() / activeChat() — что открыто;
//   setGroups(list) / setCurrentGroup(v) / setActiveChat(v) / setGroupSettings(v)
//     — запись состояния (владельцы состояния — ADR-004);
//   chat.set([]) — очистка чата;
//   peerKeys / groupKeys / cryptoReady — ключи;
//   api.* — серверные операции; db.kvSet — локальное хранилище;
//   broadcastGroupMeta(groupId, payload) — рассылка мета-писем участникам
//     (features/group-meta-broadcast.js — приходит через deps: фича не знает
//     про фичу);
//   (починка отпечатков — команда моста groups_backfill_member_fingerprints);
//   fileToAvatarDataUrl(file, kind) / avatarTooBig(size) — обработка картинки;
//   alert(msg) / tr(key) — обратная связь.
import { invoke } from '@tauri-apps/api/core';

// Перечитать сообщения группы (с полным пересканированием) и прокрутить вниз.
export async function refreshGroupFull(deps) {
  const group = deps.group();
  if (!group) return;
  await deps.loadGroupMessages(group.id, true);
  deps.scrollToBottom(false);
}

// Перечитать состав участников.
export async function refreshGroupMembers(deps) {
  const group = deps.group();
  if (!group) return;
  try {
    group.members = await deps.api.getGroupMembers(group.id);
    // Состав перечитан — права могли измениться (принят новый участник,
    // роль из свежего инвайта). Вопрос «что мне можно» — к мосту.
    await deps.refreshGroupAccess();
  } catch (e) {
    console.error('refreshGroupMembers failed:', e);
  }
}

// Выбран файл аватара НОВОЙ группы (черновик) — в превью.
export async function onNewGroupAvatarSelected(deps, e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (deps.avatarTooBig(file.size)) {
    deps.alert(deps.tr('err_file_too_big_500'));
    e.target.value = '';
    return;
  }
  e.target.value = '';
  try {
    deps.setNewGroupAvatar(await deps.fileToAvatarDataUrl(file, deps.GROUP_AVATAR));
  } catch (err) {
    // Раньше обработчиков отказа не было вовсе: битый файл оставлял промес
    // навечно, и сообщения об этом не было нигде.
    console.warn('[avatar] draft image failed:', err && err.message || err);
    deps.alert(deps.tr('err_image_decode') || 'Не удалось прочитать изображение');
  }
}

// Аватар группы обновлён: сохранить локально и разослать участникам.
export async function onGroupAvatarUpdate(deps, { groupId, avatar }) {
  deps.setGroupAvatar(groupId, avatar);
  await deps.db.kvSet('anon', 'group-avatar:' + groupId, avatar || '');
  if (!avatar) return;
  // Ключ группы мог быть ещё не загружен (настройки открыты без чата) —
  // тогда рассылка МОЛЧА пропускалась и у участников аватар не появлялся
  // никогда. Правило догрузки ключа — в features/group-meta-broadcast.js.
  const r = await deps.broadcastGroupMeta(groupId, { avatar },
    { groupKeys: deps.groupKeys(), cryptoReady: deps.cryptoReady() });
  if (!r.sent) {
    console.error('Failed to broadcast group avatar:', r.error || r.reason);
  }
}

// Один и тот же ли человек за двумя адресами (смена почты).
export function emailSharesFingerprint(deps, emailA, emailB) {
  const keys = deps.peerKeys();
  const ka = keys[emailA || ''] || keys[String(emailA || '').toLowerCase()];
  const kb = keys[emailB || ''] || keys[String(emailB || '').toLowerCase()];
  return !!(ka && kb && ka === kb);
}

// Восстановить/починить отпечатки участников по peer_keys.
//
// РЕШЕНИЕ — В МОСТЕ. Раньше здесь перебирались `deps.peerKeys()` (это
// ПУБЛИЧНЫЕ ключи, не отпечатки) и значение писалось в поле `fingerprint`:
// в живом groups.json появились две формы одного поля — отпечаток и 64-hex
// ключ, и fp-матчинг для второй записи не работал. Теперь мост сам читает
// ключи, считает отпечаток ядром и чинит запись; фронт только просит и
// принимает обновлённый состав.
export async function backfillGroupFingerprints(deps, group) {
  if (!group || !group.id) return;
  try {
    const updated = await invoke('groups_backfill_member_fingerprints', {
      groupId: group.id,
    });
    if (updated && Array.isArray(updated.members)) {
      group.members = updated.members;
    }
  } catch (e) { /* тихо: поле некритично для матчинга, идёт по peer_keys */ }
}

// Покинуть группу: мы больше не участник — группа исчезает из списка.
export async function leaveGroup(deps) {
  const group = deps.group();
  if (!group) return;
  const gid = group.id;
  try {
    await deps.api.leaveGroup(gid);
  } catch (e) {
    console.error('leaveGroup failed:', e);
  }
  deps.setGroups(deps.groups().filter((g) => g.id !== gid));
  deps.setGroupSettings(false);
  deps.setCurrentGroup(null);
  if (deps.activeChat() === `group:${gid}`) {
    deps.setActiveChat(null);
    deps.chat.set([]);
  }
}

// Удалить группу (у администратора) — то же, что выход, но группа исчезает
// у всех.
export async function deleteGroup(deps) {
  const group = deps.group();
  if (!group) return;
  const gid = group.id;
  try {
    await deps.api.deleteGroup(gid);
  } catch (e) {
    console.error('deleteGroup failed:', e);
  }
  deps.setGroups(deps.groups().filter((g) => g.id !== gid));
  deps.setGroupSettings(false);
  deps.setCurrentGroup(null);
  if (deps.activeChat() === `group:${gid}`) {
    deps.setActiveChat(null);
    deps.chat.set([]);
  }
}
