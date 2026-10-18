// Feature module: обработка входящих приглашений в группы (инвайт-попапы).
// Этап 5 декомпозиции App.vue (ctx-паттерн). Вынесено из App.vue механически
// (this.* -> ctx.*, поведение 1:1). Управляет очередью pendingInvites,
// показом попапов, принятием/отклонением инвайтов (acceptGroupInvite/
// declineGroupInvite), загрузкой ключей групп. loadGroups/loadGroupMessages/
// loadChannels/loadContacts/loadProfiles/refreshGroupMembers/loadStoredPeerKeys
// остаются в App.vue и вызываются через ctx.

import api from '../api.js';

export async function processInvites(ctx) {
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
          await ctx.loadGroups();
          try { await ctx.loadChannels(); } catch (e) { /* не критично */ }
          if (ctx.currentGroup) {
            await ctx.loadGroupMessages(ctx.currentGroup.id);
            await ctx.refreshGroupMembers();
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
          // но НЕ в ctx.peerKeys — перечитываем с диска, иначе selectChat
          // не найдёт ключ и предложит «добавить контакт».
          await ctx.loadStoredPeerKeys();
          await ctx.loadContacts();
          await ctx.loadGroups();
          try { await ctx.loadChannels(); } catch (e) { /* не критично */ }
        }
      } catch (e) {
        console.error('processInvites: contact accepts failed:', e);
      }
      // Собираем непрочитанные инвайты для попапа согласия.
      try {
        const invites = await api.fetchPendingInvites();
        // Вырезаем инвайты, которые уже обрабатываются (accept в полёте —
        // письмо ещё в ящике, а groups_import мог ещё не завершиться).
        const fresh = invites.filter(
          inv => !ctx.handledInviteKeys.includes(`${inv.group_id}|${inv.uid}`)
        );
        if (fresh.length) {
          // Пока попап показан, очередью управляют accept/decline (splice) —
          // перезапись от поллинга сбивала invitePopupIndex посреди разбора.
          if (!ctx.showInvitePopup) {
            ctx.pendingInvites = fresh;
            ctx.invitePopupIndex = 0;
            ctx.showInvitePopup = true;
          }
        } else if (!ctx.showInvitePopup) {
          ctx.pendingInvites = [];
        }
      } catch (e) {
        console.error('processInvites: invites failed:', e);
      }
      // Запросы контактов 1-на-1 — попап «Принять/Отклонить».
      try {
        const contacts = await api.fetchPendingContactInvites();
        const fresh = contacts.filter(
          c => !ctx.handledContactKeys.includes(`${c.sender}|${c.uid}`)
        );
        if (fresh.length) {
          if (!ctx.showContactPopup) {
            ctx.pendingContacts = fresh;
            // Групповой попап имеет приоритет; контактный покажем следом.
            if (!ctx.showInvitePopup) {
              ctx.contactPopupIndex = 0;
              ctx.showContactPopup = true;
            }
          }
        } else if (!ctx.showContactPopup) {
          ctx.pendingContacts = [];
        }
      } catch (e) {
        console.error('processInvites: contact invites failed:', e);
      }
      try {
        ctx.loadProfiles();
      } catch (e) {
        console.error('processInvites: loadProfiles failed:', e);
      }
}

// ── ADR-001 Этап 3 (invites): acceptInvite/declineInvite/showNextInvite вынесены из App.vue.
// ctx-паттерн: this.* -> ctx.*; GroupsFeature — лениво (разрывает цикл);
// deps: decryptGroupKey/kvSet/showToast/t/loadGroupMessages — инъекция из App.vue (ADR-001 pattern; smoke не мокает crypto/uiStore/db/groups).
export async function acceptInvite(ctx, inv, deps) {
  const { decryptGroupKey, kvSet, showToast, t, loadGroupMessages, markInviteHandled, unmarkInviteHandled, isCryptoReady, groups, showNextInvite } = deps;
  const key = `${inv.group_id}|${inv.uid}`;
  markInviteHandled(key);
  ctx.pendingInvites.splice(ctx.invitePopupIndex, 1);
  ctx.showInvitePopup = false;
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
      groups().setGroupAvatar(inv.group_id, inv.group_avatar);
    }
    await ctx.loadGroups();
    try { await ctx.loadChannels(); } catch (e) { /* не критично */ }
    if (ctx.currentGroup?.id === inv.group_id) {
      await loadGroupMessages(inv.group_id);
    }
  } catch (e) {
    alert('Failed to accept invite: ' + e.message);
    unmarkInviteHandled(key);
    ctx.pendingInvites.push(inv);
  }
  showNextInvite();
}

export async function declineInvite(ctx, inv, deps) {
  const { markInviteHandled, showNextInvite } = deps;
  const key = `${inv.group_id}|${inv.uid}`;
  markInviteHandled(key);
  ctx.pendingInvites.splice(ctx.invitePopupIndex, 1);
  ctx.showInvitePopup = false;
  try {
    await api.declineGroupInvite(inv.group_id, inv.uid, inv.sender);
  } catch (e) {
    // ignore
  }
  showNextInvite();
}

export function showNextInvite(ctx, deps) {
  const { clearNextTimer, setNextTimer } = deps;
  clearNextTimer();
  if (ctx.pendingInvites.length > 0) {
    if (ctx.invitePopupIndex >= ctx.pendingInvites.length) ctx.invitePopupIndex = 0;
    setNextTimer(() => {
      if (ctx.pendingInvites.length && !ctx.showInvitePopup) {
        ctx.showInvitePopup = true;
      }
    }, 1200);
  } else {
    ctx.showInvitePopup = false;
    if (ctx.pendingContacts.length) {
      setNextTimer(() => {
        if (ctx.pendingContacts.length && !ctx.showContactPopup) {
          ctx.showContactPopup = true;
        }
      }, 1200);
    }
  }
}
