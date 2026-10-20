// Создание группы: имя, аватар, ключ шифрования и рассылка аватара участникам.
//
// ADR-003 Этап 3, партия 7. Тот же приём, что в groups-clone: оркестрация здесь,
// UI (alert, сброс полей диалога, открытие настроек) — в App.vue.
//
// ПОРЯДОК ОПЯЗАТЕЛЕН, И ПРИЧИНА НЕ В ЭСТЕТИКЕ. Оригинал клал группу в список и
// делал её текущей ДО генерации ключа шифрования. Если генерация падает
// (это вызов Rust), оригинал оставлял группу на экране и показывал ошибку. Если
// бы мы перенесли применение после генерации, группа была бы создана на
// Rust-стороне, но не появилась бы в UI — и пользователь увидел бы «создание не
// удалось» при группе, которая на самом деле существует. Поэтому применение
// состояния — в колбэк onCreated до генерации ключа.
//
// РАССЫЛКА АВАТАРА НЕ ЛОМАЕТ СОЗДАНИЕ. Аватар, заданный в диалоге, уходит
// участникам meta-письмом сразу. Если рассылка не удалась, группа уже создана и
// показывается — терять её из-за одного участника незачем, поэтому ошибка
// рассылки только логируется.
//
// КЛЮЧ ГЕНЕРИТСЯ ТОЛЬКО ПРИ cryptoReady. Без готовой крипто группы нельзя ни
// зашифровать инвайт, ни отправить в неё сообщение, поэтому группа без ключа
// допустима лишь как черновик, и создавать ключ без готовности бессмысленно.

import api, { db } from '../api.js';
import crypto from '../crypto.js';

export async function createGroup({ name, avatar, cryptoReady, onCreated }) {
  const group = await api.createGroup(name.trim(), '');
  group.members = group.members || [];
  group.blocked = group.blocked || [];
  // Аватар группы (если загружен в диалоге создания): sqlite kv_store,
  // тот же ключ, что использует GroupSettings/рассылка meta-письма.
  if (avatar) await db.kvSet('anon', 'group-avatar:' + group.id, avatar);
  // Применение состояния — до генерации ключа (см. шапку про порядок).
  if (onCreated) onCreated({ group, avatar });
  let groupKey = '';
  if (cryptoReady) {
    // Generate and store a group encryption key
    groupKey = await crypto.generateGroupKey();
    // Аватар, заданный при создании, сразу уходит участникам (meta-письмо),
    // как если бы админ поменял его в настройках группы.
    if (avatar) {
      try {
        const payload = JSON.stringify({ meta: 1, avatar });
        const content = await crypto.encryptWithGroupKey(payload, groupKey);
        await api.sendGroupMeta(group.id, content);
      } catch (e) {
        console.warn('Group avatar broadcast failed:', e);
      }
    }
  }
  return { group, groupKey };
}
// ── ADR-005 W3 (партия 11): поток создания группы из UI ────────────────
// Логика диалога (проверка имени, применение состояния, сохранение ключа,
// сброс полей, сообщение об ошибке) уехала из App.vue. UI-эффекты приходят
// deps'ами (ADR-003 §5.1): компонент остаётся источником состояния, но не
// владельцем ПОРЯДКА шагов.
//
// ПОРЯДОК СОХРАНЁН: состояние применяется ДО генерации ключа (см. шапку
// модуля) — иначе группа существовала бы на Rust-стороне, но не появилась бы
// в UI.
export async function createGroupFlow(deps, { name, avatar }) {
  const { cryptoReady, applyCreated, saveGroupKey, resetDialog, onError } = deps;
  if (!name || !name.trim()) return null;
  try {
    const { group, groupKey } = await createGroup({
      name, avatar, cryptoReady,
      onCreated: applyCreated,
    });
    if (groupKey) saveGroupKey(group.id, groupKey);
    resetDialog();
    return group;
  } catch (error) {
    onError(error);
    return null;
  }
}
