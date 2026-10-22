// Набор мутаций: pro-plan-mut
// Цель: убедиться, что смоук pro-plan-smoke.mjs ЛОВИТ эти поломки.
// Объект: правила экрана платного тарифа Pro (src/features/pro-plan.js).
//
// Почему набор на «денежных» правилах особенно строгий: ошибка здесь двусторонняя —
// можно показать «оплачено» без оплаты или «Free» при оплаченном Pro.

export default {
  id: 'pro-plan-mut',
  file: 'src/features/pro-plan.js',
  smoke: 'pro-plan-smoke.mjs',
  mutations: [
    { name: "истёкший Pro показывается как активный (покупатель зря платит заново)",
      pattern: "    kind = PRO_KIND.EXPIRED;",
      replacement: "    kind = PRO_KIND.ACTIVE;" },
    { name: "пробный период показывается как обычный Pro",
      pattern: "    kind = plan === 'trial' ? PRO_KIND.TRIAL : PRO_KIND.ACTIVE;",
      replacement: "    kind = PRO_KIND.ACTIVE;" },
    { name: "свободный тариф показывается как истёкший Pro",
      pattern: "  if (plan === 'free') {",
      replacement: "  if (false) {" },
    { name: "остаток дней округляется вниз (последний день показывается как «0 дней»)",
      pattern: "  const daysLeft = paidUntil > now ? Math.ceil((paidUntil - now) / 86400) : 0;",
      replacement: "  const daysLeft = paidUntil > now ? Math.floor((paidUntil - now) / 86400) : 0;" },
    { name: "у истёкшего Pro кнопка «Купить» вместо «Продлить»",
      pattern: "  return (view.kind === PRO_KIND.ACTIVE || view.kind === PRO_KIND.EXPIRED)",
      replacement: "  return (view.kind === PRO_KIND.ACTIVE)" },
    { name: "число устройств не показывается (покупатель не видит лимит)",
      pattern: "  if (view.maxDevices) {",
      replacement: "  if (false) {" },
    { name: "причина ошибки теряется (пользователь видит общий текст без деталей)",
      pattern: "  const key = ERROR_TEXTS[error] || 'pro_err_generic';",
      replacement: "  const key = 'pro_err_generic';" },
    { name: "ошибка чекаута игнорируется (покупка идёт дальше без оплаты)",
      pattern: "  if (!res || res.error) {",
      replacement: "  if (false) {" },
    { name: "ошибка верификации игнорируется (клиент считает покупку успешной)",
      pattern: "  if (!v || v.error) {",
      replacement: "  if (false) {" },
    { name: "после покупки состояние не перечитывается (экран остаётся старым)",
      pattern: "  if (deps.refresh) await deps.refresh();",
      replacement: "  void 0;" },
    { name: "бейдж Pro показывается всегда (даже на бесплатном тарифе)",
      pattern: "  if (plan === 'free') return false;",
      replacement: "  if (false) return false;" },
    { name: "локальное состояние читается ДО сервера (возвращается устаревшее «Pro активен»)",
      pattern: "  let info = null;\n  try { info = await deps.info(); } catch (e) { info = null; }\n  let st = null;\n  try { st = await deps.localState(); } catch (e) { st = null; }",
      replacement: "  let st = null;\n  try { st = await deps.localState(); } catch (e) { st = null; }\n  let info = null;\n  try { info = await deps.info(); } catch (e) { info = null; }" },
    { name: "ответ сервера игнорируется (подписка на Free не обновляется)",
      pattern: "  const state = (info && !info.expired) ? { ...(st || {}), ...info, offline: false } : st;",
      replacement: "  const state = st;" },
  ],
};
