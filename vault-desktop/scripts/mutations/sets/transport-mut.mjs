// Набор мутаций: transport-mut
// Цель: убедиться, что transport-smoke.mjs ЛОВИТ поломки проводки чипа
// транспорта. Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// Здесь мутируется ТОЛЬКО проводка фронта (правило плана и цикл живут в Rust и
// меряются набором rust-transport).

export default {
  id: 'transport-mut',
  file: 'src/features/transport.js',
  smoke: 'transport-smoke.mjs',
  mutations: [
    { name: 'релей показывается иконкой письма (пользователь не видит, что выбрал)',
      pattern: "  relay: { icon: 'globe', titleKey: 'transport_relay' },",
      replacement: "  relay: { icon: 'send', titleKey: 'transport_auto' }," },
    { name: 'неизвестное значение не приводится к авто (чип падает на пустой подписи)',
      pattern: '  return VIEW[preference] || VIEW.auto;',
      replacement: '  return VIEW[preference];' },
    { name: 'null-ответ моста переписывает состояние (реальный выбор теряется)',
      pattern: '  if (value !== null) deps.setTransportPreference(value);',
      replacement: '  deps.setTransportPreference(value);' },
    { name: 'чтение идёт на чужой адрес (настройка второго аккаунта)',
      pattern: '  const value = await api.transportPreference(myEmail());',
      replacement: "  const value = await api.transportPreference('anon');" },
    { name: 'запись идёт на чужой адрес (клик правит не того пользователя)',
      pattern: '  const value = await api.transportPreferenceNext(myEmail());',
      replacement: "  const value = await api.transportPreferenceNext('anon');" },
    { name: 'сбой моста не различается (выбор меняется на null)',
      pattern: '  if (value === null) return null;',
      replacement: '  void 0;' },
    { name: 'клик не обновляет интерфейс (чип остаётся со старым значком)',
      pattern: "  deps.setTransportPreference(value);\n  if (deps.showToast) {",
      replacement: "  deps.setTransportPreference('auto');\n  if (deps.showToast) {" },
    { name: 'клик не сообщает новый выбор (подпись отстаёт от действия)',
      pattern: '    deps.showToast(deps.t ? deps.t(transportView(value).titleKey) : value, 2200);',
      replacement: '    void 0;' },
    { name: 'подпись клика берётся от старого выбора (авто вместо релей)',
      pattern: 'deps.showToast(deps.t ? deps.t(transportView(value).titleKey) : value, 2200);',
      replacement: "deps.showToast(deps.t ? deps.t(transportView('auto').titleKey) : value, 2200);" },
    { name: 'чтение не возвращает значение (проверяющий не видит, что прочитано)',
      pattern: '  return value;\n}\n\n// Клик по чипу',
      replacement: '  return null;\n}\n\n// Клик по чипу' },
  ],
};
