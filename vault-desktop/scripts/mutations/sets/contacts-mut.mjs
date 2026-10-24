// Набор мутаций: contacts-mut
// Цель: убедиться, что смоук contacts-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'contacts-mut',
  file: 'src/features/contacts.js',
  smoke: 'contacts-smoke.mjs',
  mutations: [
    { name: "блокировка по адресу не проверяется",
      pattern: "  if (ignoredUsers[key]) return true;",
      replacement: "  if (false) return true;" },
    { name: "блокировка по peer-ключу (алиасу после смены почты) не проверяется",
      pattern: "    if (peerKeys[k] === pk) return true;",
      replacement: "    void 0;" },
    { name: "блокировка пишется в исходную карту (мутация аргумента)",
      pattern: "  const out = { ...(ignoredUsers || {}) };",
      replacement: "  const out = ignoredUsers || {};" },
    { name: "снятие блокировки не снимает алиасы по ключу",
      pattern: "    if (k === key || (pk && peerKeys[k] === pk)) continue;",
      replacement: "    if (k === key) continue;" },
    { name: "свои письма не распознаются по алиасам",
      pattern: "  return aliasesOf(email).some(a => s.includes(a.toLowerCase()));",
      replacement: "  return s.includes(String(email).toLowerCase());" },
    { name: "поиск пира по ключу находит и отправителя самого",
      pattern: "    if (peerKeys[k] === envKey && String(k).toLowerCase() !== senderNorm) return k;",
      replacement: "    if (peerKeys[k] === envKey) return k;" },
    { name: "исходящее письмо не распознаётся",
      pattern: "  return aliases.some(a => from.includes(a.toLowerCase()));",
      replacement: "  return false;" },
    { name: "шифрование для пира разрешено без ключа",
      pattern: "  return !!cryptoReady && !!peerKeys && !!peerKeys[activeChat];",
      replacement: "  return !!cryptoReady;" },
    // accept-приглашение: запись ключа (ADR-005 партия 5e — свой аккаунт
    // возвращался в контакты именно на этом пути).
    { name: "своя почта не уходит в запись ключа (OWN-ADDRESS GUARD выключен)",
      pattern: "    await savePeerKey(c.sender, c.public_key, c.sender_name || null, c.pq_public_key || undefined, email());",
      replacement: "    await savePeerKey(c.sender, c.public_key, c.sender_name || null, c.pq_public_key || undefined);" },
    { name: "уже известный ключ записывается снова (старое accept-письмо воскрешает удалённый контакт)",
      pattern: "    if (exists) {",
      replacement: "    if (false) {" },
  ],
};
