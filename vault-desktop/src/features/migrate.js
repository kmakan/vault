// Feature module: миграция localStorage при смене email (identity migration).
// Этап 5 декомпозиции App.vue (ctx-паттерн). Вынесено из App.vue механически
// (this.* -> ctx.*, поведение 1:1). Переносит заметки/квитанции/реакции/правки/
// томбстоуны со старого email-ключа на новый, с дедупликацией (arrays — по id,
// объекты — merge, цель побеждает). Пост-миграционный аудит (warn-only).
// this.migrateOwnProfile остаётся в App.vue и вызывается через ctx.

export async function migrateLocalStores(ctx, oldEmail, newEmail) {
      if (!oldEmail || !newEmail || oldEmail === newEmail) return;
      // isArray: хранилище — JSON-массив (заметки), иначе JSON-объект.
      // Аудит 09.10: других АКТИВНЫХ email-ключевых localStorage нет —
      // imapCursorsKey/bodyCacheKey/chatCacheKey = мёртвый легаси (sqlite),
      // notify/close-to-tray = фиксированные ключи, vault-email пишет login,
      // vault-avatar-*/vault-hist:* вычищаются при инициализации в kv.
      const prefixes = [
        { key: 'vault-notes-', isArray: true },        // заметки для себя (id)
        { key: 'vault-reads-sent-' },   // квитанции чтения (объект)
        { key: 'vault-reactions-' },    // реакции (features/reactions.js)
        { key: 'vault-edits-' },        // правки (features/edits.js)
        { key: 'vault-tombstones-' },   // томбстоуны (features/edits.js)
        { key: 'vault-mid-tombstones-' }, // tombstones по mid (features/edits.js)
      ];
      for (const { key: p, isArray } of prefixes) {
        try {
          const dstKey = p + newEmail;
          let srcKey = p + oldEmail;
          let srcVal = localStorage.getItem(srcKey);
          if (!srcVal) {
            // Ключ мог быть записан в другом регистре (raw this.email).
            const alt = p + String(oldEmail).toLowerCase();
            if (alt !== srcKey) {
              srcVal = localStorage.getItem(alt);
              if (srcVal) srcKey = alt;
            }
          }
          if (!srcVal) continue;            // источника нет — это норма
          if (srcKey === dstKey) continue;  // ключ совпал — переносить нечего
          const rawDst = localStorage.getItem(dstKey);
          if (rawDst === null || rawDst === undefined) {
            // Цели нет — просто копируем.
            localStorage.setItem(dstKey, srcVal);
            localStorage.removeItem(srcKey);
            continue;
          }
          let src;
          try {
            src = JSON.parse(srcVal);
          } catch (eb) {
            // Битый JSON источника — удаляем источник, цель не трогаем.
            localStorage.removeItem(srcKey);
            continue;
          }
          if (isArray) {
            // Массивы: [...source, ...target] с дедупликацией по полю id,
            // приоритет элемента ЦЕЛИ (позиция — первое вхождение).
            if (!Array.isArray(src)) { localStorage.removeItem(srcKey); continue; }
            let dst;
            try {
              dst = JSON.parse(rawDst);
            } catch (eb) {
              // Битая цель — источник валиден, записываем его.
              localStorage.setItem(dstKey, srcVal);
              localStorage.removeItem(srcKey);
              continue;
            }
            if (!Array.isArray(dst)) {
              localStorage.setItem(dstKey, srcVal);
              localStorage.removeItem(srcKey);
              continue;
            }
            const merged = [];
            const byId = new Map();
            const put = (item) => {
              if (item && typeof item === 'object' && item.id != null) {
                if (byId.has(item.id)) merged[byId.get(item.id)] = item; // цель побеждает
                else { byId.set(item.id, merged.length); merged.push(item); }
              } else {
                merged.push(item); // без id — не дедуплицируем
              }
            };
            src.forEach(put);
            dst.forEach(put);
            localStorage.setItem(dstKey, JSON.stringify(merged));
            localStorage.removeItem(srcKey);
            continue;
          }
          // Остальные хранилища — объекты: merge, цель побеждает.
          let dst = null;
          try {
            dst = JSON.parse(rawDst);
          } catch (eb) {
            dst = null; // битая цель — остаётся источник
          }
          localStorage.setItem(dstKey, JSON.stringify(Object.assign({}, src || {}, dst || {})));
          localStorage.removeItem(srcKey);
        } catch (e) {
          console.warn('[identity] local store migrate failed:', p, e);
        }
      }
      // Пост-миграционный аудит: ничего не должно остаться под старым
      // адресом. Только warn — смена почты НЕ роняется из-за аудита.
      try {
        const olds = [String(oldEmail), String(oldEmail).toLowerCase()];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (olds.some(o => o && k.includes(o))) console.warn('[identity] LEFT BEHIND: ' + k);
        }
      } catch (e) { /* аудит не должен ломать миграцию */ }
      await ctx.migrateOwnProfile(oldEmail, newEmail);
}
