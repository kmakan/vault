// Перенос данных при смене почты. Раньше — два метода App.vue, которые шли
// вразнобой с ensureAccountNamespace из identity.js.
//
// ADR-003 Этап 3, партия 2. Слой ВЫШЕ транспорта и identity: обе функции
// используют и api, и identity, поэтому лежать должны выше обоих. Положим их
// в identity.js — получится цикл (identity → api → identity), который вчера
// разбирали именно ради этого.
//
// ЗАМЕЧАНИЕ, КОТОРОЕ НЕ ЗАКАЧЕНО. db_account_migrate вызывается из ДВУХ мест:
// здесь и в ensureAccountNamespace. Они не дублируют друг друга: здесь
// fromAccount приходит явным аргументом (перенос при смене почты), там берётся
// текущий адрес и есть защита _nsMigrated. Слияние меняет семантику вызова, а
// это уже рефакторинг поведения, а не его перенос. Помечено в ADR-003 §5.

import { invoke } from '@tauri-apps/api/core';
import api, { db } from './api.js';
import { accountNamespace } from './identity.js';

export async function migrateAccountData(oldEmail, newEmail) {
  try {
    if (!oldEmail || !newEmail) return;
    // ns = fp:<fingerprint> (ключ стабилен при смене почты) либо legacy-емейл.
    const ns = await accountNamespace(newEmail);
    if (!ns || ns === oldEmail) {
      console.log('[identity] namespace unchanged, nothing to migrate');
      return;
    }
    const report = await invoke('db_account_migrate', { fromAccount: oldEmail, toAccount: ns });
    const moved = report && typeof report.total === 'number' ? report.total : 0;
    console.log(`[identity] account data migrated: ${oldEmail} → ${ns} (moved ${moved})`);
  } catch (e) {
    console.warn('[identity] migrateAccountData failed:', e);
  }
}

export async function migrateOwnGroups(oldEmail, newEmail) {
  if (!oldEmail || !newEmail || oldEmail === newEmail) return;
  try {
    const all = await api.getGroups();
    const old = String(oldEmail).toLowerCase();
    for (const g of all || []) {
      const mine = String(g.created_by || '').toLowerCase() === old
        || (g.members || []).some(m => String(m.email || '').toLowerCase() === old);
      if (!mine) continue;
      await invoke('groups_rename_member', {
        groupId: g.id, oldEmail, newEmail,
      });
    }
    console.log('[identity] own groups renamed:', oldEmail, '→', newEmail);
  } catch (e) {
    console.warn('[identity] migrateOwnGroups failed:', e);
  }
}

// ── Переносы при смене почты (ADR-003 Этап 3, партия 9) ───────────────
// Все три переехали сюда по одной причине: это миграции идентичности, и лежать
// им надолго в компоненте не место. Побочный эффект переноса — ВИДИМОЕ
// дублирование: migratePeerGroups и migrateOwnGroups (выше) делают одно и то
// же — перебор групп и groups_rename_member для всех, где мы создатель или
// участник. Разница только в возврате (счётчик против ничего) и перезагрузке
// списка. НЕ СЛИТО: слияние меняет семантику вызова (migrateOwnGroups не
// перечитывает список), а это не перемещение. Решение вынесено в ADR-003 §5.

// Ключ ЧАТА С СОБЕСЕДНИКОМ (chat-cache:<email пира>) переименовывается, когда
// сменил почту ПИР, а не мы. Поэтому account идёт через резолвер (identity =
// fp:<fingerprint>), а пир остаётся почтой: она транспорт, и в ключе чата.
export async function migrateChatHistory(oldEmail, newEmail, myEmail) {
  try {
    const ns = myEmail ? await accountNamespace(myEmail) : 'anon';
    const oldKey = 'chat-cache:' + oldEmail;
    const newKey = 'chat-cache:' + newEmail;
    const oldCache = await db.kvGet(ns, oldKey);
    if (!oldCache) return false;
    const existing = await db.kvGet(ns, newKey);
    if (existing) return false;   // цель уже занята — чужую историю не трогаем
    await db.kvSet(ns, newKey, oldCache);
    await db.kvDelete(ns, oldKey);
    console.log('[identity] chat history migrated:', oldEmail, '→', newEmail);
    return true;
  } catch (e) {
    console.warn('[identity] migrateChatHistory failed:', e);
    return false;
  }
}

// Профиль переносится ТОЛЬКО из пустых полей в существующий целевой: пустой
// avatar не должен затирать уже загруженный. Возвращает ключ и профиль, чтобы
// компонент обновил шапку — иначе логика и отображение снова слиплись бы.
export async function migrateOwnProfile(oldEmail, newEmail) {
  try {
    const profiles = JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
    const old = String(oldEmail).toLowerCase();
    const neu = String(newEmail).toLowerCase();
    if (!profiles[old] || old === neu) return null;
    if (!profiles[neu]) {
      profiles[neu] = Object.assign({}, profiles[old]); // копия целиком
    } else {
      // Цель есть — заполняем только пустые/отсутствующие поля из
      // старого (пустой avatar не затирает новый).
      const dst = profiles[neu];
      const src = profiles[old];
      for (const k of Object.keys(src || {})) {
        const cur = dst[k];
        const val = src[k];
        if ((cur === undefined || cur === null || cur === '')
          && val !== undefined && val !== null && val !== '') {
          dst[k] = val;
        }
      }
    }
    await db.kvSet('anon', 'profiles', JSON.stringify(profiles));
    console.log('[identity] own profile migrated:', old, '→', neu);
    return { key: neu, profile: profiles[neu] };
  } catch (e) {
    console.warn('[identity] migrateOwnProfile failed:', e);
    return null;
  }
}

// Перебор групп, где мы создатель или участник. Возвращает число переименованных
// и зовёт onRenamed, если что-то поменялось: вызывающий обязан перечитать список,
// иначе он останется со старыми адресами на экране.
export async function migratePeerGroups(oldEmail, newEmail, onRenamed) {
  if (!oldEmail || !newEmail) return 0;
  const oldLc = String(oldEmail).toLowerCase();
  let n = 0;
  try {
    const all = await api.getGroups();
    for (const g of all || []) {
      const has = String(g.created_by || '').toLowerCase() === oldLc
        || (g.members || []).some(m => String(m.email || '').toLowerCase() === oldLc);
      if (!has) continue;
      await invoke('groups_rename_member', {
        groupId: g.id, oldEmail, newEmail,
      });
      n++;
    }
    if (n) {
      console.log('[identity] peer groups renamed:', oldEmail, '→', newEmail, '(' + n + ')');
      if (onRenamed) { try { await onRenamed(); } catch (e) { /* перечитаем позже */ } }
    }
  } catch (e) {
    console.warn('[identity] migratePeerGroups failed:', e);
  }
  return n;
}
