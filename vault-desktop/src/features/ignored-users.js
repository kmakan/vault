// Ignore-лист (E2E-блокировка отправителя) — ADR-003 Этап 3, ADR-005 W3.
//
// Логика вынесена из App.vue: правило «кто скрыт у нас» и его хранение —
// не то, что должен делать компонент. Компонент теперь только зовёт.
//
// Хранение: sqlite kv_store, ключ 'ignored-users', в пространстве аккаунта
// (accountNamespace) — иначе список одного аккаунта уезжает другому.
//
// ВАЖНО: правило «заблокирован ли отправитель» (сам email И ВСЕ АЛИАСЫ того же
// peer-ключа) — чистые функции features/contacts.js. Сюда они приходят через
// deps: фича не знает про фичу (ADR-004, гейт feature-import-gate). Здесь
// только хранение и применение: собрать карту, записать, отдать владельцу
// (contactsStore) — обход setIgnored нарушал бы ADR-004 (состояние — у
// владельца, запись в обход него — мимо наблюдателей).
//
// deps (явный контракт, ADR-001 R3):
//   email          — наш адрес (для пространства kv и проверки «это мы сами»)
//   peerKeys       — карта peer-ключей (алиасы того же человека)
//   contactsStore  — владелец ignore-листа
//   db             — kv-хранилище
//   accountNamespace(email) — пространство аккаунта
//   isIgnored / addIgnored / removeIgnored — чистые правила карты
//     (features/contacts.js, приходят через deps)

export async function loadIgnoredUsers(deps) {
  try {
    const raw = await deps.db.kvGet(await deps.accountNamespace(deps.email), 'ignored-users');
    deps.contactsStore.setIgnored(raw ? (JSON.parse(raw) || {}) : {});
  } catch (e) {
    deps.contactsStore.clearIgnored();
  }
}

export async function saveIgnoredUsers(deps) {
  try {
    await deps.db.kvSet(
      await deps.accountNamespace(deps.email),
      'ignored-users',
      JSON.stringify(deps.contactsStore.state.ignoredUsers),
    );
  } catch (e) { /* kv недоступен — список живёт в памяти до перезапуска */ }
}

// Заблокировать отправителя: с этого момента его новые сообщения, звонки и
// уведомления скрыты у получателя. Возвращает false, если email пустой или
// это наш собственный адрес.
export async function ignoreUser(deps, email) {
  const key = String(email || '').toLowerCase().trim();
  if (!key || key === (deps.email || '').toLowerCase()) return false;
  if (!deps.isIgnored(deps.contactsStore.state.ignoredUsers, deps.peerKeys, key)) {
    deps.contactsStore.setIgnored(
      deps.addIgnored(deps.contactsStore.state.ignoredUsers, key, Date.now()),
    );
    await saveIgnoredUsers(deps);
  }
  return true;
}

// Снять блокировку: новые сообщения снова показываются. Прошлое (то, что
// скрылось, пока блок был активен) не возвращается — его не было в истории.
// Снимаем и сам адрес, и алиасы того же ключа.
export async function unignoreUser(deps, email) {
  if (!String(email || '').trim()) return;
  deps.contactsStore.setIgnored(
    deps.removeIgnored(deps.contactsStore.state.ignoredUsers, email, deps.peerKeys),
  );
  await saveIgnoredUsers(deps);
}
