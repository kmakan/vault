// Набор мутаций: group-meta-broadcast-mut
// Цель: убедиться, что смоук group-meta-broadcast-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'group-meta-broadcast-mut',
  file: 'src/features/group-meta-broadcast.js',
  smoke: 'group-meta-broadcast-smoke.mjs',
  mutations: [
    // Ключ группы не найден — рассылка не уходит (иначе meta-письмо уйдёт
    // открытым текстом).
    { name: "рассылка meta уходит без ключа группы",
      pattern: "  if (!groupKey) return { sent: false, reason: 'no-group-key' };",
      replacement: "  if (false) return { sent: false, reason: 'no-group-key' };" },
    { name: "имя группы в meta не подставляется",
      pattern: "export function buildRenameMetaFields(name, currentAvatar, ts = Date.now()) {",
      replacement: "export function buildRenameMetaFields(name, currentAvatar, ts = Date.now()) {\n  return { name: '', avatar: currentAvatar || '' };" },
  ],
};
