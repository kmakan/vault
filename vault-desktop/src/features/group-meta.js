// Feature module: сканирование meta-писем групп (аватар/имя из VaultGroupMeta).
// Этап 5 декомпозиции App.vue (ctx-паттерн). Вынесено из App.vue механически
// (this.* -> ctx.*, поведение 1:1). Ищет meta-письма среди последних писем
// участников группы (до 10), применяет аватар (kv group-avatar:<gid>) и
// имя (invoke groups_rename). healGroupAvatarFromMessage/replyGroupAvatarHeal
// остаются в App.vue и вызываются через ctx.

import { invoke } from '@tauri-apps/api/core';
import api, { db } from '../api.js';
import crypto from '../crypto.js';

export async function syncGroupAvatarsFromMeta(ctx) {
      if (!ctx.isLoggedIn || !ctx.groups || !ctx.groups.length) return;
      const emails = ctx.emails || [];
      for (const g of ctx.groups) {
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
          let groupKey = ctx.groupKeys[g.id];
          if (!groupKey && ctx.cryptoReady) {
            try {
              const kd = await api.getMyGroupKey(g.id);
              if (kd && kd.group_key) {
                ctx.groupKeys[g.id] = kd.group_key;
                groupKey = kd.group_key;
              }
            } catch (e) { /* ключ не загрузился — группу пропускаем */ }
          }
          if (!groupKey) { console.log('[group] meta-scan no-key:', g.id); break; }
          try {
            const body = await api.fetchEmailBody('local', latest.uid, latest.folder);
            if (!body || !crypto.isEncrypted(body)) continue;
            const plaintext = await crypto.decryptWithGroupKey(body, groupKey);
            const obj = JSON.parse(plaintext);
            // hav-запрос аватарки {hav:1}: сервис-письмо, достижимо здесь
            // (мета-скан смотрит последние письма участников). Отвечаем и
            // ищем дальше — hav не является meta, применять нечего.
            if (obj && obj.hav === 1) {
              // Ответ ТОЛЬКО если ещё не отвечали на это письмо; помечаем
              // applied-sig УСПЕШНОЙ ответ (replyHeal → true) — при ошибке
              // uid остаётся в обходе и поллинг повторит.
              const answered = await ctx.replyGroupAvatarHeal(g.id);
              if (answered && !alreadyApplied.has(appliedSig)) {
                alreadyApplied.add(appliedSig);
                await db.kvSet('anon', appliedKey, [...alreadyApplied].join(','));
              }
              continue;
            }
            // gavatar-heal: конверт сообщения нёс gavatar — лечим kv (guard
            // на непустое/изменение внутри healGroupAvatarFromMessage).
            if (obj && obj.gavatar) await ctx.healGroupAvatarFromMessage(g.id, obj.gavatar);
            if (obj && obj.meta === 1 && (obj.avatar || obj.name)) {
              // Аватар группы — отдельный kv.
              if (obj.avatar && (await db.kvGet('anon', 'group-avatar:' + g.id)) !== obj.avatar) {
                await db.kvSet('anon', 'group-avatar:' + g.id, obj.avatar);
                ctx.groupAvatars[g.id] = obj.avatar;
              }
              // Имя группы: применяем если пришло.
              if (obj.name && g.name !== obj.name) {
                try {
                  await invoke('groups_rename', { groupId: g.id, newName: obj.name });
                  g.name = obj.name;
                  console.log('[group] name applied:', g.id, '→', obj.name);
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
