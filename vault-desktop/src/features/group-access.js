// Право в группе — ответ моста, а не вычисление во фронте (ADR-005 W4,
// партия 4d).
//
// ЧТО БЫЛО. «Я админ?», «я создатель?», «могу удалить этого участника?»
// фронт отвечал сам, сравнивая адреса: `App.vue::isGroupAdmin`,
// `GroupSettings.vue` (member.role === 'Admin' || group.created_by === currentUser).
// В JS нет ни `normalize` ядра, ни отпечатка: `Anna@Mail.RU` и `anna@mail.ru` —
// два разных адреса, участник, найденный по отпечатку после смены почты, — не
// я. Итог — кнопки управления исчезали у того, кто вправе управлять, и
// появлялись у строки чужого человека.
//
// ЧТО СТАЛО. Один вопрос к мосту (`groups_access`) отвечает сразу на все
// четыре: моя ли группа, создатель ли я, админ ли я, что можно с каждой
// строкой состава. Ответ приходит по позициям списка участников, поэтому
// фронт не сопоставляет адреса вовсе.
//
// ЧЕМ ВЛАДЕЕТ МОДУЛЬ. Состоянием «что можно в открытой группе» — пара
// (groupId, access). Правило — в мосте; здесь только вызов, защита от
// устаревшего ответа (поздний ответ по покинутой группе не перебивает
// свежий) и очистка.

import { invoke } from '@tauri-apps/api/core';

export function createGroupAccessStore() {
  // ВАЖНО: мутации идут ТОЛЬКО через `this.state`, а не через захваченный
  // объект. `liveState(groupAccessStore)` в App.vue заменяет `store.state` на
  // reactive-прокси, но замыкание продолжает смотреть в СЫРОЙ объект: запись
  // мимо прокси не будит ни один computed, и `groupAccess` навсегда остаётся
  // тем, что прочитали при первом рендере (null). Так кнопка «Добавить
  // участника» не появлялась у создателя группы, хотя мост отвечал
  // `can_manage: true`. Тот же класс регрессии, что в identity-store
  // (18.10.2026) — там он уже описан.
  const state = {
    groupId: null,
    // { is_mine, is_creator, is_admin, can_manage, members: [...] } либо null,
    // пока ответа нет / группа не открыта.
    access: null,
  };
  // Номер запроса: ответ применяется, только если группа не сменилась, пока
  // он ехал. Иначе быстрое переключение A → B показало бы права A на группе B.
  let seq = 0;

  async function fetchAccess(store, groupId, identity) {
    const ticket = ++seq;
    const me = identity();
    let access = null;
    try {
      access = await invoke('groups_access', {
        groupId: groupId || '',
        email: (me && me.email) || '',
        fingerprint: String((me && me.fingerprint) || ''),
        aliases: (me && me.aliases) || [],
      });
    } catch (e) {
      console.warn('[group-access] groups_access failed:', e);
    }
    if (ticket !== seq || store.state.groupId !== groupId) return null;
    store.state.access = access;
    return access;
  }

  return {
    state,

    // Открыта другая группа (или чат, или ничего) — сбросить ответ и спросить
    // заново. `identity` — функция, отдающая { email, fingerprint, aliases }.
    select(group, identity) {
      const groupId = (group && group.id) || null;
      this.state.groupId = groupId;
      this.state.access = null;
      if (!groupId || typeof identity !== 'function') return Promise.resolve(null);
      return fetchAccess(this, groupId, identity);
    },

    // Перечитать права открытой группы: после смены состава или роли.
    refresh(identity) {
      if (!this.state.groupId || typeof identity !== 'function') return Promise.resolve(null);
      return fetchAccess(this, this.state.groupId, identity);
    },

    // Сброс закрывает группу; номер запроса сдвигать не нужно — устаревший
    // ответ отбрасывается уже потому, что `state.groupId` больше не совпадает.
    clear() {
      this.state.groupId = null;
      this.state.access = null;
    },
  };
}

export const groupAccessStore = createGroupAccessStore();
