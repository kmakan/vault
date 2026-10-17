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
