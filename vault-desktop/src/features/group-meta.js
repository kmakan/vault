// Feature module: сканирование meta-писем групп (аватар/имя из VaultGroupMeta).
// ADR-001 домен 2. Ищет meta-письма среди последних писем участников группы
// (до 10), применяет аватар (kv group-avatar:<gid>) и имя (invoke
// groups_rename).
//
// ADR-005 W2 (`t_bcb8927a`), партия 14: модуль больше НЕ читает компонент.
// «Залогинен» — владелец session-store, письма — mailbox-store, ключи и
// аватары групп — владелец groups-store (per-app экземпляр, приходит в
// deps); список групп и два эффекта (heal/reply) — тоже deps.

import * as WireSignalRule from '../wire-signal-rule.js';
import { invoke } from '@tauri-apps/api/core';
import api, { db } from '../api.js';
import crypto from '../crypto.js';
import { sessionStore } from './session-store.js';
import { mailboxState } from './mailbox-store.js';

export async function syncGroupAvatarsFromMeta(deps) {
      if (!sessionStore.state.isLoggedIn || !deps.groups || !deps.groups.length) return;
      const emails = mailboxState.state.emails || [];
      for (const g of deps.groups) {
        if (!g || !g.id) continue;
        // STEALTH: тема пустая, поэтому meta-письмо ищем по
        // отправителю — участнику группы (как getGroupMessages).
        const members = (g.members || [])
          .map(m => String(m.email || '').toLowerCase())
          .filter(Boolean);
        // Ищем meta-письмо среди ПОСЛЕДНИХ писем участников (не только
        // самое последнее): после загрузки аватара могло прийти обычное
        // сообщение, и `latest` перестал быть meta-письмом — участники
        // навсегда оставались без аватара. Проверяем до 10 последних.
        const memberMails = emails
          .filter(m => {
            const from = String(m.from || '').toLowerCase();
            return members.some(e => from.includes(e));
          })
          .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
          .slice(0, 10);
        const appliedKey = 'group-meta-applied:' + g.id;
        const alreadyApplied = new Set(
          ((await db.kvGet('anon', appliedKey)) || '').split(',').filter(Boolean)
        );
        let metaFound = false;
        for (const latest of memberMails) {
          const appliedSig = String(latest.uid) + '@' + (latest.folder || 'INBOX');
          if (alreadyApplied.has(appliedSig)) continue;
          let groupKey = deps.groupStore.state.groupKeys[g.id];
          if (!groupKey && deps.cryptoReady()) {
            try {
              const kd = await api.getMyGroupKey(g.id);
              if (kd && kd.group_key) {
                deps.groupStore.setGroupKey(g.id, kd.group_key);
                groupKey = kd.group_key;
              }
            } catch (e) { /* ключ не загрузился — группу пропускаем */ }
          }
          if (!groupKey) { console.log('[group] meta-scan no-key:', g.id); break; }
          try {
            const body = await api.fetchEmailBody('local', latest.uid, latest.folder);
            // Пустое тело — решение Rust «этого тела не будет никогда»
            // (RELAY-конверт, не-IMAP uid, письмо ушло из папки). Тело письма
            // неизменно, поэтому такое письмо заносим в applied-sig: без этого
            // мета-скан повторяет ОДИН И ТОТ ЖЕ запрос каждым поллингом (жалоба
            // 22.10 «приглашения от старых email», замер на стенде: 368 строк
            // лога за 2,5 минуты). Обычное (не шифрованное) письмо — та же
            // логика: оно никогда не станет meta-письмом.
            if (!body || !crypto.isEncrypted(body)) {
              alreadyApplied.add(appliedSig);
              await db.kvSet('anon', appliedKey, [...alreadyApplied].join(','));
              continue;
            }
            const plaintext = await crypto.decryptWithGroupKey(body, groupKey);
            // РОУТЕР СЕРВИСНЫХ СИГНАЛОВ — В RUST (ADR-005 R1 / W4): hav-запрос и
            // мета — служебные форматы, «что это за письмо» решает ядро
            // (vault::signals::parse_signal).
            const sig = await WireSignalRule.parseSignal(plaintext);
            // hav-запрос аватарки {hav:1}: сервис-письмо, достижимо здесь
            // (мета-скан смотрит последние письма участников). Отвечаем и
            // ищем дальше — hav не является meta, применять нечего.
            if (sig && sig.kind === 'group_avatar_heal') {
              // Ответ ТОЛЬКО если ещё не отвечали на это письмо; помечаем
              // applied-sig УСПЕШНОЙ ответ (replyHeal → true) — при ошибке
              // uid остаётся в обходе и поллинг повторит.
              const answered = await deps.replyGroupAvatarHeal(g.id);
              if (answered && !alreadyApplied.has(appliedSig)) {
                alreadyApplied.add(appliedSig);
                await db.kvSet('anon', appliedKey, [...alreadyApplied].join(','));
              }
              continue;
            }
            // gavatar-heal: конверт сообщения нёс gavatar — лечим kv (guard
            // на непустое/изменение внутри healGroupAvatarFromMessage).
            // Сырой объект письма разбирает Rust (ADR-005 W4).
            const obj = await WireSignalRule.envelopeObject(plaintext);
            if (obj && obj.gavatar) await deps.healGroupAvatarFromMessage(g.id, obj.gavatar);
            if (sig && sig.kind === 'group_meta' && (sig.avatar || sig.name)) {
              // Аватар группы — отдельный kv.
              if (sig.avatar && (await db.kvGet('anon', 'group-avatar:' + g.id)) !== sig.avatar) {
                await db.kvSet('anon', 'group-avatar:' + g.id, sig.avatar);
                deps.groupStore.setGroupAvatar(g.id, sig.avatar);
              }
              // Имя группы: применяем если пришло.
              if (sig.name && g.name !== sig.name) {
                try {
                  await invoke('groups_rename', { groupId: g.id, newName: sig.name });
                  g.name = sig.name;
                  console.log('[group] name applied:', g.id, '→', sig.name);
                } catch (e) { /* локально не обновилось — не критично */ }
              }
              metaFound = true;
              alreadyApplied.add(appliedSig);
              await db.kvSet('anon', appliedKey, [...alreadyApplied].join(','));
              break; // meta найден — хватит
            }
          } catch (e) { /* не meta или битое — не критично */ }
        }
      }
}
