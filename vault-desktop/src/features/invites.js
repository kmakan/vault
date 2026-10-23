// Feature module: обработка входящих приглашений в группы (инвайт-попапы).
// ADR-005 W2 (`t_bcb8927a`), партия 4: модуль больше НЕ читает компонент.
//
// СОСТОЯНИЕ — У ВЛАДЕЛЬЦЕВ (ADR-004), ЭФФЕКТЫ — ЯВНЫЙ deps (ADR-005 R3):
//   · очередь инвайтов/запросов и метки «в обработке» — владелец
//     `invites-store` (per-app, приходит в deps: `deps.invites`). Поля писали
//     ДВА модуля (этот и contacts.js) — значит у поля обязан быть владелец;
//   · флаги попапа (`showInvitePopup`, `invitePopupIndex` и пара контактов) —
//     UI-состояние, по ADR-003 §2 оно остаётся в компоненте; владелец флагов —
//     uiStore (modalFlags/formState), и модуль берёт его напрямую;
//   · `currentGroup` — владелец chatStore (ADR-004 J.3a);
//   · перезагрузка данных (loadGroups/loadChannels/…) — эффекты, их зовёт
//     компонент через deps.
//
// Поведение перенесено 1:1. Одно исправление: аватар группы после принятия
// инвайта писался через `groups().setGroupAvatar(...)`, а `groups` — это
// СПИСОК групп (App.vue data), а не стор: вызов падал TypeError, accept
// уходил в catch (ошибка + откат инвайта). Теперь это `deps.setGroupAvatar` —
// запись в владельца groups-store.

import api from '../api.js';
import { uiStore, chatStore } from './session-store.js';

// Флаги и индексы попапов — UI-состояние в uiStore (ADR-003 §2).
const showInvitePopup = () => uiStore.getModal('showInvitePopup');
const setShowInvitePopup = (v) => uiStore.setModal('showInvitePopup', v);
const invitePopupIndex = () => uiStore.getFormField('invitePopupIndex');
const setInvitePopupIndex = (v) => uiStore.setFormField('invitePopupIndex', v);
const showContactPopup = () => uiStore.getModal('showContactPopup');
const setShowContactPopup = (v) => uiStore.setModal('showContactPopup', v);
const contactPopupIndex = () => uiStore.getFormField('contactPopupIndex');
const setContactPopupIndex = (v) => uiStore.setFormField('contactPopupIndex', v);

export async function processInvites(deps) {
  const { invites, loadGroups, loadChannels, loadGroupMessages, refreshGroupMembers,
          loadStoredPeerKeys, loadContacts, loadProfiles, identity } = deps;
      // Сброс кэша handshake-писем (fetchAllHandshake): каждый поллинг
      // перечитывает письма заново — иначе новые инвайты/удаления не видны.
      api._handshakeCache = null;
      // Одноразовый sweep (v0.1.9): помечаем ВСЕ старые непокрытые handshake-письма,
      // чтобы «призрачные» инвайты/accept'ы не всплывали после удаления списков.
      try { await api.sweepStaleHandshake(); } catch (e) { /* ignore */ }
      // Обрабатываем accept-письма (добавление принявших участников).
      try {
        const accepts = await api.fetchPendingAccepts();
        if (accepts.length) {
          await loadGroups();
          try { await loadChannels(); } catch (e) { /* не критично */ }
          const currentGroup = chatStore.state.currentGroup;
          if (currentGroup) {
            await loadGroupMessages(currentGroup.id);
            await refreshGroupMembers();
          }
        }
      } catch (e) {
        console.error('processInvites: accepts failed:', e);
      }
      // Контакты 1-на-1 (модель почтовый мессенджер): accept-письма → добавляем ключи
      // ТОЛЬКО от отправителей, которых МЫ пригласили (invited-senders в api.js).
      // Удаление контакта — строго локальное (deleteContact): никаких писем-
      // уведомлений, никаких замков, никаких повторных отправок. Старые письма
      // удалённого контакта помечаются tombstone по uid и не воскрешают его.
      try {
        const contactAccepts = await api.fetchPendingContactAccepts();
        if (contactAccepts.length) {
          // fetchPendingContactAccepts пишет ключи на диск (save_peer_key),
          // но НЕ в peerKeys — перечитываем с диска, иначе selectChat
          // не найдёт ключ и предложит «добавить контакт».
          await loadStoredPeerKeys();
          await loadContacts();
          await loadGroups();
          try { await loadChannels(); } catch (e) { /* не критично */ }
        }
      } catch (e) {
        console.error('processInvites: contact accepts failed:', e);
      }
      // Собираем непрочитанные инвайты для попапа согласия.
      try {
        // «Группа уже импортирована?» — вопрос мосту: идентичность решает
        // отпечаток (стабилен при смене почты), адреса — fallback.
        const invitesList = await api.fetchPendingInvites(identity);
        // Вырезаем инвайты, которые уже обрабатываются (accept в полёте —
        // письмо ещё в ящике, а groups_import мог ещё не завершиться).
        const fresh = invitesList.filter(
          inv => !invites.isInviteHandled(`${inv.group_id}|${inv.uid}`)
        );
        if (fresh.length) {
          // Пока попап показан, очередью управляют accept/decline (splice) —
          // перезапись от поллинга сбивала invitePopupIndex посреди разбора.
          if (!showInvitePopup()) {
            invites.setPendingInvites(fresh);
            setInvitePopupIndex(0);
            setShowInvitePopup(true);
          }
        } else if (!showInvitePopup()) {
          invites.setPendingInvites([]);
        }
      } catch (e) {
        console.error('processInvites: invites failed:', e);
      }
      // Запросы контактов 1-на-1 — попап «Принять/Отклонить».
      try {
        const contacts = await api.fetchPendingContactInvites();
        const fresh = contacts.filter(
          c => !invites.isContactHandled(`${c.sender}|${c.uid}`)
        );
        if (fresh.length) {
          if (!showContactPopup()) {
            invites.setPendingContacts(fresh);
            // Групповой попап имеет приоритет; контактный покажем следом.
            if (!showInvitePopup()) {
              setContactPopupIndex(0);
              setShowContactPopup(true);
            }
          }
        } else if (!showContactPopup()) {
          invites.setPendingContacts([]);
        }
      } catch (e) {
        console.error('processInvites: contact invites failed:', e);
      }
      try {
        loadProfiles();
      } catch (e) {
        console.error('processInvites: loadProfiles failed:', e);
      }
}

// ── ADR-001 Этап 3 (invites): acceptInvite/declineInvite/showNextInvite вынесены из App.vue.
// deps: decryptGroupKey/kvSet/showToast/t/loadGroupMessages/… — инъекция из App.vue
// (ADR-001 pattern; smoke не мокает crypto/uiStore/db/groups).
export async function acceptInvite(inv, deps) {
  const { invites, decryptGroupKey, kvSet, showToast, t, loadGroupMessages,
          isCryptoReady, groups, setGroupAvatar, showNextInvite } = deps;
  const key = `${inv.group_id}|${inv.uid}`;
  invites.markInviteHandled(key);
  invites.splicePendingInvite(invitePopupIndex());
  setShowInvitePopup(false);
  try {
    if (groups().some(g => g.id === inv.group_id)) {
      showToast((t('already_in_groups') || 'Вы уже состоите в этой группе') + ': ' + (inv.group_name || inv.group_id), 3000);
      showNextInvite();
      return;
    }
    let groupKey = inv.group_key || null;
    if (!groupKey && inv.group_key_enc && inv.sender_public_key && isCryptoReady()) {
      groupKey = await decryptGroupKey(inv.group_key_enc, inv.sender_public_key);
      if (!groupKey) throw new Error('Не удалось расшифровать ключ группы');
    }
    if (!groupKey) throw new Error('В приглашении нет ключа группы');
    await api.acceptGroupInvite(inv.group_id, { ...inv, group_key: groupKey });
    if (inv.group_avatar) {
      await kvSet('anon', 'group-avatar:' + inv.group_id, inv.group_avatar);
      // Аватар пишет ВЛАДЕЛЕЦ groups-store. Раньше здесь был
      // `groups().setGroupAvatar(...)`, а groups — это СПИСОК групп: вызов
      // падал TypeError, и accept уходил в catch (ошибка + откат инвайта).
      setGroupAvatar(inv.group_id, inv.group_avatar);
    }
    await deps.loadGroups();
    try { await deps.loadChannels(); } catch (e) { /* не критично */ }
    const currentGroup = chatStore.state.currentGroup;
    if (currentGroup && currentGroup.id === inv.group_id) {
      await loadGroupMessages(inv.group_id);
    }
  } catch (e) {
    alert('Failed to accept invite: ' + e.message);
    invites.unmarkInviteHandled(key);
    invites.pushPendingInvite(inv);
  }
  showNextInvite();
}

export async function declineInvite(inv, deps) {
  const { invites, showNextInvite } = deps;
  const key = `${inv.group_id}|${inv.uid}`;
  invites.markInviteHandled(key);
  invites.splicePendingInvite(invitePopupIndex());
  setShowInvitePopup(false);
  try {
    await api.declineGroupInvite(inv.group_id, inv.uid, inv.sender);
  } catch (e) {
    // ignore
  }
  showNextInvite();
}

export function showNextInvite(deps) {
  const { clearNextTimer, setNextTimer, invites } = deps;
  clearNextTimer();
  if (invites.getPendingInvites().length > 0) {
    if (invitePopupIndex() >= invites.getPendingInvites().length) setInvitePopupIndex(0);
    setNextTimer(() => {
      if (invites.getPendingInvites().length && !showInvitePopup()) {
        setShowInvitePopup(true);
      }
    }, 1200);
  } else {
    setShowInvitePopup(false);
    if (invites.getPendingContacts().length) {
      setNextTimer(() => {
        if (invites.getPendingContacts().length && !showContactPopup()) {
          setShowContactPopup(true);
        }
      }, 1200);
    }
  }
}
