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
    // Гейт сканирует ВЫЗОВЫ, а не файл целиком: одно имя стоит в 7 местах, и
    // амбивалентный паттерн мерил ровно одно из них. Ниже — по мутации на
    // сайт; выживет любая → сканер до этого места не дотягивается.
    { name: "событие переименовано в «гонка: remote end» (звонок повиснет в активном)",
      pattern: "          await callNextState(useSession().callState, 'hung_up'));",
      replacement: "          await callNextState(useSession().callState, 'hung_up_x'));" },
    { name: "событие переименовано при позднем remote-конце",
      pattern: "hangup(deps, 'remote_late', await callNextState(useSession().callState, 'hung_up'));",
      replacement: "hangup(deps, 'remote_late', await callNextState(useSession().callState, 'hung_up_x'));" },
    { name: "событие переименовано при сбое call_request",
      pattern: "hangup(deps, 'error', await callNextState(useSession().callState, 'hung_up'));",
      replacement: "hangup(deps, 'error', await callNextState(useSession().callState, 'hung_up_x'));" },
    { name: "событие переименовано при отклонении входящего",
      pattern: "hangup(deps, 'reject', await callNextState(useSession().callState, 'hung_up'));",
      replacement: "hangup(deps, 'reject', await callNextState(useSession().callState, 'hung_up_x'));" },
    { name: "событие переименовано при локальном «завершить»",
      pattern: "hangup(deps, 'end', await callNextState(useSession().callState, 'hung_up'));",
      replacement: "hangup(deps, 'end', await callNextState(useSession().callState, 'hung_up_x'));" },
    { name: "событие переименовано при отмене (reason || 'cancel')",
      pattern: "hangup(deps, reason || 'cancel', await callNextState(useSession().callState, 'hung_up'));",
      replacement: "hangup(deps, reason || 'cancel', await callNextState(useSession().callState, 'hung_up_x'));" },
    { name: "событие переименовано по таймауту соединения",
      pattern: "hangup(deps, 'connect_timeout', await callNextState(useSession().callState, 'hung_up'));",
      replacement: "hangup(deps, 'connect_timeout', await callNextState(useSession().callState, 'hung_up_x'));" },
    { name: 'событие в вызове applyCallState переименовано (переход не применится молча)',
      pattern: "applyCallState('request_received')",
      replacement: "applyCallState('request_received_x')" },
    // Вопрос arm_ring_timer задаётся дважды (первый запуск и уточнение
    // длительности) — каждый сайт проверяется отдельно.
    { name: "вопрос переименован при первом запуске гудка (таймер не ставится)",
      pattern: "    if (!useSession().currentCall) return;\n    if (!(await callCan(useSession().callState, 'arm_ring_timer'))) return;",
      replacement: "    if (!useSession().currentCall) return;\n    if (!(await callCan(useSession().callState, 'arm_ring_timerr'))) return;" },
    { name: "вопрос переименован при уточнении длительности гудка",
      pattern: "  fetchRingDurationMs().then(async (ms) => {\n    if (!(await callCan(useSession().callState, 'arm_ring_timer'))) return;",
      replacement: "  fetchRingDurationMs().then(async (ms) => {\n    if (!(await callCan(useSession().callState, 'arm_ring_timerr'))) return;" },
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
