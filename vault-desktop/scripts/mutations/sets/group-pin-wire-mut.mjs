// Набор мутаций: group-pin-wire-mut
// Цель: убедиться, что смоук group-pin-wire-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'group-pin-wire-mut',
  file: 'src/features/group-pin-wire.js',
  smoke: 'group-pin-wire-smoke.mjs',
  mutations: [
    { name: "действие «открепить» не вычисляется",
      pattern: "export function buildPinDecision(msg, currentlyPinned, ts = Date.now()) {",
      replacement: "export function buildPinDecision(msg, currentlyPinned, ts = Date.now()) {\n  return { action: 'pin', msg_id: msg.id };" },
    { name: "форма pin-письма теряет действие",
      pattern: "export function buildPinWirePayload(decision) {",
      replacement: "export function buildPinWirePayload(decision) {\n  return { version: PIN_WIRE_VERSION };" },
    { name: "разбор pin-письма принимает что угодно",
      pattern: "export function parsePinWire(obj, fallbackTs = 0) {",
      replacement: "export function parsePinWire(obj, fallbackTs = 0) {\n  return { msg_id: 'x', ts: fallbackTs };" },
    { name: "превью закрепления не обрезается",
      pattern: "export const PIN_PREVIEW_MAX = 140;",
      replacement: "export const PIN_PREVIEW_MAX = 100000;" },
  ],
};
