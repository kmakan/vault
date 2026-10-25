// ЗАЧЕМ. `email.rs::next_connect_deadline` — единственное место моста, где
// ядровое правило лестницы backoff (`vault_client::vault::backoff::plan_pause`,
// измерена набором `rust-backoff`) превращается в `Instant`. Само ядро не знает
// про часы: оно отвечает на вопрос «сколько ждать», а мост решает, КОМУ верить,
// когда пауза уже назначена. Здесь ровно то место, где случился livelock №2
// (телефон X50, 04.10.2026, 0.1.210): серия неудач каждые ~3 мс передвигала
// дедлайн, пауза не истекала НИКОГДА, 32 «reconnect deferred» за 40 с при
// streak=492 и ноль успешных подключений.
//
// ПОДСТАВЛЯЕМ ЧАСЫ. Функция чистая и принимает `now`, поэтому пробы ставят
// искусственное время и сверяют и остаток, и сам момент: «дедлайн не
// передвинулся» и «остаток = исходная пауза» — разные утверждения, и мутант,
// портящий одно из них, обязан быть виден второму. Первый прогон набора это и
// показал: регресс-тест livelock'а сверял ТОЛЬКО момент (`let (new_deadline, _) = …`),
// поэтому три мутации остатка выжили. Плюс обратная разность `now - t` здесь не
// паникует, а молча даёт `0ns` — «проверка на глаз» («так же точно упадёт»)
// оказалась неверной, мерить надо значением.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (не измеримо в изоляции, а не «забыто»):
//   * `saturating_add(1)` в `note_failure` — переполнение требует 4 млрд неудач,
//     наблюдать насыщение в тесте невозможно; это свойство, а не ветвление.
//   * сам момент `Instant::now()` в `note_failure` — wall-часы тесту не
//     подставляются. Проводка аргументов измеряется двояко: чистые пробы на
//     подставных часах и проба на живом `EmailClient` с ПОДСТАВЛЕННЫМ дедлайном
//     (остаток ~60 с против ступени streak=3 → 15 с), чтобы допуск по времени
//     был секундами, а не наносекундами: проба, которая краснеет от того, что
//     машина подумала лишнюю секунду, в мутированном дереву прогоне сама
//     становится источником ложных «поймано».
//     Перестановка аргументов местами не компилируется (u32 против
//     `Option<Instant>`), поэтому отдельной мутацией её не ловят.
//   * `(Some(now + pause), pause)` в ветке активной паузы — ЭКВИВАЛЕНТНЫЙ
//     мутант: в этой ветке `pause == deadline - now`, поэтому `now + pause` это
//     ровно `deadline`. Такие мутации — дефект набора, ниже стоит их
//     невырожденный вариант (продление на собственный остаток).
export default {
  id: 'rust-bridge-connect-deadline',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/email.rs',
  smoke: 'cargo test -p vault-desktop --lib connect_deadline',
  timeoutMs: 900_000,
  mutations: [
    { name: 'истёкшая пауза считается активной (на границе now == deadline)',
      pattern: 'let active = deadline.filter(|t| *t > now).map(|t| t - now);',
      replacement: 'let active = deadline.filter(|t| *t >= now).map(|t| t - now);' },
    { name: 'пауза считается активной всегда (истечения не бывает)',
      pattern: 'let active = deadline.filter(|t| *t > now).map(|t| t - now);',
      replacement: 'let active = deadline.map(|t| t - now);' },
    { name: 'остаток считается от now к deadline (обратная разность)',
      pattern: 'let active = deadline.filter(|t| *t > now).map(|t| t - now);',
      replacement: 'let active = deadline.filter(|t| *t > now).map(|t| now - t);' },
    { name: 'остаток не вычитается: полная ступень вместо остатка',
      pattern: '.map(|t| t - now);',
      replacement: '.map(|t| backoff::delay_for_streak(1));' },
    { name: 'активная пауза продлевается на свой остаток (тот самый livelock X50)',
      pattern: '        Some(_) => (deadline, pause),',
      replacement: '        Some(_) => (Some(deadline.unwrap() + pause), pause),' },
    { name: 'активная пауза сбрасывается (серия начинает ступень заново)',
      pattern: '        Some(_) => (deadline, pause),',
      replacement: '        Some(_) => (None, pause),' },
    { name: 'первая неудача не назначает дедлайн (пауза есть, момента нет)',
      pattern: '        None => (Some(now + pause), pause),',
      replacement: '        None => (deadline, pause),' },
    { name: 'истёкшая пауза не назначается заново (дедлайн остаётся в прошлом)',
      pattern: '        None => (Some(now + pause), pause),',
      replacement: '        None => (Some(now), pause),' },
    { name: 'активная пауза игнорируется: ступень считается по streak',
      pattern: '    let pause = backoff::plan_pause(fail_streak, active);',
      replacement: '    let pause = backoff::delay_for_streak(fail_streak);' },
    { name: 'ядро спрашивается не о той серии (pause всегда плато)',
      pattern: '    let pause = backoff::plan_pause(fail_streak, active);',
      replacement: '    let pause = backoff::plan_pause(u32::MAX, active);' },
  ],
};
