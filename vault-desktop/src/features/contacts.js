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
