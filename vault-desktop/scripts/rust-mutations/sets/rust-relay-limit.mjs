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
// смены суток, (б) «кого не ограничивать и чем» — квота по тарифу
// (`daily_limit_for_token`: Install/Trial/Paid, канал, легаси-promo v1) и
// ключ издателя (`publisher_key`: токен → IP), (в) конфигурация порога.
// Каждый пункт — дырка, через которую релей либо раздаёт безлимит бесплатно,
// либо режет платящих.
//
// ПАТТЕРНЫ привязаны к форме кода после переезда квот (d12853f): решение
// живёт в двух чистых функциях, а не в ветвлении внутри `relay_pub`.
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
      pattern: '    if let Some(limit) = quota.filter(|l| *l > 0) {',
      replacement: '    if let Some(limit) = quota {' },
    { name: 'безлимитный тариф (Trial) считается по суточному лимиту (промо получает 429)',
      pattern: '            Kind::Test => None,',
      replacement: '            Kind::Test => Some(free_limit),' },
    { name: 'издатели считаются по адресату, а не по отправителю (один забивает очередь всем)',
      pattern: `            return (
                format!("t:{}", t.hash),
                daily_limit_for_token(&t, app.free_daily_limit),
            );`,
      replacement: `            return (
                format!("to:{}", req.to),
                daily_limit_for_token(&t, app.free_daily_limit),
            );` },
    { name: 'анонимный pub без токена не учитывается в лимите',
      pattern: '    (format!("ip:{}", addr.ip()), anon_quota)',
      replacement: '    (format!("ip:{}", addr.ip()), None)' },
    { name: 'канальный write-токен обходит суточный лимит (pub в канал без квоты)',
      pattern: `    if t.scope.is_channel() {
        return Some(free_limit);
    }`,
      replacement: `    if t.scope.is_channel() {
        return None;
    }` },
    { name: 'установочный v2 (Plan::Free) обходит лимит — релей раздаёт безлимит бесплатно',
      pattern: '            Kind::Install => Some(free_limit),',
      replacement: '            Kind::Install => None,' },
    { name: 'тариф игнорируется: Pro резан до бесплатного порога (купивший платит и получает меньше)',
      pattern: '                _ => PRO_DAILY_LIMIT,',
      replacement: '                _ => free_limit,' },
    { name: 'квота Business приравнена к Pro (купок дороже 10 000/сутки не существует)',
      pattern: '                vault_relay::tokens::Plan::Business => BUSINESS_DAILY_LIMIT,',
      replacement: '                vault_relay::tokens::Plan::Business => PRO_DAILY_LIMIT,' },
    { name: 'легаси-promo v1 (год+) внезапно попадает под лимит',
      pattern: '    } else if u64::from(t.expiry) > now() + 365 * 86400 {',
      replacement: '    } else if u64::from(t.expiry) > now() + 3650 * 86400 {' },
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
