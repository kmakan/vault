// Feature module: «звёзды» сообщений (избранное в чате).
//
// ADR-005 W3 (`t_b1bdbb99`), партия 7: логика уехала из App.vue. Состояние —
// у владельца форм (uiStore: карта «чат → id сообщений»), персист — в sqlite
// kv ('starred:<chatKey>'), счётчик — производный от карты.
import { db } from '../api.js';
import { accountNamespace } from '../identity.js';

// Отмечено ли сообщение звездой.
export function isStarred(deps, msg) {
  return !!(msg && msg.id && deps.starredSet().has(msg.id));
}

// Переключить звезду: состояние обновляется сразу (новый объект — иначе Vue
// не увидит изменение), персист — следом.
export async function toggleStar(deps, msg) {
  if (!msg || !msg.id) return;
  const key = deps.currentChatKey();
  if (!key || key === '__notes__') return;
  const list = new Set(deps.starredMap()[key] || []);
  if (list.has(msg.id)) list.delete(msg.id);
  else list.add(msg.id);
  // Реактивность: новый объект массива, иначе Vue не увидит изменение.
  deps.setStarredMap({ ...deps.starredMap(), [key]: Array.from(list) });
  try {
    const ns = await accountNamespace(deps.email());
    if (list.size) await db.kvSet(ns, 'starred:' + key, JSON.stringify(Array.from(list)));
    else await db.kvDelete(ns, 'starred:' + key);
  } catch (e) { /* kv недоступен — живёт в памяти до перезапуска */ }
}

// Загрузить звёзды чата из kv.
export async function loadStarredFor(deps, chatKey) {
  if (!chatKey || chatKey === '__notes__') return;
  try {
    const ns = await accountNamespace(deps.email());
    const raw = await db.kvGet(ns, 'starred:' + chatKey);
    const arr = raw ? JSON.parse(raw) : [];
    deps.setStarredMap({ ...deps.starredMap(), [chatKey]: Array.isArray(arr) ? arr : [] });
  } catch (e) { /* тихо */ }
}
