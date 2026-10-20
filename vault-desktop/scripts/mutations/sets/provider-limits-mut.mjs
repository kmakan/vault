// Набор мутаций: provider-limits-mut
// Цель: убедиться, что смоук provider-limits-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'provider-limits-mut',
  file: 'src/providerLimits.js',
  smoke: 'provider-limits-smoke.mjs',
  mutations: [
    { name: "проверка размера строгая на «≥» (ровно лимит отвергается)",
      pattern: "  if (fileSize > limit.maxAttachment) {",
      replacement: "  if (fileSize >= limit.maxAttachment) {" },
    { name: "предел вложения завышен вдвое (письмо отобьёт сервер)",
      pattern: "    maxAttachment: 25 * 1024 * 1024, // 25MB",
      replacement: "    maxAttachment: 50 * 1024 * 1024, // 25MB" },
    { name: "googlemail перестал считаться gmail",
      pattern: "  if (domain.includes('gmail') || domain.includes('googlemail')) return 'gmail'",
      replacement: "  if (domain.includes('gmail')) return 'gmail'" },
    { name: "hotmail/live перестали считаться outlook",
      pattern: "  if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live')) return 'outlook'",
      replacement: "  if (domain.includes('outlook')) return 'outlook'" },
    { name: "list.ru перестал считаться mail.ru",
      pattern: "  if (domain.includes('mail.ru') || domain.includes('list.ru')) return 'mailru'",
      replacement: "  if (domain.includes('mail.ru')) return 'mailru'" },
    { name: "неизвестный провайдер получает лимит gmail вместо консервативного",
      pattern: "  return providerLimits[providerId] || providerLimits.custom",
      replacement: "  return providerLimits[providerId] || providerLimits.gmail" },
    { name: "формат мегабайт без дробной части (0.1 МБ теряется)",
      pattern: "  return (bytes / 1048576).toFixed(1) + ' MB'",
      replacement: "  return Math.floor(bytes / 1048576) + ' MB'" },
    { name: "предупреждение о 80% не выдаётся (пользователь узнаёт об отказе только от сервера)",
      pattern: "  if (fileSize > limit.maxAttachment * 0.8) {",
      replacement: "  if (false) {" },
  ],
};
