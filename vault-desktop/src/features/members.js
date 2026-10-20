// Feature module: приглашение выбранных участников в группу.
// ADR-001 домен 2. Собирает group_key (ECDH с публичным ключом участника или
// из уже расшифрованного), шифрует приглашение (AAD="VAULT") и отправляет
// api.addGroupMember.
//
// ADR-005 W2 (`t_bcb8927a`), партия 12: модуль больше НЕ читает компонент.
// Текущая группа — владелец chatStore (J.3a); форма «добавить участника»
// (выбранные, запрос, попап) — владелец форм/модалок uiStore; ключи пиров —
// владелец identity-store. В deps остаются эффекты и признаки компонента:
// публичный ключ, перечитывание групп/каналов, сверка отпечатков.

import { uiStore, chatStore } from "./session-store.js";
import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';
import { identityStore } from './identity-store.js';

export async function inviteSelectedMembers(deps) {
      // Попап закрываем СРАЗУ — отправка идёт в фоне, итог сообщаем alert'ом.
      // отправлено приглашение или нет.
      const emails = [...(uiStore.getFormField('addMemberSelected') || [])];
      const group = chatStore.state.currentGroup;
      if (!group || !emails.length) return;
      uiStore.setModal('showAddMemberPopup', false);
      uiStore.setFormField('addMemberSelected', []);
      uiStore.setFormField('addMemberQuery', '');
      const sent = [];
      const failed = [];
      const skipped = [];
      for (const email of emails) {
        try {
          // Уже участник ПОД ЭТИМ адресом — явный skip (не тихий continue:
          // «штатный» попап без отправки маскировал недоставленные инвайты).
          if ((group.members || []).some(m => m.email === email)) {
            skipped.push(email + ' — ' + (uiStore.tr('already_in_group') || 'уже в группе'));
            continue;
          }
          // Участник ПОД ДРУГИМ адресом с тем же fingerprint (смена почты):
          // мигрируем адрес в составе группы и шлём инвайт на новый адрес —
          // а повторный инвайт тихо скипался.
          const stale = (group.members || []).find(
            m => m.email !== email && deps.emailSharesFingerprint(m.email, email));
          if (stale) {
            await invoke('groups_rename_member', {
              groupId: group.id, oldEmail: stale.email, newEmail: email,
            });
            stale.email = email;
            stale.key_shared = true;
          }
          // Ключ группы шифруем на публичном ключе ПОЛУЧАТЕЛЯ (ECDH X25519).
          // в группу добавляют только установленные контакты.
          const peerPub = identityStore.state.peerKeys[email] || null;
          if (!peerPub) {
            failed.push(email + ' — ' + (uiStore.tr('add_member_no_key') || 'нет ключа: сначала добавьте контакт'));
            continue;
          }
          const groupKeys = await api.getGroupKeys(group.id);
          if (!groupKeys.length) throw new Error('No group key');
          const enc = await crypto.encryptGroupKeyForUser(groupKeys[0], peerPub);
          await api.inviteGroupMember(group.id, email, enc, deps.publicKey());
          // Помечаем локально как «приглашён» в списке участников (появится после accept).
          const members = group.members || [];
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
      try { await deps.loadGroups();
          try { await deps.loadChannels(); } catch (e) { /* не критично */ } } catch (e) { /* не критично */ }
      const parts = [];
      if (sent.length) parts.push((uiStore.tr('invite_sent') || 'Приглашение отправлено') + ': ' + sent.join(', '));
      if (skipped.length) parts.push((uiStore.tr('invite_skipped') || 'Пропущены') + ':\n' + skipped.join('\n'));
      if (failed.length) parts.push((uiStore.tr('add_member_failed') || 'Не удалось отправить') + ':\n' + failed.join('\n'));
      alert(parts.join('\n\n') || (uiStore.tr('add_member_nothing') || 'Приглашения не отправлены'));
}
