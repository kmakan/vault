// Набор мутаций: group-access — обмен правами с мостом.
//
// Цель: убедиться, что group-access-smoke.mjs ЛОВИТ эти поломки. Здесь нет
// правил «кто админ» — они в мосте (`groups_access`) и в наборе
// `rust-group-rules`. Здесь обмен: что уходит в вызов, что применяется из
// ответа и чего нельзя делать с устаревшим ответом.

export default {
  id: 'group-access-mut',
  file: 'src/features/group-access.js',
  smoke: 'group-access-smoke.mjs',
  mutations: [
    // Устаревший ответ по покинутой группе применяется — права A на группе B.
    { name: 'устаревший ответ применяется (номер запроса не сверяется)',
      pattern: '    if (ticket !== seq || state.groupId !== groupId) return null;',
      replacement: '    if (false) return null;' },
    { name: 'устаревший ответ применяется, но и не возвращается вызывающему',
      pattern: '    if (ticket !== seq || state.groupId !== groupId) return null;',
      replacement: '    if (ticket !== seq || state.groupId !== groupId) return access;' },
    // Ответ вообще не применяется — кнопки не появляются ни у кого.
    { name: 'ответ моста не записывается в состояние',
      pattern: '    state.access = access;',
      replacement: '    state.access = null;' },
    // Обмен: в мост уходят не те аргументы.
    { name: 'группа в вызов не передаётся',
      pattern: "        groupId: groupId || '',",
      replacement: "        groupId: ''," },
    { name: 'свой адрес в вызов не передаётся',
      pattern: "        email: (me && me.email) || '',",
      replacement: "        email: ''," },
    { name: 'свой отпечаток в вызов не передаётся (после смены почты прав нет)',
      pattern: "        fingerprint: String((me && me.fingerprint) || ''),",
      replacement: "        fingerprint: ''," },
    { name: 'алиасы адреса в вызов не передаются (группа со старого адреса — чужая)',
      pattern: '        aliases: (me && me.aliases) || [],',
      replacement: '        aliases: [],' },
    { name: 'идентичность не читается вовсе (пустые аргументы при живых данных)',
      pattern: '    const me = identity();',
      replacement: '    const me = {};' },
    // Смена группы: прежние права видны на новой, пока едет ответ.
    { name: 'права прежней группы не снимаются при переключении',
      pattern: '      state.groupId = groupId;\n      state.access = null;',
      replacement: '      state.groupId = groupId;' },
    // Закрытие: права закрытой группы остаются на экране.
    { name: 'clear оставляет права закрытой группы',
      pattern: '      state.groupId = null;\n      state.access = null;\n    },',
      replacement: '      state.groupId = null;\n    },' },
    // refresh: спрашивает не открытую группу либо без защиты от пустой группы.
    { name: 'refresh спрашивает не ту группу',
      pattern: '      return fetchAccess(state.groupId, identity);',
      replacement: "      return fetchAccess('', identity);" },
    { name: 'refresh без открытой группы ходит в мост',
      pattern: "      if (!state.groupId || typeof identity !== 'function') return Promise.resolve(null);",
      replacement: '      if (!state.groupId) return Promise.resolve(null);' },
    { name: 'select не проверяет, что идентичность — функция',
      pattern: "      if (!groupId || typeof identity !== 'function') return Promise.resolve(null);",
      replacement: '      if (!groupId) return Promise.resolve(null);' },
  ],
};
