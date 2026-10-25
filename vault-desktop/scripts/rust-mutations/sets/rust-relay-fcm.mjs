// Набор мутаций: FCM-отправитель «будильника» (vault-relay/src/fcm.rs).
//
// ЗАЧЕМ. FCM — вторая линия доставки (вместо ntfy) и одновременно путь, где
// живут единственные внешние контракты релея: тело messages:send, алфавит и
// форма OAuth2-assertion, время жизни кэша токена. Всё это решается строкой,
// и каждая снятая строка не ломает сборку и не ломает логику «в тестах без
// сети» — она ломает только живую доставку. Последняя дыра ратчета плотности
// релея (t_a134786c): модуль 573 строк, 14 тестов, мутационной мерки не было.
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (проверено чтением кода, 25.10):
//   * сетевые ветки (`!status.is_success()`, map_err по send/text) — в юнит-
//     тестов нет сервера Google, поведение недостижимо: мутировать «Err вместо
//     Ok» означало бы писать тест под мутант, а не мерить решение;
//   * `HTTP_TIMEOUT` (10с) и `JWT_TTL_SECS` как величина — ни один тест не
//     сравнивает число с требованием Google (exp ≤ 1ч), поэтому любая замена
//     числа выживет: это честная незамечаемая часть, а не покрытие;
//   * `from_env` — решение «дефолтного пути нет намеренно» при снятии ветки
//     даёт тот же None (чтение "" падает на Err), то есть эквивалентный мутант;
//   * отсутствие `notification` в теле — снимается удалением строки, а её
//     здесь нет; мутация «добавь блок» не выражается парой pattern/replacement.
export default {
  id: 'rust-relay-fcm',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'lib',
  file: 'vault-relay/src/fcm.rs',
  smoke: 'cargo test -p vault-relay --lib fcm',
  timeoutMs: 600_000,
  mutations: [
    // ── тело messages:send: контракт с FCM, а не с нашим клиентом ──
    { name: 'имя отправителя уходит под зарезервированным ключом from (FCM отвечает 400)',
      pattern: '                    "sender": self.from,',
      replacement: '                    "from": self.from,' },
    { name: 'приоритет не high — пуш приходит после дорманта',
      pattern: '                "android": { "priority": "high" },',
      replacement: '                "android": { "priority": "normal" },' },
    { name: 'срочность инвертирована (боевой звонок тихий, обычный — сирена)',
      pattern: '                    "urgent": if self.urgent { "1" } else { "0" },',
      replacement: '                    "urgent": if self.urgent { "0" } else { "1" },' },
    { name: 'адресат теряется: токен устройства едет под другим полем',
      pattern: '                "token": reg_token,',
      replacement: '                "topic": reg_token,' },
    { name: 'тип события захардкожен — message не отличить от входящего звонка',
      pattern: '                    "type": self.kind,',
      replacement: '                    "type": "call_request",' },
    // ── service-account: что мы вообще читаем из ключа ──
    { name: 'обязательные поля не проверяются (пустой project_id уезжает в URL)',
      pattern: '        if kf.project_id.trim().is_empty()\n            || kf.client_email.trim().is_empty()\n            || kf.private_key.trim().is_empty()\n        {',
      replacement: '        if false {' },
    { name: 'camelCase-алиас project_id снят (ключ из Firebase Console не читается)',
      pattern: '    #[serde(alias = "projectId")]',
      replacement: '    #[serde(alias = "projectIdX")]' },
    { name: 'camelCase-алиас client_email снят',
      pattern: '    #[serde(alias = "clientEmail")]',
      replacement: '    #[serde(alias = "clientEmailX")]' },
    { name: 'camelCase-алиас private_key снят',
      pattern: '    #[serde(alias = "privateKey")]',
      replacement: '    #[serde(alias = "privateKeyX")]' },
    // ── JWT-assertion и кэш токена ──
    { name: 'exp = iat (Google отвергает assertion, либо токен «вечный»)',
      pattern: '            "exp": iat + JWT_TTL_SECS,',
      replacement: '            "exp": iat,' },
    { name: 'время жизни кэша = 0 (каждый пуш — новый обмен с Google)',
      pattern: 'const TOKEN_TTL: Duration = Duration::from_secs(55 * 60);',
      replacement: 'const TOKEN_TTL: Duration = Duration::from_secs(0);' },
    { name: 'свежесть кэша проверена наоборот (свежий токен считается протухшим)',
      pattern: '            .filter(|t| Instant::now() < t.fresh_until)',
      replacement: '            .filter(|t| Instant::now() > t.fresh_until)' },
    { name: 'при сохранении кэш ставится в тот же миг (тлен сразу)',
      pattern: '                fresh_until: Instant::now() + TOKEN_TTL,',
      replacement: '                fresh_until: Instant::now(),' },
    // ── диагностика: секрет не должен попасть в лог целым куском ──
    { name: 'ответ Google не обрезается (тело ошибки целиком уходит в лог)',
      pattern: '    let t = s.trim();',
      replacement: '    let t = s;' },
    { name: 'срез идёт без поиска границы символа (panic на UTF-8 в ответе)',
      pattern: '    while end > 0 && !t.is_char_boundary(end) {\n        end -= 1;\n    }',
      replacement: '    if end > t.len() {\n        end = t.len();\n    }' },
    // ── форма x-www-form-urlencoded: что можно оставлять открытым ──
    { name: 'двоеточие не экранируется (grant_type рассыпается в форме)',
      pattern: "            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {",
      replacement: "            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' => {" },
    { name: 'hex-расширение строчными буквами (Google читает %3a как другой символ)',
      pattern: '            other => out.push_str(&format!("%{other:02X}")),',
      replacement: '            other => out.push_str(&format!("%{other:02x}")),' },
  ],
};
