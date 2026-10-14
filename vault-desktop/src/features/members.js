// Feature module: приглашение выбранных участников в группу.
// Этап 5 декомпозиции App.vue (ctx-паттерн). Вынесено механически
// (this.* -> ctx.*, поведение 1:1). Собирает group_key (ECDH с публичным
// ключом участника или из уже расшифрованного), шифрует приглашение
// (AAD="VAULT") и отправляет api.addGroupMember. loadGroups/loadChannels
// остаются в App.vue и вызываются через ctx.

import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';

export async function inviteSelectedMembers(ctx) {
      // Попап закрываем СРАЗУ — отправка идёт в фоне, итог сообщаем alert'ом.
      // отправлено приглашение или нет.
      const emails = [...ctx.addMemberSelected];
      if (!ctx.currentGroup || !emails.length) return;
      ctx.showAddMemberPopup = false;
      ctx.addMemberSelected = [];
      ctx.addMemberQuery = '';
      const sent = [];
      const failed = [];
      const skipped = [];
      for (const email of emails) {
        try {
          // Уже участник ПОД ЭТИМ адресом — явный skip (не тихий continue:
          // «штатный» попап без отправки маскировал недоставленные инвайты).
          if ((ctx.currentGroup.members || []).some(m => m.email === email)) {
            skipped.push(email + ' — ' + (ctx.t('already_in_group') || 'уже в группе'));
            continue;
          }
          // Участник ПОД ДРУГИМ адресом с тем же fingerprint (смена почты):
          // мигрируем адрес в составе группы и шлём инвайт на новый адрес —
          // а повторный инвайт тихо скипался.
          const stale = (ctx.currentGroup.members || []).find(
            m => m.email !== email && ctx.emailSharesFingerprint(m.email, email));
          if (stale) {
            await invoke('groups_rename_member', {
              groupId: ctx.currentGroup.id, oldEmail: stale.email, newEmail: email,
            });
            stale.email = email;
            stale.key_shared = true;
          }
          // Ключ группы шифруем на публичном ключе ПОЛУЧАТЕЛЯ (ECDH X25519).
          // в группу добавляют только установленные контакты.
          const peerPub = ctx.peerKeys[email] || null;
          if (!peerPub) {
            failed.push(email + ' — ' + (ctx.t('add_member_no_key') || 'нет ключа: сначала добавьте контакт'));
            continue;
          }
          const groupKeys = await api.getGroupKeys(ctx.currentGroup.id);
          if (!groupKeys.length) throw new Error('No group key');
          const enc = await crypto.encryptGroupKeyForUser(groupKeys[0], peerPub);
          await api.inviteGroupMember(ctx.currentGroup.id, email, enc, ctx.publicKey);
          // Помечаем локально как «приглашён» в списке участников (появится после accept).
          const members = ctx.currentGroup.members || [];
          if (!members.some(m => m.email === email)) {
            members.push({ email, role: 'Member', invited: true });
          }
          sent.push(email);
        } catch (e) {
          failed.push(email + ' — ' + ((e && e.message) || e));
        }
      }
      // Состав группы перечитываем с диска: groups_rename_member правил
      // groups.json в Rust-стороне, локальный members мог разойтись.
      try { await ctx.loadGroups();
          try { await ctx.loadChannels(); } catch (e) { /* не критично */ } } catch (e) { /* не критично */ }
      const parts = [];
      if (sent.length) parts.push((ctx.t('invite_sent') || 'Приглашение отправлено') + ': ' + sent.join(', '));
      if (skipped.length) parts.push((ctx.t('invite_skipped') || 'Пропущены') + ':\n' + skipped.join('\n'));
      if (failed.length) parts.push((ctx.t('add_member_failed') || 'Не удалось отправить') + ':\n' + failed.join('\n'));
      alert(parts.join('\n\n') || (ctx.t('add_member_nothing') || 'Приглашения не отправлены'));
}
