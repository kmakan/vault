// Очередь отложенных приглашений в группу — ADR-005.
//
// Приглашение в группу требует ECDH-шифрование ключа группы на публичном
// ключе получателя. Когда ключа ещё нет, `features/members.js` отправляет
// запрос контакта и просит ядро отложить приглашение (`invited` в
// groups.json, носитель состояния — мост, не фронт). Это — ИСПОЛНИТЕЛЬ:
// по сигналу «получили ключ» перечитывает очередь у моста, упаковывает
// ключ и доотправляет приглашение; решение «кого ждать» здесь не принимается.
//
// Вызывается из цикла поллинга (письмо-рукопожатие приходит только там) —
// ключ, сохранённый любым путём (accept-письмо, QR, ручная вставка),
// уходит с первым же следующим тиком.

import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';

// Одна одновременная проходка: тики поллинга могут наложиться, а два прохода
// прислали бы ключ группе дважды.
let running = null;

export function flushPendingGroupInvites(deps) {
  if (running) return running;
  running = run(deps).finally(() => { running = null; });
  return running;
}

async function run(deps) {
  const out = { sent: [], failed: [] };
  let items;
  try {
    items = await invoke('groups_pending_invites');
  } catch (e) {
    return out;
  }
  if (!items || !items.length) return out;
  let peers = [];
  try {
    peers = await invoke('load_peer_keys');
  } catch (e) {
    return out;
  }
  const keyOf = new Map(
    (peers || []).map(p => [String(p.email || '').trim().toLowerCase(), p.public_key]),
  );
  for (const it of items) {
    const peerPub = keyOf.get(String(it.email || '').trim().toLowerCase());
    if (!peerPub) continue; // всё ещё ждём ключ — остаётся в очереди
    try {
      const groupKeys = await api.getGroupKeys(it.group_id);
      if (!groupKeys.length) throw new Error('No group key');
      const enc = await crypto.encryptGroupKeyForUser(groupKeys[0], peerPub);
      await api.inviteGroupMember(it.group_id, it.email, enc, deps.publicKey());
      await invoke('groups_invite_sent', { groupId: it.group_id, email: it.email });
      out.sent.push(it.email);
    } catch (e) {
      out.failed.push(it.email + ' — ' + ((e && e.message) || e));
    }
  }
  if (out.sent.length) console.log('[group-invite-queue] ключ группы отправлен:', out.sent.join(', '));
  if (out.failed.length) console.error('[group-invite-queue] не удалось:', out.failed.join('; '));
  return out;
}
