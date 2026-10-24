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
import { accountNamespace, dropOwnEntries } from '../identity.js';
import crypto from '../crypto.js';
// ADR-005 W2 (`t_bcb8927a`), партия 8: состояние — у владельцев.
//   · uiStore.formState/modalFlags — форма правки контакта и карточка контакта
//     (UI-состояние, ADR-003 §2: остаётся в компоненте, но живёт у владельца
//     форм/модалок);
//   · contactsStore — список контактов;
//   · identityStore — ключи пиров;
//   · sessionStore — email аккаунта.
import { uiStore, sessionStore } from './session-store.js';
import { contactsStore } from './contacts-store.js';
import { identityStore } from './identity-store.js';

// ── Резолв имён/аватаров ───────────────────────────────────────
// ADR-001: зависимости в сигнатуре (деструктуризация = жёсткая граница).
export function profileOf(profiles, email) {
  return (profiles || {})[email] || null;
}

// Локальные переопределения (per-account): пользователь сам решает, как
// называть контакт и какой аватар ему ставить. Приоритет выше, чем у
// синхронизированного профиля собеседника.
export function localProfileOf(localProfiles, email) {
  return (localProfiles || {})[email] || null;
}

// Все адреса с тем же peer-ключом (смена почты): профиль может лежать
// под СТАРЫМ адресом — алиасы дадут имя/аватар.
export function aliasesOf(peerKeys, email) {
  const keys = peerKeys || {};
  const key = keys[email || ''] || keys[String(email || '').toLowerCase()];
  if (!key) return [String(email || '').toLowerCase()];
  const out = new Set([String(email || '').toLowerCase()]);
  for (const [k, v] of Object.entries(keys)) {
    if (v === key) out.add(String(k).toLowerCase());
  }
  return [...out];
}

export function nameOf({ profiles, localProfiles, peerKeys }, email) {
  const lp = localProfileOf(localProfiles, email);
  if (lp && lp.name) return lp.name;
  const p = profileOf(profiles, email);
  // name == email — это НЕ имя, а fallback старых клиентов (они слали
  // email как name). Не показываем его как имя.
  if (p && p.name && p.name !== email) return p.name;
  // Регистр email может отличаться (заголовки From: «Имя <Mail@X>» vs
  // ключ в kv_store lowercase). Ищем по нижнему регистру.
  const e = String(email || '').toLowerCase();
  for (const [k, v] of Object.entries(profiles || {})) {
    if (String(k).toLowerCase() === e && v && v.name && v.name !== email) return v.name;
  }
  // Смена почты: профиль может лежать под СТАРЫМ адресом
  // все алиасы (один pubkey → несколько адресов) дадут имя.
  for (const alias of aliasesOf(peerKeys, email)) {
    if (alias === e) continue;
    const ap = profileOf(profiles, alias) || (profiles || {})[alias];
    if (ap && ap.name && ap.name !== alias) return ap.name;
  }
  return email;
}

export function avatarOf({ profiles, localProfiles, peerKeys }, email) {
  const lp = localProfileOf(localProfiles, email);
  if (lp && lp.avatar) return lp.avatar;
  const p = profileOf(profiles, email);
  if (p && p.avatar) return p.avatar;
  const e = String(email || '').toLowerCase();
  for (const [k, v] of Object.entries(profiles || {})) {
    if (String(k).toLowerCase() === e && v && v.avatar) return v.avatar;
  }
  // Смена почты: аватар может лежать под СТАРЫМ адресом (алиасом).
  for (const alias of aliasesOf(peerKeys, email)) {
    if (alias === e) continue;
    const ap = profileOf(profiles, alias) || (profiles || {})[alias];
    if (ap && ap.avatar) return ap.avatar;
  }
  return null;
}

// ── Хранилище ──────────────────────────────────────────────────
// ADR-001: мутируемое состояние передаётся setter'ом — сама фича не
// пишет в компонент напрямую (иначе правка ломает App.vue из-под него).
export async function loadLocalProfiles({ email, setLocalProfiles }) {
  try {
    // SQLite kv_store.
    const v = await db.kvGet(await accountNamespace(email), 'local-profiles');
    setLocalProfiles(v ? JSON.parse(v) : {});
  } catch (e) {
    setLocalProfiles({});
  }
}

export async function saveLocalProfiles({ email, localProfiles }) {
  try {
    await db.kvSet(await accountNamespace(email), 'local-profiles', JSON.stringify(localProfiles || {})).catch(() => {});
  } catch (e) {
    console.error('Failed to save local profiles:', e);
  }
}

export async function loadProfiles({ setProfiles }) {
  try {
    setProfiles(await api.getProfilesAll());
  } catch (e) {
    setProfiles({});
  }
}

// --- Статус «О себе»: свой bio в kv_store, уходит в profile-конверте
export async function getBio({ email }) {
  try { return (await db.kvGet(await accountNamespace(email), 'bio')) || ''; } catch { return ''; }
}

export async function setBio({ email, text }) {
  const v = String(text || '').slice(0, 200);
  await db.kvSet(await accountNamespace(email), 'bio', v);
  return v;
}

export async function onBioSave({ email, showToast, t }, text) {
  await setBio({ email, text });
  // Текст был зашит по-русски, хотя ключ settings_profile_saved есть во всех
  // трёх локалях и означает ровно то же. Англоязычные и китайские пользователи
  // видели подтверждение сохранения на русском (ADR-003 партия 15).
  showToast(t('settings_profile_saved'));
}

// «Сохранить профиль»: ОДНО письмо с именем+аватаром+статусом и
// одним ts — на приёме более позднее письмо с неполным набором
// перетирало _ts и блокировало/возвращало старые значения
// (чехарда имени/аватара).
export async function onProfileSave({ showToast, t, broadcastProfile: doBroadcast }) {
  try {
    await doBroadcast();
    showToast(t('settings_profile_saved') || 'Профиль сохранён — контакты обновят его');
  } catch (e) {
    console.error('[profile] broadcast on save failed:', e);
    showToast(t('settings_profile_saved') || 'Профиль сохранён');
  }
}

// ── Wire: broadcast профиля ────────────────────────────────────
// ADR-001: все зависимости в сигнатуре — крипто-пайплайн читает только
// перечисленное, правка фичи не касается соседних доменов.
export async function broadcastProfile({ email, displayName, profiles, peerKeys, peerPqKeys }) {
  // Рассылаем НЕ всем из peer_keys: алиасы собственной сессии лежат там же,
  // где чужие ключи, и письмо-профиль уходило самому себе (а свой аккаунт
  // выглядел контактом). «Это я?» решает ядро через dropOwnEntries.
  const entries = Object.entries(peerKeys || {})
    .map(([addr, key]) => ({ email: addr, public_key: key }))
    .filter(e => e.public_key);
  const peers = (await dropOwnEntries(entries, email)).map(e => e.email);
  if (!peers.length) return;
  const name = displayName || email || '';
  // Актуальный аватар: kv (после onAvatarUpdate/saveProfile) в приоритете,
  // profiles в памяти мог устареть (гонка loadProfiles ↔ редактирование).
  let avatar = ((profiles || {})[email] || {}).avatar || '';
  try {
    const kvProfiles = JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
    const kp = kvProfiles[String(email).toLowerCase()];
    if (kp && kp.avatar) avatar = kp.avatar;
  } catch (e) { /* ignore */ }
  const bio = await getBio({ email });
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
    const peerKey = (peerKeys || {})[peer];
    if (!peerKey) continue;
    crypto.setPeerPublicKey(peerKey, peerPqKeys && peerPqKeys[peer]);
    const content = await crypto.encryptVault(JSON.stringify(body));
    try { await api.sendReadReceipt(peer, content); } catch (e) { /* тихо */ }
  }
  console.log('[profile] broadcast to', peers.length, 'contacts');
}

// ── UI-flow: карточка и локальная правка ────────────────────────
// ADR-005 W2 (партия 8): состояние UI-flow — у владельцев:
// contactCardEmail/showContactCard/editingContact/editContactName/
// editContactAvatar — uiStore (formState + modalFlags). Модалки — чисто
// вью-состояние, не бизнес-логика (ADR-003 §2), но владелец у них один:
// uiStore, и он РЕАКТИВЕН (20.10: обычный объект кэшировался в computed
// навсегда — модалки не открывались).
// Карта профилей (profiles) и локальные имена (localProfiles) — состояние
// компонента: в deps тремя узкими доступами.
// Модалка редактирования контакта (локальные имя/аватар).
// Карточка контакта: тап по аватару в шапке чата.
export async function openContactCard(deps, email) {
  if (!email || email === '__notes__') return;
  // вью-данные (bio мог прийти поллингом, но profiles не обновился).
  await loadProfiles({ setProfiles: (v) => { deps.setProfiles(v); } }).catch(() => {});
  uiStore.setFormField('contactCardEmail', email);
  uiStore.setModal('showContactCard', true);
}

// Из карточки → локальная правка имени/аватара (старый попап).
export function startEditFromCard(deps) {
  const email = uiStore.getFormField('contactCardEmail');
  uiStore.setModal('showContactCard', false);
  openContactEdit(deps, email);
}

export function openContactEdit(deps, email) {
  if (!email) return;
  uiStore.setFormField('editingContact', email);
  const lp = localProfileOf(deps.getLocalProfiles(), email);
  uiStore.setFormField('editContactName', (lp && lp.name) || '');
  uiStore.setFormField('editContactAvatar', (lp && lp.avatar) || '');
  uiStore.setModal('showContactEdit', true);
}

export function handleContactAvatarSelect(deps, event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    // Сжимаем до 64×64, как и свои аватары (localStorage не резиновый).
    uiStore.setFormField('editContactAvatar', await shrinkAvatar(e.target.result));
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

export function saveContactEdit(deps) {
  const email = uiStore.getFormField('editingContact');
  if (!email) return;
  const name = String(uiStore.getFormField('editContactName') || '').trim();
  const avatar = uiStore.getFormField('editContactAvatar') || '';
  if (!name && !avatar) {
    // Пусто = сброс к реальным имени/аватару собеседника.
    delete deps.getLocalProfiles()[email];
  } else {
    deps.getLocalProfiles()[email] = { name, avatar };
  }
  saveLocalProfiles({ email: sessionStore.getCurrentEmail(), localProfiles: deps.getLocalProfiles() });
  // Обновляем отображение в списке контактов (contact.name берётся из
  // peer-key label — подменяем на локальное имя, если задано).
  const c = contactsStore.state.contacts.find(x => x.email === email);
  if (c) c.name = name || nameOf({ profiles: deps.getProfiles(), localProfiles: deps.getLocalProfiles(), peerKeys: identityStore.state.peerKeys }, email);
  uiStore.setModal('showContactEdit', false);
  uiStore.setFormField('editingContact', null);
}

export function resetContactEdit(deps) {
  const editing = uiStore.getFormField('editingContact');
  if (editing) {
    delete deps.getLocalProfiles()[editing];
    saveLocalProfiles({ email: sessionStore.getCurrentEmail(), localProfiles: deps.getLocalProfiles() });
    const c = contactsStore.state.contacts.find(x => x.email === editing);
    if (c) c.name = nameOf({ profiles: deps.getProfiles(), localProfiles: deps.getLocalProfiles(), peerKeys: identityStore.state.peerKeys }, editing);
  }
  uiStore.setModal('showContactEdit', false);
  uiStore.setFormField('editingContact', null);
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
// ADR-001: чистые функции — возвращают новое значение map/boolean,
// состояние принадлежит компоненту.
// deps: { lastSeenMap(), setLastSeenMap(v) } — карта «видели» у владельца
// контактов (contacts-store, ADR-004 J.5a).
export function noteSeen(deps, email, ts) {
  const lastSeenMap = deps.lastSeenMap();
  if (!email || typeof email !== 'string' || !email.includes('@')) return lastSeenMap;
  const t = Number(ts) || Date.now();
  if (((lastSeenMap || {})[email] || 0) < t) {
    const next = { ...lastSeenMap, [email]: t };
    deps.setLastSeenMap(next);
    return next;
  }
  return lastSeenMap;
}

export function isRecentlySeen(lastSeenMap, email) {
  const t = (lastSeenMap || {})[email];
  if (!t) return false;
  return Date.now() - t < 10 * 60 * 1000; // 10 минут
}

// ── Свой профиль: аватар, имя, био (ADR-005 W3, партия 8) ───────────────
// Логика уехала из App.vue. Профили — у владельца контактов (contacts-store:
// localProfiles) и в profiles (загружаются фичей), тосты — у uiStore.
//
// deps: { email(), displayName(), profiles(), setProfiles(), userAvatarUrl(),
//         setUserAvatarUrl(), shrinkAvatar(url), alert(msg) }

// Своё био: сохраняем в kv и держим в состоянии компонента.
export async function setMyBio(deps, text) {
  const v = await setBio({ email: deps.email(), text });
  deps.setMyBio(v);
  return v;
}

export async function onAvatarUpdate(deps, dataUrl) {
  deps.setUserAvatarUrl(dataUrl);
  // Локально: память + kv (переживёт перезапуск). НЕ шлём письмо —
  // контакты узнают ТОЛЬКО по «Сохранить» (единое письмо имя+аватар+статус).
  // ts = Date.now() — СВОЁ действие (иначе guard tsNum=0 блокирует запись
  const profiles = deps.profiles();
  if (!profiles[deps.email()]) profiles[deps.email()] = {};
  profiles[deps.email()].avatar = dataUrl || '';
  await api.saveProfile(deps.email(), deps.displayName() || deps.email(), dataUrl || '', Date.now());
}

export async function onNameUpdate(deps, name) {
  // Только локально; контакты узнают по «Сохранить» (единое письмо).
  deps.setDisplayName(name || deps.email() || '');
}

// Файл аватара из input[type=file] → dataURL → сохранение.
export function onAvatarFileSelect(deps, e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    deps.alert(uiStore.tr('err_file_too_big_2m'));
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    deps.setUserAvatarUrl(ev.target.result);
    // Аватар — данные: sqlite kv_store, не localStorage.
    api.setAvatar(deps.email(), ev.target.result).catch(() => {});
    const profiles = deps.profiles();
    if (!profiles[deps.email()]) profiles[deps.email()] = {};
    profiles[deps.email()].avatar = ev.target.result;
    deps.setShowAvatarUpload(false);
  };
  reader.readAsDataURL(file);
}
