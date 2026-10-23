// Набор мутаций: rust-backoff — лестница переподключения почты.
//
// ЗАЧЕМ. Арифметика паузы уже дважды уводила клиент в livelock (телефон X50,
// 04.10.2026, 0.1.210): «now + delay» на каждой неудаче — дедлайн двигается
// вечно, сессия не строится; и обратное — плато вместо роста. Тесты моста
// ловят это по часам (`Instant`), но сами часы во мосте, а решение — здесь, и
// без мутаций нельзя сказать, что тест чего-то стоит.
export default {
  id: 'rust-backoff',
  file: 'vault-client/src/vault/backoff.rs',
  smoke: 'cargo test -p vault-client --lib',
  mutations: [
    { name: 'лестница не растёт: все ступени по 2с (шторм подключений к провайдеру)',
      pattern: 'pub const STEPS_SEC: [u64; 5] = [2, 5, 15, 30, 60];',
      replacement: 'pub const STEPS_SEC: [u64; 5] = [2, 2, 2, 2, 2];' },
    { name: 'ступень не ограничена сверху (индекс за пределами таблицы на длинной серии)',
      pattern: '    let idx = (fail_streak.saturating_sub(1) as usize).min(STEPS_SEC.len() - 1);',
      replacement: '    let idx = fail_streak.saturating_sub(1) as usize;' },
    { name: 'активная пауза передвигается каждой новой неудачей (livelock: пауза не истекает никогда)',
      pattern: '        Some(remaining) => remaining,',
      replacement: '        Some(_) => delay_for_streak(fail_streak),' },
    { name: 'после истечения паузы ждать нечего (reconnect-шторм вместо паузы)',
      pattern: '        None => delay_for_streak(fail_streak),',
      replacement: '        None => Duration::from_secs(0),' },
    { name: 'счётчик неудач игнорируется: всегда первая ступень (60с плато недостижимо)',
      pattern: '    let idx = (fail_streak.saturating_sub(1) as usize).min(STEPS_SEC.len() - 1);',
      replacement: '    let idx = 0usize.min(STEPS_SEC.len() - 1);' },
  ],
};
