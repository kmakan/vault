// Набор мутаций: relay-pro-mut
// Цель: убедиться, что смоук relay-pro-smoke.mjs ЛОВИТ эти поломки.
// Объект: клиентская часть платных токенов (src/relay-client.js).
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'relay-pro-mut',
  file: 'src/relay-client.js',
  smoke: 'relay-pro-smoke.mjs',
  mutations: [
    { name: "офлайн-грейс не наступает (Pro вечен даже после истечения оплаты)",
      pattern: "  const offline = now <= graceEnd;",
      replacement: "  const offline = true;" },
    { name: "план Pro не восстанавливается из сохранённого состояния",
      pattern: "    plan: offline ? (st.plan || 'pro') : 'free',",
      replacement: "    plan: 'free'," },
    { name: "клиентское время считается по системным часам (перевод часов продлевает грейс)",
      pattern: "      return Math.floor((performance.timeOrigin + performance.now()) / 1000);",
      replacement: "      return Math.floor(Date.now() / 1000);" },
    { name: "покупка не отправляет fingerprint (релей не узнает, кто платит)",
      pattern: "      body: JSON.stringify({ plan, months, fp, lang: 'ru' }),",
      replacement: "      body: JSON.stringify({ plan, months, lang: 'ru' })," },
    { name: "токен после оплаты не активируется на устройстве (лимит устройств не считается)",
      pattern: "      const act = await activateToken(account, body.token);",
      replacement: "      const act = { bound: true };" },
    { name: "токен после оплаты не пишется в relay-list (клиент остаётся без адреса)",
      pattern: "      await setOurToken(account, url, body.token);",
      replacement: "      void 0;" },
    { name: "истёкшая подписка не сбрасывается в free (клиент считает себя Pro)",
      pattern: "      await saveProState(account, { plan: 'free', paid_until: 0 });",
      replacement: "      void 0;" },
    { name: "число устройств не сохраняется (экран не показывает лимит устройств)",
      pattern: "    devices: state.devices || 0,",
      replacement: "    devices: 0," },
    { name: "суточный расход не сохраняется (экран не показывает остаток конвертов)",
      pattern: "    daily_used: state.daily_used || 0,",
      replacement: "    daily_used: 0," },
    { name: "серверная граница грейса не сохраняется (клиент доверяет только своему счёту)",
      pattern: "    grace_until: state.grace_until || 0,",
      replacement: "    grace_until: 0," },
  ],
};
