// Feature module: presence (зелёная точка онлайн, t_e858bdb9).
// Активные heartbeat-письма по почте — тот же сигнальный канал, что реакции
// и голосования: {presence:1, ts} шифруется на peer-ключе (encryptVault),
// уходит с ПУСТОЙ темой (stealth), получатель роутером ветит в noteSeen.
//
// Модель приватности: тумблер «Показывать, что я онлайн» выключен по
// умолчанию — heartbeat не отправляется, пока пользователь не включит.
// Пассивная точка (любое письмо контакта = активность) работает как раньше.
//
// Интервал 5 минут (выбор юзера 14.09); «онлайн» живёт 2×интервала + буфер,
// чтобы точка не гасла из-за задержки SMTP одного письма.

import api, { db } from '../api.js';
import crypto from '../crypto.js';

export const PRESENCE_INTERVAL_MS = 5 * 60 * 1000;   // отправка heartbeat
export const PRESENCE_ONLINE_MS = 11 * 60 * 1000;    // окно «онлайн» (2× + буфер)

const HB_TIMER = '_presenceHbTimer';
const HB_SENT_AT = '_presenceHbSentAt';

// ── Тумблер (kv 'presence-enabled', per-account) ──────────────

export async function isEnabled(ctx) {
  try {
    return (await db.kvGet(ctx.email || 'anon', 'presence-enabled')) === '1';
  } catch (e) { return false; }
}

export async function setEnabled(ctx, on) {
  try {
    await db.kvSet(ctx.email || 'anon', 'presence-enabled', on ? '1' : '0');
  } catch (e) { /* kv недоступен — остаётся in-memory */ }
  if (on) startHeartbeats(ctx);
  else stopHeartbeats(ctx);
}

// ── Отправка heartbeat ────────────────────────────────────────
// Одно письмо каждому контакту с peer-ключом. Ролей у presence нет:
// получатель просто отмечает «видел активность сейчас». Ошибки одного
// адресата не останавливают остальных (как sendGroupReact).
export async function sendHeartbeat(ctx) {
  if (!ctx.isLoggedIn || !ctx.cryptoReady) return;
  const peers = Object.keys(ctx.peerKeys || {}).filter(Boolean);
  if (!peers.length) return;
  const payload = JSON.stringify({ presence: 1, ts: Date.now() });
  for (const peer of peers) {
    try {
      crypto.setPeerPublicKey(ctx.peerKeys[peer], ctx.peerPqKeys && ctx.peerPqKeys[peer]);
      const content = await crypto.encryptVault(payload);
      await api.sendReaction(peer, content); // stealth-письмо с пустой темой
    } catch (e) {
      console.warn('[presence] heartbeat to', peer, 'failed:', e && e.message || e);
    }
  }
  ctx[HB_SENT_AT] = Date.now();
}

export function startHeartbeats(ctx) {
  stopHeartbeats(ctx);
  if (!ctx.isLoggedIn) return;
  ctx[HB_TIMER] = setInterval(() => {
    // Анти-наложение: пропускаем тик, если предыдущий ещё пишется
    if (ctx._presenceSending) return;
    ctx._presenceSending = true;
    sendHeartbeat(ctx).catch(() => {}).finally(() => { ctx._presenceSending = false; });
  }, PRESENCE_INTERVAL_MS);
  // Первый heartbeat сразу — точка у собеседников загорается без 5-минутного
  // ожидания после включения тумблера.
  sendHeartbeat(ctx).catch(() => {});
}

export function stopHeartbeats(ctx) {
  if (ctx[HB_TIMER]) { clearInterval(ctx[HB_TIMER]); ctx[HB_TIMER] = null; }
  ctx._presenceSending = false;
}

// ── Приём ──────────────────────────────────────────────────────
// Вызывается из роутера входящих (рядом с веткой poll-голосов) —
// Возвращает true, если письмо было presence-сигналом (не сообщение).
export function ingestSignal(ctx, robj, senderEmail, mailTs) {
  if (!robj || robj.presence !== 1) return false;
  // ts отправителя может убегать вперёд из-за расхождения часов; верим
  // времени письма сервера, но не даём отметке уйти в будущее.
  const t = Math.min(Number(mailTs) || Date.now(), Date.now());
  ctx.noteSeen(senderEmail, t);
  return true;
}

// ── Отображение: онлайн ли контакт (active presence) ──────────
// isRecentlySeen (profiles.js) — пассивное окно 10 минут от любого
// письма; здесь то же хранилище lastSeenMap, окно heartbeat.
export function isOnline(ctx, email) {
  const t = ctx.lastSeenMap[email];
  if (!t) return false;
  return Date.now() - t < PRESENCE_ONLINE_MS;
}
