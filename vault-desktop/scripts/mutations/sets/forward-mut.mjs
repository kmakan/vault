// Набор мутаций: forward-mut
// Цель: убедиться, что смоук forward-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'forward-mut',
  file: 'src/features/forward.js',
  smoke: 'forward-smoke.mjs',
  mutations: [
    { name: "цель пересылки не выбирается",
      pattern: "export function startForward({ setForwardTo }, msg) {",
      replacement: "export function startForward({ setForwardTo }, msg) {\n  setForwardTo(null); return;" },
    { name: "пересылка уходит в пустоту (без получателя)",
      pattern: "export function forwardTargets({ contacts, groups, activeChat, activeChatType, currentGroup, nameOf, t }) {",
      replacement: "export function forwardTargets({ contacts, groups, activeChat, activeChatType, currentGroup, nameOf, t }) {\n  return [];" },
  ],
};
