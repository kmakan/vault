// Feature module: профили контактов (имя/аватар/статус) + локальные
// переопределения + зелёная точка. Этап 5 декомпозиции App.vue —
// изоляция фич-доменов (ctx-паттерн Этапа 1/4).
//
// Срезы домена:
//  - резолв: profileOf/localProfileOf/nameOf/avatarOf/aliasesOf —
//    приоритет: локальное переопределение > wire-профиль > алиасы
//    (смена почты не теряет имя/аватар);
//  - хранилище: loadLocalProfiles/saveLocalProfiles (kv), loadProfiles,
//    getBio/setBio (kv 'bio');
//  - wire: broadcastProfile — ОДНО письмо каждому пиру его ключом
//    (name+avatar+bio+key+ts одним конвертом);
//  - UI-flow: карточка контакта, локальная правка имени/аватара
//    (openContactCard/openContactEdit/saveContactEdit/resetContactEdit);
//  - картинки: shrinkAvatar (64×64 JPEG), compressImage (центр-масштаб);
//  - presence: noteSeen/isRecentlySeen (зелёная точка, окно 10 минут).
//
// Инвариант nameOf: name == email — это НЕ имя, а fallback старых
// клиентов; показываем только настоящее имя.

import api, { db } from '../api.js';
import crypto from '../crypto.js';

// ── Резолв имён/аватаров ───────────────────────────────────────
export function profileOf(ctx, email) {
  return ctx.profiles[email] || null;
}

// Локальные переопределения (per-account): пользователь сам решает, как
// называть контакт и какой аватар ему ставить. Приоритет выше, чем у
// синхронизированного профиля собеседника.
export function localProfileOf(ctx, email) {
  return ctx.localProfiles[email] || null;
}

// Все адреса с тем же peer-ключом (смена почты): профиль может лежать
// под СТАРЫМ адресом — алиасы дадут имя/аватар.
export function aliasesOf(ctx, email) {
  const key = ctx.peerKeys[email || ''] || ctx.peerKeys[String(email || '').toLowerCase()];
  if (!key) return [String(email || '').toLowerCase()];
  const out = new Set([String(email || '').toLowerCase()]);
  for (const [k, v] of Object.entries(ctx.peerKeys)) {
    if (v === key) out.add(String(k).toLowerCase());
  }
  return [...out];
}

export function nameOf(ctx, email) {
  const lp = localProfileOf(ctx, email);
  if (lp && lp.name) return lp.name;
  const p = profileOf(ctx, email);
  // name == email — это НЕ имя, а fallback старых клиентов (они слали
  // email как name). Не показываем его как имя.
  if (p && p.name && p.name !== email) return p.name;
  // Регистр email может отличаться (заголовки From: «Имя <Mail@X>» vs
  // ключ в kv_store lowercase). Ищем по нижнему регистру.
  const e = String(email || '').toLowerCase();
  for (const [k, v] of Object.entries(ctx.profiles || {})) {
    if (String(k).toLowerCase() === e && v && v.name && v.name !== email) return v.name;
  }
  // Смена почты: профиль может лежать под СТАРЫМ адресом
  // все алиасы (один pubkey → несколько адресов) дадут имя.
  for (const alias of aliasesOf(ctx, email)) {
    if (alias === e) continue;
    const ap = profileOf(ctx, alias) || (ctx.profiles || {})[alias];
    if (ap && ap.name && ap.name !== alias) return ap.name;
  }
  return email;
}

export function avatarOf(ctx, email) {
  const lp = localProfileOf(ctx, email);
  if (lp && lp.avatar) return lp.avatar;
  const p = profileOf(ctx, email);
  if (p && p.avatar) return p.avatar;
  const e = String(email || '').toLowerCase();
  for (const [k, v] of Object.entries(ctx.profiles || {})) {
    if (String(k).toLowerCase() === e && v && v.avatar) return v.avatar;
  }
  // Смена почты: аватар может лежать под СТАРЫМ адресом (алиасом).
  for (const alias of aliasesOf(ctx, email)) {
    if (alias === e) continue;
    const ap = profileOf(ctx, alias) || (ctx.profiles || {})[alias];
    if (ap && ap.avatar) return ap.avatar;
  }
  return null;
}

// ── Хранилище ──────────────────────────────────────────────────
export function loadLocalProfiles(ctx) {
  try {
    // SQLite kv_store.
    db.kvGet(ctx.email || 'anon', 'local-profiles').then(v => {
      if (v) ctx.localProfiles = JSON.parse(v);
    }).catch(() => {});
    ctx.localProfiles = ctx.localProfiles || {};
  } catch (e) {
    ctx.localProfiles = {};
  }
}

export function saveLocalProfiles(ctx) {
  try {
    db.kvSet(ctx.email || 'anon', 'local-profiles', JSON.stringify(ctx.localProfiles)).catch(() => {});
  } catch (e) {
    console.error('Failed to save local profiles:', e);
  }
}

export async function loadProfiles(ctx) {
  try {
    ctx.profiles = await api.getProfilesAll();
  } catch (e) {
    ctx.profiles = {};
  }
}

// --- Статус «О себе»: свой bio в kv_store, уходит в profile-конверте
export async function getBio(ctx) {
  try { return (await db.kvGet(ctx.email || 'anon', 'bio')) || ''; } catch { return ''; }
}

export async function setBio(ctx, text) {
  const v = String(text || '').slice(0, 200);
  await db.kvSet(ctx.email || 'anon', 'bio', v);
  ctx.myBio = v;
  return v;
}

export async function onBioSave(ctx, text) {
  await setBio(ctx, text);
  ctx.showToast('Профиль сохранён — статус уйдёт контактам');
}

// «Сохранить профиль»: ОДНО письмо с именем+аватаром+статусом и
// одним ts — на приёме более позднее письмо с неполным набором
// перетирало _ts и блокировало/возвращало старые значения
// (чехарда имени/аватара).
export async function onProfileSave(ctx) {
  try {
    await broadcastProfile(ctx);
    ctx.showToast(ctx.t('settings_profile_saved') || 'Профиль сохранён — контакты обновят его');
  } catch (e) {
    console.error('[profile] broadcast on save failed:', e);
    ctx.showToast(ctx.t('settings_profile_saved') || 'Профиль сохранён');
  }
}

// ── Wire: broadcast профиля ────────────────────────────────────
export async function broadcastProfile(ctx) {
  const peers = Object.keys(ctx.peerKeys || {});
  if (!peers.length) return;
  const name = ctx.displayName || ctx.email || '';
  // Актуальный аватар: kv (после onAvatarUpdate/saveProfile) в приоритете,
  // ctx.profiles в памяти мог устареть (гонка loadProfiles ↔ редактирование).
  let avatar = (ctx.profiles[ctx.email] || {}).avatar || '';
  try {
    const kvProfiles = JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
    const kp = kvProfiles[String(ctx.email).toLowerCase()];
    if (kp && kp.avatar) avatar = kp.avatar;
  } catch (e) { /* ignore */ }
  const bio = await getBio(ctx);
  const body = {
    vault: 1,
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
    type: 'profile',
    text: '',
    name,
    avatar,
    bio: (bio || '').slice(0, 200),
    key: crypto.publicKey || '',
    ts: Date.now(),
  };
  // Шифруем для КАЖДОГО получателя его ключом. Без этого
  // encryptVault использует глобальный peerPublicKey (последний открытый
  // чат) — письмо расшифровывает только один из всех контактов, остальные
  // получают «AAD auth failed». Это была причина нестабильности: «с третьего
  // раза сработало» — потому что последний открытый чат менялся случайно.
  for (const peer of peers) {
    const peerKey = ctx.peerKeys[peer];
    if (!peerKey) continue;
    crypto.setPeerPublicKey(peerKey, ctx.peerPqKeys && ctx.peerPqKeys[peer]);
    const content = await crypto.encryptVault(JSON.stringify(body));
    try { await api.sendReadReceipt(peer, content); } catch (e) { /* тихо */ }
  }
  console.log('[profile] broadcast to', peers.length, 'contacts');
}

// ── UI-flow: карточка и локальная правка ────────────────────────
// Модалка редактирования контакта (локальные имя/аватар).
// Карточка контакта: тап по аватару в шапке чата.
export async function openContactCard(ctx, email) {
  if (!email || email === '__notes__') return;
  // вью-данные (bio мог прийти поллингом, но ctx.profiles не обновился).
  await loadProfiles(ctx).catch(() => {});
  ctx.contactCardEmail = email;
  ctx.showContactCard = true;
}

// Из карточки → локальная правка имени/аватара (старый попап).
export function startEditFromCard(ctx) {
  const email = ctx.contactCardEmail;
  ctx.showContactCard = false;
  openContactEdit(ctx, email);
}

export function openContactEdit(ctx, email) {
  if (!email) return;
  ctx.editingContact = email;
  const lp = localProfileOf(ctx, email);
  ctx.editContactName = (lp && lp.name) || '';
  ctx.editContactAvatar = (lp && lp.avatar) || '';
  ctx.showContactEdit = true;
}

export function handleContactAvatarSelect(ctx, event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    // Сжимаем до 64×64, как и свои аватары (localStorage не резиновый).
    ctx.editContactAvatar = await shrinkAvatar(e.target.result);
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

export function saveContactEdit(ctx) {
  const email = ctx.editingContact;
  if (!email) return;
  const name = ctx.editContactName.trim();
  const avatar = ctx.editContactAvatar || '';
  if (!name && !avatar) {
    // Пусто = сброс к реальным имени/аватару собеседника.
    delete ctx.localProfiles[email];
  } else {
    ctx.localProfiles[email] = { name, avatar };
  }
  saveLocalProfiles(ctx);
  // Обновляем отображение в списке контактов (contact.name берётся из
  // peer-key label — подменяем на локальное имя, если задано).
  const c = ctx.contacts.find(x => x.email === email);
  if (c) c.name = name || nameOf(ctx, email);
  ctx.showContactEdit = false;
  ctx.editingContact = null;
}

export function resetContactEdit(ctx) {
  if (ctx.editingContact) {
    delete ctx.localProfiles[ctx.editingContact];
    saveLocalProfiles(ctx);
    const c = ctx.contacts.find(x => x.email === ctx.editingContact);
    if (c) c.name = nameOf(ctx, ctx.editingContact);
  }
  ctx.showContactEdit = false;
  ctx.editingContact = null;
}

// ── Картинки ───────────────────────────────────────────────────
export async function shrinkAvatar(dataUrl) {
  if (!dataUrl) return '';
  if (dataUrl.length <= 8192) return dataUrl;
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx2d = canvas.getContext('2d');
    ctx2d.drawImage(img, 0, 0, 64, 64);
    const small = canvas.toDataURL('image/jpeg', 0.7);
    // Берём сжатый только если он реально получился и меньше оригинала.
    if (small && small.length > 0 && small.length < dataUrl.length) return small;
    return dataUrl; // сжатие не помогло — шлём оригинал, не роняем аватар
  } catch (e) {
    return dataUrl; // canvas недоступен — шлём оригинал, не роняем аватар
  }
}

// Центр-масштаб до maxSide по большей стороне, JPEG q. Возвращает dataURL.
export function compressImage(dataUrl, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.max(img.width, img.height);
      if (side <= maxSide) { resolve(null); return; } // сжатие не нужно
      const scale = maxSide / side;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = dataUrl;
  });
}

// ── Presence: зелёная точка ────────────────────────────────────
// Отмечаем активность контакта: входящее письмо от него.
export function noteSeen(ctx, email, ts) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return;
  const t = Number(ts) || Date.now();
  if ((ctx.lastSeenMap[email] || 0) < t) {
    ctx.lastSeenMap = { ...ctx.lastSeenMap, [email]: t };
  }
}

export function isRecentlySeen(ctx, email) {
  const t = ctx.lastSeenMap[email];
  if (!t) return false;
  return Date.now() - t < 10 * 60 * 1000; // 10 минут
}
