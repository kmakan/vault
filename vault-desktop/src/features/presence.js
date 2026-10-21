// Feature module: presence (зелёная точка онлайн, t_e858bdb9).
//
// ADR-005 W2 (`t_bcb8927a`), партия 13: модуль больше НЕ читает компонент.
// «Залогинен» — владелец session-store, ключи пиров — identity-store,
// cryptoReady — в deps. Флаг «отправка идёт» — модульная переменная (не
// состояние приложения): он защищает от повторной отправки, а не отображается.
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
import { accountNamespace } from '../identity.js';
import crypto from '../crypto.js';
import { invoke } from '@tauri-apps/api/core';
import { sessionStore } from './session-store.js';
import { identityStore } from './identity-store.js';

export const PRESENCE_INTERVAL_MS = 5 * 60 * 1000;   // отправка heartbeat
// Флаг «отправка heartbeat идёт» — внутренняя деталь модуля.
let presenceSending = false;

export const PRESENCE_ONLINE_MS = 11 * 60 * 1000;    // окно «онлайн» (2× + буфер)

// Таймер heartbeat и метка «когда последний раз отправляли» — ВНУТРЕННИЕ
// детали модуля, а не состояние компонента (ADR-005 W2, партия 13): раньше
// они висели на ctx под строковыми ключами.
let HB_TIMER = null;
let HB_SENT_AT = 0;

// ── Тумблер (kv 'presence-enabled', per-account) ──────────────

export async function isEnabled(email) {
  try {
    return (await db.kvGet(await accountNamespace(email), 'presence-enabled')) === '1';
  } catch (e) { return false; }
}

export async function setEnabled(email, on, { startHeartbeats, stopHeartbeats }) {
  try {
    await db.kvSet(await accountNamespace(email), 'presence-enabled', on ? '1' : '0');
  } catch (e) { /* kv недоступен — остаётся in-memory */ }
  if (on) startHeartbeats();
  else stopHeartbeats();
}

// Включение/выключение presence.
//
// Сбой записи в kv не должен оставлять приложение в неопределённом
// состоянии, поэтому ошибка гасится здесь, а не у вызывающего.
export async function setPresenceEnabled(deps, on) {
  try {
    await setEnabled(deps.email, on, {
      startHeartbeats: () => deps.startHeartbeats(),
      stopHeartbeats: () => deps.stopHeartbeats(),
    });
  } catch (e) {
    console.warn('[presence] setEnabled failed:', e && e.message || e);
  }
}

// Обработчик переключателя в настройках — тот же путь, что у кнопки.
export function onPresenceEnabled(deps, on) {
  return setPresenceEnabled(deps, on);
}

// ── Отправка heartbeat ────────────────────────────────────────
// Одно письмо каждому контакту с peer-ключом. Ролей у presence нет:
// получатель просто отмечает «видел активность сейчас». Ошибки одного
// адресата не останавливают остальных (как sendGroupReact).
export async function sendHeartbeat(deps) {
  if (!sessionStore.state.isLoggedIn || !deps.cryptoReady()) return;
  const peers = Object.keys(identityStore.state.peerKeys || {}).filter(Boolean);
  if (!peers.length) return;
  const payload = JSON.stringify({ presence: 1, ts: Date.now() });
  for (const peer of peers) {
    try {
      crypto.setPeerPublicKey(identityStore.state.peerKeys[peer], identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[peer]);
      const content = await crypto.encryptVault(payload);
      await api.sendReaction(peer, content); // stealth-письмо с пустой темой
    } catch (e) {
      console.warn('[presence] heartbeat to', peer, 'failed:', e && e.message || e);
    }
  }
  HB_SENT_AT = Date.now();
}

export function startHeartbeats(deps) {
  stopHeartbeats(ctx);
  if (!sessionStore.state.isLoggedIn) return;
  HB_TIMER = setInterval(() => {
    // Анти-наложение: пропускаем тик, если предыдущий ещё пишется
    if (presenceSending) return;
    presenceSending = true;
    sendHeartbeat(deps).catch(() => {}).finally(() => { presenceSending = false; });
  }, PRESENCE_INTERVAL_MS);
  // Первый heartbeat сразу — точка у собеседников загорается без 5-минутного
  // ожидания после включения тумблера.
  sendHeartbeat(ctx).catch(() => {});
}

export function stopHeartbeats(deps) {
  if (HB_TIMER) { clearInterval(HB_TIMER); HB_TIMER = null; }
  presenceSending = false;
}

// ── Приём ──────────────────────────────────────────────────────
// Приём heartbeat-сигнала. Возвращает true, если письмо было
// presence-сигналом (не сообщение).
//
// `noteSeen` — СВЯЗАННАЯ функция отметки, а не компонент: принимающий
// модуль не должен знать, откуда взялся эффект (ADR-005 R3). Связывание
// делает вызывающий (App.vue — через контракт модуля; groups.js —
// пока ещё ctx-модуль, лямбда замыкает ctx).
//
// Решение «это presence?» — здесь, в одном месте: вызывающий приносит
// разобранный конверт и получает ответ «сигнал или нет».
export function ingestSignal(noteSeen, robj, senderEmail, mailTs) {
  if (!robj || robj.presence !== 1) return false;
  noteHeartbeat(noteSeen, senderEmail, mailTs);
  return true;
}

// Эффект heartbeat БЕЗ повторного решения о типе.
//
// Нужен там, где тип письма уже решил Rust (`kind=presence`, W1 ADR-005):
// повторная проверка `robj.presence === 1` в JS означала бы, что решение
// осталось в двух местах и может разойтись. Здесь только последствия:
// отметка «видели» (`noteSeen(email, ts)` — связанная функция, а не ctx)
// + запись heartbeat в Rust-леджер.
export function noteHeartbeat(noteSeen, senderEmail, mailTs) {
  // ts отправителя может убегать вперёд из-за расхождения часов; верим
  // времени письма сервера, но не даём отметке уйти в будущее.
  const t = Math.min(Number(mailTs) || Date.now(), Date.now());
  noteSeen(senderEmail, t);
  // M2.2: persist heartbeat ledger via Rust bridge (offline last-seen).
  try { invoke("presence_ingest", { email: senderEmail, ts: t, source: "hb" }); }
  catch (e) { /* non-blocking: in-memory lastSeenMap достаточно для UI */ }
}

// ── Отображение: онлайн ли контакт (active presence) ──────────
// isRecentlySeen (profiles.js) — пассивное окно 10 минут от любого
// письма; здесь то же хранилище lastSeenMap, окно heartbeat.
export function isOnline(lastSeenMap, email) {
  const t = lastSeenMap[email];
  if (!t) return false;
  return Date.now() - t < PRESENCE_ONLINE_MS;
}
