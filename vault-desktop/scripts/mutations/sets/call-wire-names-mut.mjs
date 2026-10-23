// Набор мутаций: call-wire-names-mut.
//
// Цель: доказать, что `scripts/call-wire-names-gate.mjs` НЕ декоративный.
// Гейт сверяет литералы в фичах со словарём `vault-client/tests/fixtures/
// call-wire-names.json` (сам словарь держит Rust-тест «ядро ↔ фикстура»).
// Поэтому набор бьёт с ОБЕИХ сторон границы:
//   * имя в JS переименовано на букву — ядро такое имя молча не узнает;
//   * имя в словаре ядра переименовано — JS присылает прежнее слово;
//   * в словаре появился дубль — таблица ответов слила бы два вопроса.
//
// Если хоть одна мутация выживет, гейт ничего не проверяет: вернуть его в
// набор — значит оставить границу без защиты (ровно этот класс дефекта:
// «понятное JS слово, которое ядро silently игнорирует»).

const FIXTURE = '../vault-client/tests/fixtures/call-wire-names.json';

export default {
  id: 'call-wire-names-mut',
  file: 'src/features/calls.js',
  smoke: 'call-wire-names-gate.mjs',
  mutations: [
    { name: 'событие в JS переименовано (ядро вернёт текущее состояние — звонок зависнет)',
      pattern: ", 'hung_up')",
      replacement: ", 'hung_up_x')" },
    { name: 'событие в вызове applyCallState переименовано (переход не применится молча)',
      pattern: "applyCallState('request_received')",
      replacement: "applyCallState('request_received_x')" },
    { name: 'вопрос в JS переименован (ядро ответит false — действие не произойдёт)',
      pattern: "'arm_ring_timer'",
      replacement: "'arm_ring_timerr'" },
    { name: 'вопрос в синхронном кэше переименован (решение читается как «нельзя»)',
      pattern: "canCached(useSession().callState, 'call_active')",
      replacement: "canCached(useSession().callState, 'call_activ')" },
    { name: 'ядро печатает событие иначе — JS шлёт прежнее слово',
      file: FIXTURE,
      pattern: '"hung_up"',
      replacement: '"hung_upp"' },
    { name: 'ядро печатает вопрос иначе — JS шлёт прежнее слово',
      file: FIXTURE,
      pattern: '"apply_sdp"',
      replacement: '"apply_sdpp"' },
    { name: 'в словаре ядра два имени слились в одно (вопросы неразличимы)',
      file: FIXTURE,
      pattern: '"ring_timeout"',
      replacement: '"hung_up"' },
  ],
};
