// Feature module: отправка квитанций о доставке (delivered receipts).
// ADR-001 домен 2. Сканирует fetched-письма от известных пиров, расшифровывает,
// собирает acks (sender -> [msg_id]) и отправляет квитанции через
// api.sendReadReceipt. Дедуп в sqlite kv (delivered-sent), cap 500 самых свежих
// записей.
//
// ADR-005 W2 (`t_bcb8927a`), партия 11: модуль больше НЕ читает компонент.
// Ключи пиров — владелец identity-store; кэш тел — владелец mailbox-store;
// email и «залогинен» — владелец session-store; разбор конверта и адреса
// отправителя — чистые функции message-format.js. В deps остаётся одно:
// `cryptoReady` (признак компонента, а не состояние фичи).

import api, { db } from '../api.js';
import crypto from '../crypto.js';
import * as MsgFormat from '../message-format.js';
import { identityStore } from './identity-store.js';
import { mailboxState } from './mailbox-store.js';
import { sessionStore } from './session-store.js';

export async function sendDeliveredReceipts(deps, fetched) {
      if (!sessionStore.state.isLoggedIn || !deps.cryptoReady() || !fetched || !fetched.length) return;
      const myEmail = (sessionStore.getCurrentEmail() || '').toLowerCase();
      if (!myEmail) return;
      // Дедуп в sqlite kv_store (НЕ localStorage — он может переполниться;
      const acc = sessionStore.getCurrentEmail() || 'anon';
      let sentMap = {};
      try {
        const raw = await db.kvGet(acc, 'delivered-sent');
        if (raw) sentMap = JSON.parse(raw);
      } catch (e) { sentMap = {}; }
      // Кандидаты: входящие от известных пиров (есть ключ — можно расшифровать).
      const candidates = fetched.filter(m => {
        const sender = MsgFormat.senderEmail(m.from);
        if (!sender || sender.includes(myEmail)) return false;
        return !!identityStore.state.peerKeys[sender];
      });
      if (!candidates.length) return;
      const byFolder = {};
      for (const m of candidates.slice(0, 30)) {
        const f = m.folder || 'INBOX';
        (byFolder[f] = byFolder[f] || []).push(m);
      }
      const acks = {}; // sender -> [msg_id]
      for (const [folder, msgs] of Object.entries(byFolder)) {
        const missing = msgs.filter(m => mailboxState.state.emailBodyCache[`${folder}:${m.uid || m.id}`] === undefined);
        if (missing.length) {
          try {
            const bodies = await api.fetchBodiesDbFirst(folder, missing.map(m => m.uid || m.id));
            for (const m of missing) {
              const b = bodies ? bodies[String(m.uid || m.id)] : undefined;
              if (b) mailboxState.cacheBody(`${folder}:${m.uid || m.id}`, b);
            }
          } catch (e) { continue; }
        }
        for (const m of msgs) {
          const body = mailboxState.state.emailBodyCache[`${folder}:${m.uid || m.id}`] || '';
          if (!body || !crypto.isEncrypted(body)) continue;
          const sender = MsgFormat.senderEmail(m.from);
          try {
            crypto.setPeerPublicKey(identityStore.state.peerKeys[sender], identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[sender]);
            const text = await crypto.decryptVault(body);
            const env = MsgFormat.parseEnvelope(text);
            // Только настоящие сообщения (envelope с id): квитанции/правки/
            // реакции/legacy — не сообщения, на них квитанция не положена.
            if (!env || !env.id) continue;
            if (sentMap[env.id]) continue;
            (acks[sender] = acks[sender] || []).push(env.id);
            sentMap[env.id] = Date.now();
          } catch (e) { /* не vault-письмо или чужой ключ — пропускаем */ }
        }
      }
      if (!Object.keys(acks).length) return;
      for (const [sender, ids] of Object.entries(acks)) {
        try {
          crypto.setPeerPublicKey(identityStore.state.peerKeys[sender], identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[sender]);
          const content = await crypto.encryptVault(JSON.stringify({ delivered: 1, msg_ids: ids }));
          await api.sendReadReceipt(sender, content);
        } catch (e) {
          console.error('sendDeliveredReceipts failed for ' + sender + ':', e);
          // SMTP упал — снимаем метки, чтобы квитанция повторилась позже.
          for (const id of ids) delete sentMap[id];
        }
      }
      // Разрастание карты: держим не более 500 самых свежих записей.
      const entries = Object.entries(sentMap);
      if (entries.length > 500) {
        entries.sort((a, b) => (b[1] || 0) - (a[1] || 0));
        sentMap = Object.fromEntries(entries.slice(0, 500));
      }
      db.kvSet(acc, 'delivered-sent', JSON.stringify(sentMap)).catch(() => {});
}
