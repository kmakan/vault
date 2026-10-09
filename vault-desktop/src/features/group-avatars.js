// Feature module: аватары групп — самовосстановление (heal-протокол).
// Изоляция фичи (правило канбан t_7c3929d2): новая фича = отдельный модуль,
// App.vue — только тонкие обёртки-делегаты; все зависимости явные (ctx).
//
// Данные: аватар = kv `group-avatar:<gid>` (namespace 'anon', НЕ email-keyed —
// смена почты аккаунта его не трогает).
// Доставка (всё под групповым ключом, открытого текста нет):
//  1) healFromMessage: gavatar в групповом конверте → лечим kv из ЛЮБОГО
//     нового письма группы;
//  2) requestHeal: устройство с ПУСТЫМ kv шлёт {hav:1} (kv-флаг
//     avatar-heal-sent:<gid>, 24ч) → replyHeal владельца непустого аватара
//     отвечает meta{1,avatar} (kv-флаг avatar-heal-replied:<gid>, 24ч).
//     Петля невозможна по построению: запрос ТОЛЬКО при пустом kv, ответ
//     ТОЛЬКО при непустом; после ответа kv запросившего непустой.
//  3) rename-meta несёт текущий непустой avatar (App.onGroupRename).
import api, { db } from '../api.js';
import crypto from '../crypto.js';

const AVATAR_P = 'group-avatar:';
const SENT_P = 'avatar-heal-sent:';
const REPLIED_P = 'avatar-heal-replied:';
const DAY_MS = 24 * 3600 * 1000;

async function rateLimitExpired(flagKey) {
  const last = Number((await db.kvGet('anon', flagKey)) || 0);
  return !last || Date.now() - last >= DAY_MS;
}

async function groupKeyOf(ctx, groupId) {
  let groupKey = ctx.groupKeys[groupId];
  if (!groupKey && ctx.cryptoReady) {
    try {
      const kd = await api.getMyGroupKey(groupId);
      if (kd && kd.group_key) { ctx.groupKeys[groupId] = kd.group_key; groupKey = kd.group_key; }
    } catch (e) { console.log('[group] avatar-heal keyload failed:', groupId, String(e)); }
  }
  return groupKey || null;
}

// Приём gavatar из конверта: пусто/не-строка НИКОГДА не пишется (guard —
// пустое значение не может затереть существующий аватар).
export async function healFromMessage(ctx, groupId, gavatar) {
  if (!gavatar || typeof gavatar !== 'string') return;
  const cur = await db.kvGet('anon', AVATAR_P + groupId);
  if (cur !== gavatar) {
    await db.kvSet('anon', AVATAR_P + groupId, gavatar);
    ctx.groupAvatars[groupId] = gavatar;
    console.log('[group] avatar healed from message:', groupId);
  }
}

// Ответ на {hav:1}: у меня есть аватар группы → шлю meta{1,avatar}
// всем участникам (rate-limit 24ч на группу).
export async function replyHeal(ctx, groupId) {
  try {
    const my = await db.kvGet('anon', AVATAR_P + groupId);
    if (!my) return; // у меня пусто — не отвечаем (защита от петли)
    const flagKey = REPLIED_P + groupId;
    if (!(await rateLimitExpired(flagKey))) return; // 24ч rate-limit
    const groupKey = await groupKeyOf(ctx, groupId);
    if (!groupKey) { console.log('[group] avatar-heal reply skip: no group key', groupId); return; }
    const content = await crypto.encryptWithGroupKey(JSON.stringify({ meta: 1, avatar: my }), groupKey);
    await api.sendGroupMeta(groupId, content);
    await db.kvSet('anon', flagKey, String(Date.now()));
    console.log('[group] avatar-heal replied:', groupId);
    return true; // вызывающий помечает письмо обработанным ТОЛЬКО при успехе
  } catch (e) {
    console.warn('[group] avatar-heal reply failed:', groupId, e);
  }
}

// Запрос {hav:1}: мой kv этой группы пуст → прошу участников прислать
// аватар. Вызывается fire-and-forget из loadGroups (guard'ы внутри).
export async function requestHeal(ctx, groupId) {
  try {
    const flagKey = SENT_P + groupId;
    if (!(await rateLimitExpired(flagKey))) return; // 24ч rate-limit
    const groupKey = await groupKeyOf(ctx, groupId);
    if (!groupKey) return; // нечем шифровать — группу пропускаем тихо
    const content = await crypto.encryptWithGroupKey(JSON.stringify({ hav: 1 }), groupKey);
    await api.sendGroupMeta(groupId, content);
    await db.kvSet('anon', flagKey, String(Date.now()));
    console.log('[group] avatar-heal requested:', groupId);
  } catch (e) {
    console.warn('[group] avatar-heal request failed:', groupId, e);
  }
}
