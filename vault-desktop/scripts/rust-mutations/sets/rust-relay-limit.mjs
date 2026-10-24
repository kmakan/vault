// Набор мутаций: rust-relay-limit — суточный лимит релея на СЕРВЕРЕ.
//
// ЗАЧЕМ. Требование владельца: 100 конвертов/сутки бесплатно, безлимит
// покупается. Клиентское приложение пересобирается самим пользователем,
// поэтому ограничитель обязан жить в релеe: чип транспорта и план во фронте
// выбирают КАНАЛ, но не квоту. Значит проверяем не «фронт показал 100», а
// «сервер отверг 101-й» — и что порог нельзя сдвинуть ни конфигом-мусором,
// ни видом токена.
//
// Класс мутируемого здесь шире обычного: (а) сама арифметика счётчика и
// смены суток, (б) распознавание «кого не ограничивать» (Trial/Pro/Business,
// легаси-promo v1) и (в) конфигурация порога. Каждый пункт — дырка, через
// которую релей либо раздаёт безлимит бесплатно, либо режет платящих.
export default {
  id: 'rust-relay-limit',
  crate: 'vault-relay',
  kind: 'all',
  file: 'vault-relay/src/main.rs',
  smoke: 'cargo test -p vault-relay',
  mutations: [
    { name: 'смена суток не сбрасывает счётчик (лимит становится пожизненным)',
      pattern: '    if entry.0 != day {\n        *entry = (day, 0);\n    }',
      replacement: '    if false {\n        *entry = (day, 0);\n    }' },
    { name: 'порог мягче на один (публикуется limit+1 конверт)',
      pattern: '    if entry.1 >= limit {',
      replacement: '    if entry.1 > limit {' },
    { name: 'первая публикация уже засчитана (расход двойной: 100 → 50)',
      pattern: '.or_insert((day, 0));',
      replacement: '.or_insert((day, 1));' },
    { name: 'публикации не засчитываются вообще (лимита нет, сервер молчит)',
      pattern: '    entry.1 += 1;\n    None',
      replacement: '    None' },
    { name: 'отклонённая публикация тоже засчитывается (429 ускоряют исчерпание)',
      pattern: `    if entry.1 >= limit {
        return Some((day + 1) * 86400 - now);
    }`,
      replacement: `    if entry.1 >= limit {
        entry.1 += 1;
        return Some((day + 1) * 86400 - now);
    }` },
    { name: 'retry_after = «24 часа от запроса» вместо ближайшей полуночи UTC',
      pattern: '        return Some((day + 1) * 86400 - now);',
      replacement: '        return Some(86_400);' },
    { name: 'нулевой порог не выключает лимитер (релей отказывает с первого конверта)',
      pattern: '    if app.free_daily_limit > 0 {',
      replacement: '    if app.free_daily_limit >= 0 {' },
    { name: 'премиум-токен тоже считается по суточному лимиту (платящий получает 429)',
      pattern: '        if !premium {',
      replacement: '        if true {' },
    { name: 'издатели считаются по адресату, а не по отправителю (один забивает очередь всем)',
      pattern: '            return (format!("t:{}", t.hash), premium);',
      replacement: '            return (format!("to:{}", req.to), premium);' },
    { name: 'анонимный pub без токена не учитывается в лимите',
      pattern: '    (format!("ip:{}", addr.ip()), false)',
      replacement: '    (format!("ip:{}", addr.ip()), true)' },
    { name: 'канальный write-токен обходит суточный лимит (pub в канал без квоты)',
      pattern: '            let premium = if t.scope.is_channel() {\n                false',
      replacement: '            let premium = if t.scope.is_channel() {\n                true' },
    { name: 'v2-тариф игнорируется: Trial/Pro/Business урезаны до 100/сутки',
      pattern: '                Kind::of(&t).is_unlimited()',
      replacement: '                false' },
    { name: 'легаси-promo v1 (год+) внезапно попадает под лимит',
      pattern: '                u64::from(t.expiry) > now() + 365 * 86400',
      replacement: '                u64::from(t.expiry) > now() + 3650 * 86400' },
    { name: 'порог по умолчанию другой, чем требование (100 → 50)',
      pattern: 'pub const DEFAULT_FREE_DAILY_LIMIT: u32 = 100;',
      replacement: 'pub const DEFAULT_FREE_DAILY_LIMIT: u32 = 50;' },
    { name: 'опечатка в env-конфиге отключает лимит (мусор = 0, а не дефолт)',
      pattern: '        None => DEFAULT_FREE_DAILY_LIMIT,',
      replacement: '        None => 0,' },
    { name: 'пробелы в env-значении ломают разбор (валидный порог молча слетает)',
      pattern: 'raw.and_then(|s| s.trim().parse::<u32>().ok())',
      replacement: 'raw.and_then(|s| s.parse::<u32>().ok())' },
  ],
};
