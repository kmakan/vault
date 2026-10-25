// Набор мутаций: provider-limits-mut
// Цель: убедиться, что смоук provider-limits-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// РАЗДЕЛКА 25.10: `maxAttachment: 25 * 1024 * 1024, // 25MB` стоит одинаково в
// gmail и в mail.ru — движок бил только gmail, и лимит Mail.ru (реальный
// транспорт писем этого приложения) не был измерен НИЧЕМ. Каждый предел теперь
// заякорен своей warning-строкой, и проверен ряд целиком: 25/20/30/10.

export default {
  id: 'provider-limits-mut',
  file: 'src/providerLimits.js',
  smoke: 'provider-limits-smoke.mjs',
  mutations: [
    { name: "проверка размера строгая на «≥» (ровно лимит отвергается)",
      pattern: "  if (fileSize > limit.maxAttachment) {",
      replacement: "  if (fileSize >= limit.maxAttachment) {" },
    { name: "предел вложения gmail завышен вдвое (письмо отобьёт сервер)",
      pattern: "    maxAttachment: 25 * 1024 * 1024, // 25MB\n    maxTotal: 25 * 1024 * 1024,\n    warning: 'Gmail limits attachments to 25MB',",
      replacement: "    maxAttachment: 50 * 1024 * 1024, // 25MB\n    maxTotal: 25 * 1024 * 1024,\n    warning: 'Gmail limits attachments to 25MB'," },
    { name: "предел вложения mail.ru завышен вдвое (письмо отобьёт сервер)",
      pattern: "    maxAttachment: 25 * 1024 * 1024, // 25MB\n    maxTotal: 25 * 1024 * 1024,\n    warning: 'Mail.ru limits attachments to 25MB',",
      replacement: "    maxAttachment: 50 * 1024 * 1024, // 25MB\n    maxTotal: 25 * 1024 * 1024,\n    warning: 'Mail.ru limits attachments to 25MB'," },
    { name: "предел вложения yandex занижен/завышен (30 МБ — самый щедрый, его терять нельзя)",
      pattern: "    maxAttachment: 30 * 1024 * 1024, // 30MB",
      replacement: "    maxAttachment: 60 * 1024 * 1024, // 30MB" },
    { name: "консервативный default для неизвестного провайдера поднят (отправит заведомо отбитое письмо)",
      pattern: "    maxAttachment: 10 * 1024 * 1024, // 10MB conservative default",
      replacement: "    maxAttachment: 20 * 1024 * 1024, // 10MB conservative default" },
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
