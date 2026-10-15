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
import api from './api.js';
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
