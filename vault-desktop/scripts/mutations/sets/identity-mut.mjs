// Набор мутаций: identity-mut
// Цель: убедиться, что смоук identity-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'identity-mut',
  file: 'src/identity.js',
  smoke: 'identity-smoke.mjs',
  mutations: [
    { name: "резолвер не fail-open (сбой команды блокирует вход)",
      pattern: "    ns = em;\n  }\n  _accountNs = ns;",
      replacement: "    throw e;\n  }\n  _accountNs = ns;" },
    { name: "кэш не привязан к значению ключа (namespace не пересчитается после входа по мнемонике)",
      pattern: "  if (_accountNs !== null && _accountNsFor === em && _cachedFpKey === pk) return _accountNs;",
      replacement: "  if (_accountNs !== null && _accountNsFor === em) return _accountNs;" },
    { name: "смена почты не пересчитывает namespace",
      pattern: "  if (_accountNs !== null && _accountNsFor === em && _cachedFpKey === pk) return _accountNs;",
      replacement: "  if (_accountNs !== null) return _accountNs;" },
    { name: "email не нормализуется (кэш раздваивается по регистру)",
      pattern: "  const em = String(email || '').trim().toLowerCase();",
      replacement: "  const em = String(email || '').trim();" },
    { name: "перенос legacy-строк выполняется каждый раз (не один раз на пару)",
      pattern: "  if (_nsMigrated || !ns.startsWith('fp:') || !em || em === ns) return ns;",
      replacement: "  if (!ns.startsWith('fp:') || !em || em === ns) return ns;" },

  ],
};
