// Feature module: адресная книга / игнорирование. Этап 5 декомпозиции
// App.vue — вынос контактовых утилит из сердца компонента (ADR-001).
//
// Чистые функции: зависимости (ignoredUsers, peerKeys, aliasesOf, senderEmail)
// передаются явно — бизнес-логика не держит ссылки на Vue-this.
// state contactsStore.state.ignored / .ignoredUsers — владелец (ContactsFeature
// только вычисляет, не мутирует). persist ignoredUsers — owner (App.vue data).

// Заблокирован ли отправитель для НАС (смена почты не помогает: проверяем
// и сам email, и все алиасы того же peer-ключа).
export function isIgnored(ignoredUsers, peerKeys, email) {
  const key = String(email || '').toLowerCase();
  if (!key || !ignoredUsers) return false;
  if (ignoredUsers[key]) return true;
  const pk = peerKeys && (peerKeys[key] || peerKeys[email]);
  if (!pk) return false;
  for (const k of Object.keys(ignoredUsers)) {
    if (peerKeys[k] === pk) return true;
  }
  return false;
}

// Добавить блокировку отправителя: НОВАЯ карта (вход не мутируется).
//
// Чистая функция, а не две строки в App.vue, по двум причинам. Первая: в
// App.vue эти строки уже были написаны с ошибкой — `map[key]` в ignoreUser
// ссылался на переменную из СОСЕДНЕГО метода (unignoreUser), то есть блокировка
// падала с ReferenceError и не работала вовсе, а сборка этого не видела. Вторая:
// без смоука такое не ловится — а компонент смоуком не покрыть.
export function addIgnored(ignoredUsers, key, ts) {
  const k = String(key || '').toLowerCase().trim();
  const out = { ...(ignoredUsers || {}) };
  if (!k) return out;
  out[k] = ts;
  return out;
}

// Снять блокировку: сам адрес + все алиасы того же peer-ключа (смена почты
// не должна оставлять блок на старом адресе). Возвращает новую карту.
export function removeIgnored(ignoredUsers, email, peerKeys) {
  const key = String(email || '').toLowerCase().trim();
  const src = ignoredUsers || {};
  if (!key) return { ...src };
  const pk = peerKeys && (peerKeys[key] || peerKeys[email]);
  const out = {};
  for (const k of Object.keys(src)) {
    if (k === key || (pk && peerKeys[k] === pk)) continue;
    out[k] = src[k];
  }
  return out;
}

// Отправитель письма — мы сами: sender_id = сырой заголовок From, userId null.
// Свои письма могли придти со СТАРОГО адреса (смена почты) — проверяем все
// свои алиасы (aliasesOf: один pubkey → все адреса).
export function isOwnSender(senderId, email, aliasesOf) {
  if (!senderId || !email) return false;
  const s = String(senderId).toLowerCase();
  return aliasesOf(email).some(a => s.includes(a.toLowerCase()));
}

// Адаптер для MessageItem: msg-объект → чистый email (через senderEmail).
export function msgSenderEmail(msg, senderEmail) {
  if (msg == null) return '';
  const raw = typeof msg === 'string' ? msg : msg.sender_id || '';
  return senderEmail(raw);
}

// Ищем СУЩЕСТВУЮЩЕГО контакта по fingerprint pubkey (смена почты без приглашения).
// Чистая: peerKeys — карта email→pubkey, envKey — pubkey из конверта, sender —
// текущий email отправителя (исключаем self-совпадение, регистронезависимо).
export function findKnownPeerByKey(peerKeys, envKey, sender) {
  if (!peerKeys || !envKey || !sender) return null;
  const senderNorm = String(sender).toLowerCase();
  for (const k of Object.keys(peerKeys)) {
    if (peerKeys[k] === envKey && String(k).toLowerCase() !== senderNorm) return k;
  }
  return null;
}

// isOutboundLetter: письмо нам (From входит в own aliases) → outbox-история чата.
export function isOutboundLetter(m, aliases) {
  if (!m || !aliases) return false;
  const from = String(m.from || '').toLowerCase();
  return aliases.some(a => from.includes(a.toLowerCase()));
}

// resolvePeerSender(isOut, peerEmail, me): кто автор события — собеседник (in) или я (out).
export function resolvePeerSender(isOut, peerEmail, me) {
  return isOut ? peerEmail : me;
}

// resolveEventSender(isOut, peerEmail, fallback): author события без own email fallback
// (напр. edit/vote: если исходящее — peerEmail, иначе From письма или fallback).
export function resolveEventSender(isOut, peerEmail, fallback) {
  return isOut ? peerEmail : (fallback || '');
}

// isPeerEncrypted(peerKeys, cryptoReady, activeChat): можно шифровать 1:1 пир.
export function isPeerEncrypted(peerKeys, cryptoReady, activeChat) {
  return !!cryptoReady && !!peerKeys && !!peerKeys[activeChat];
}

// ADR-001 Etap 3b (contact-invites): acceptContactInvite/declineContactInvite/showNextContact
// iz App.vue. deps-injection (kak invites.js): zavisimosti peredautsya yavno cherez deps,
// NE staticheskie importy (smoke-gate contacts ne mokaet crypto/identityStore).
export async function acceptContactInvite(ctx, c, deps) {
  const {
    loadPeerKeyEmails, markAcceptedContact, showToast, t, setPeerKey, markLoaded,
    savePeerKey, addContact, saveProfile, sendContactAccept, publicKey, peerKeys,
    markContactHandled, unmarkContactHandled, splicePendingContacts, pushPendingContact,
    loadProfiles, loadContacts, showNextContact,
  } = deps;
  const key = `${c.sender}|${c.uid}`;
  markContactHandled(key);
  splicePendingContacts();
  try {
    let exists = !!peerKeys()[c.sender];
    if (!exists) {
      try { exists = (await loadPeerKeyEmails()).has(c.sender); }
      catch (e) { /* disk ne dostupen — schitaem novym */ }
    }
    if (exists) {
      await markAcceptedContact(key);
      showToast((t('already_in_contacts') || 'Kontakt uzhe v spiske') + ': ' + c.sender, 3000);
      showNextContact();
      return;
    }
    if (c.pq_public_key) setPeerKey(c.sender, c.public_key, c.pq_public_key);
    await savePeerKey(c.sender, c.public_key, c.sender_name || null, c.pq_public_key || undefined);
    await markAcceptedContact(key);
    setPeerKey(c.sender, c.public_key);
    markLoaded(c.sender);
    await addContact(c.sender);
    saveProfile(c.sender, c.sender_name, c.sender_avatar, Date.parse(c.date) || Date.now());
    loadProfiles();
    await sendContactAccept(c.sender, publicKey());
    await loadContacts();
  } catch (e) {
    alert('Failed to accept contact: ' + e.message);
    unmarkContactHandled(key);
    pushPendingContact(c);
  }
  showNextContact();
}

export async function declineContactInvite(ctx, c, deps) {
  const { markContactHandled, splicePendingContacts, markDeclinedContact, showNextContact } = deps;
  const key = `${c.sender}|${c.uid}`;
  markContactHandled(key);
  splicePendingContacts();
  try { await markDeclinedContact(key); } catch (e) { /* ignore */ }
  showNextContact();
}

export function showNextContact(ctx, deps) {
  const { clearNextContactTimer, setNextContactTimer, pendingContacts, contactPopupIndex, setContactPopupIndex, setShowContactPopup } = deps;
  clearNextContactTimer();
  if (pendingContacts().length > 0) {
    if (contactPopupIndex() >= pendingContacts().length) setContactPopupIndex(0);
    setNextContactTimer(() => {
      if (pendingContacts().length && !setShowContactPopup()) setShowContactPopup(true);
    }, 1200);
  } else {
    setShowContactPopup(false);
  }
}

// ADR-001 Etap 3c: inviteContactById iz App.vue (отправка инвайта контакту).
// deps-injection: peerKeys/contacts/publicKey — getters; api/uiStore — callable deps.
export async function inviteContactById(ctx, email, deps) {
  const { peerKeys, contacts, loadPeerKeyEmails, sendContactInvite, showToast, t, publicKey } = deps;
  const id = (email || '').trim();
  if (!id) return;
  const low = id.toLowerCase();
  let exists = !!peerKeys()[id] || !!peerKeys()[low];
  if (!exists && Array.isArray(contacts())) {
    exists = contacts().some(c => (c && c.email || '').toLowerCase() === low);
  }
  if (!exists) {
    try {
      exists = [...(await loadPeerKeyEmails())].some(e => e === id || e.toLowerCase() === low);
    } catch (e) { /* disk nedostupen — schitaem novym */ }
  }
  if (exists) {
    showToast((t('already_in_contacts') || 'Kontakt uzhe v spiske') + ': ' + id, 3000);
    return;
  }
  try {
    await sendContactInvite(id, publicKey());
    showToast((t('invite_sent') || 'Priglashenie otpravleno') + ': ' + id, 3000);
  } catch (e) {
    const emsg = (e && e.message) ? e.message : String(e);
    showToast((t('invite_send_failed') || 'Ne udalos otpravit priglashenie: ') + emsg, 5000);
  }
}
