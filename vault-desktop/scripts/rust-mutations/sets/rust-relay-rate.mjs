// Набор мутаций: rust-relay-rate — токен-ведро publish/poll.
//
// ЗАЧЕМ. Это единственная защита релея от флуда ОДНИМ токеном: 10 rps на
// публикацию и 5 rps на опрос (design §5.4). Ключ ведра — hash токена
// получателя, поэтому анонимный спам не обходит лимит сменой заголовка.
// Если правило разъезжается, релей либо глохнет от одного клиента, либо
// разрешает бесконечную скорость одному токену.
//
// Мутируются обе константы (burst и sustained задаются одним вызовом),
// порог «есть ли хотя бы один токен», потолок пополнения, стартовое
// наполнение ведра, ключ ведра и арифметика пополнения (секунды/доли,
// умножение вместо деления). Опрос не должен получать ведро публикации —
// это отдельная мутация.
//
// Что осталось неизмеримым осознанно: `b.updated = now;`. Ведро пополняется
// от момента ПРОШЛОГО запроса; если его не обновлять, расхождение видно лишь
// на потоке быстрее лимита, да ещё с накоплением за доли миллисекунд — на
// детерминированном тесте это эквивалентный мутант, а не дыра в проверках.
export default {
  id: 'rust-relay-rate',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'lib',
  file: 'vault-relay/src/rate.rs',
  smoke: 'cargo test -p vault-relay --lib rate',
  timeoutMs: 600_000,
  mutations: [
    { name: 'публикация перестаёт ограничиваться (burst 10 превращается в 1000)',
      pattern: '    PUB.get_or_init(|| Limiter::new(10.0, 10.0)).allow(key)',
      replacement: '    PUB.get_or_init(|| Limiter::new(1000.0, 1000.0)).allow(key)' },
    { name: 'опрос перестаёт ограничиваться (burst 5 превращается в 500)',
      pattern: '    POLL.get_or_init(|| Limiter::new(5.0, 5.0)).allow(key)',
      replacement: '    POLL.get_or_init(|| Limiter::new(500.0, 500.0)).allow(key)' },
    { name: 'опрос сидит в ведре публикации (лимит 5 rps перестаёт действовать)',
      pattern: '    POLL.get_or_init(|| Limiter::new(5.0, 5.0)).allow(key)',
      replacement: '    PUB.get_or_init(|| Limiter::new(10.0, 10.0)).allow(key)' },
    { name: 'ведро всегда разрешает (порог «не меньше одного токена» снят)',
      pattern: '        if b.tokens >= 1.0 {',
      replacement: '        if true {' },
    { name: 'потолок ведра снят (пауза превращается в бесконечный залп)',
      pattern: '        b.tokens = (b.tokens + elapsed * rate).min(cap);',
      replacement: '        b.tokens = b.tokens + elapsed * rate;' },
    { name: 'новое ведро пустое (первый же запрос получает 429)',
      pattern: '            tokens: cap,',
      replacement: '            tokens: 0.0,' },
    { name: 'ключ ведра потерян (один токен вычерпывает лимит всех)',
      pattern: '        let b = map.entry(key.to_string()).or_insert(Bucket {',
      replacement: '        let b = map.entry("global".to_string()).or_insert(Bucket {' },
    { name: 'пополнение считает только целые секунды (доли теряются)',
      pattern: '        let elapsed = now.duration_since(b.updated).as_secs_f64();',
      replacement: '        let elapsed = now.duration_since(b.updated).as_secs() as f64;' },
    { name: 'пополнение делит на скорость вместо умножения (лимит вдвое жёстче)',
      pattern: '        b.tokens = (b.tokens + elapsed * rate).min(cap);',
      replacement: '        b.tokens = (b.tokens + elapsed / rate).min(cap);' },
  ],
};
