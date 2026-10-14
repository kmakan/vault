// Feature module: отправка квитанций о доставке (delivered receipts).
// Этап 5 декомпозиции App.vue (ctx-паттерн). Вынесено из App.vue механически
// (this.* -> ctx.*, поведение 1:1). Сканирует fetched-письма от известных
// пиров, расшифровывает, собирает acks (sender -> [msg_id]) и отправляет
// квитанции через api.sendReadReceipt. Дедуп в sqlite kv (delivered-sent),
// cap 500 самых свежих записей.

import api, { db } from '../api.js';
import crypto from '../crypto.js';

export async function sendDeliveredReceipts(ctx, fetched) {
      if (!ctx.isLoggedIn || !ctx.cryptoReady || !fetched || !fetched.length) return;
      const myEmail = (ctx.email || '').toLowerCase();
      if (!myEmail) return;
      // Дедуп в sqlite kv_store (НЕ localStorage — он может переполниться;
      const acc = ctx.email || 'anon';
      let sentMap = {};
      try {
        const raw = await db.kvGet(acc, 'delivered-sent');
        if (raw) sentMap = JSON.parse(raw);
      } catch (e) { sentMap = {}; }
      // Кандидаты: входящие от известных пиров (есть ключ — можно расшифровать).
      const candidates = fetched.filter(m => {
        const sender = ctx.senderEmail(m.from);
        if (!sender || sender.includes(myEmail)) return false;
        return !!ctx.peerKeys[sender];
      });
      if (!candidates.length) return;
      const byFolder = {};
      for (const m of candidates.slice(0, 30)) {
        const f = m.folder || 'INBOX';
        (byFolder[f] = byFolder[f] || []).push(m);
      }
      const acks = {}; // sender -> [msg_id]
      for (const [folder, msgs] of Object.entries(byFolder)) {
        const missing = msgs.filter(m => ctx.emailBodyCache[`${folder}:${m.uid || m.id}`] === undefined);
        if (missing.length) {
          try {
            const bodies = await api.fetchBodiesDbFirst(folder, missing.map(m => m.uid || m.id));
            for (const m of missing) {
              const b = bodies ? bodies[String(m.uid || m.id)] : undefined;
              if (b) ctx.cacheBody(`${folder}:${m.uid || m.id}`, b);
            }
          } catch (e) { continue; }
        }
        for (const m of msgs) {
          const body = ctx.emailBodyCache[`${folder}:${m.uid || m.id}`] || '';
          if (!body || !crypto.isEncrypted(body)) continue;
          const sender = ctx.senderEmail(m.from);
          try {
            crypto.setPeerPublicKey(ctx.peerKeys[sender], ctx.peerPqKeys && ctx.peerPqKeys[sender]);
            const text = await crypto.decryptVault(body);
            const env = ctx.parseEnvelope(text);
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
          crypto.setPeerPublicKey(ctx.peerKeys[sender], ctx.peerPqKeys && ctx.peerPqKeys[sender]);
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
