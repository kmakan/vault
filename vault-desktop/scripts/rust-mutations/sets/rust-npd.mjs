// Набор мутаций: rust-npd — чеки самозанятого (НПД) на релее.
//
// ЗАЧЕМ. Автоматика чеков — это налоговая отчётность, а не удобство: ошибка
// здесь либо оставляет продажу БЕЗ чека (штраф и вопросы ФНС), либо создаёт
// ЛИШНИЙ чек (налог с дохода, которого не было), либо ставит в чек неверный
// день (сверка перестаёт находить пару «платёж ↔ чек» и плодит дубли).
// Ни одну из этих поломок не видно «на глаз»: сверка идёт молча по расписанию.
//
// Мутятся три решения:
//   1) московский день и московское время чека (смещение +03:00, не UTC);
//   2) пара «платёж ↔ чек» (равная сумма и один день, один чек на один платёж,
//      уже отправленные не повторяются, тестовые платежи не считаются);
//   3) форма запросов к ЛКФЛ (токен внутри deviceInfo, сумма строкой без
//      потери копейки, пустой content — ошибка, а не «чеков нет»).
export default {
  id: 'rust-npd',
  crate: 'vault-relay',
  pkg: 'vault-relay',
  kind: 'lib',
  file: 'vault-relay/src/npd.rs',
  smoke: 'cargo test -p vault-relay --lib npd::',
  timeoutMs: 600_000,
  mutations: [
    {
      name: 'налоговый день считается по UTC, а не по Москве (чек за 23:30 уезжает накануне)',
      pattern: 'const MSK_OFFSET_MIN: i32 = 180;',
      replacement: 'const MSK_OFFSET_MIN: i32 = 0;',
    },
    {
      name: 'смещение исходной строки не учитывается (московский день по чужому поясу)',
      pattern: '    let msk = absolute + MSK_OFFSET_MIN - offset;',
      replacement: '    let msk = absolute + MSK_OFFSET_MIN;',
    },
    {
      name: 'битая дата принимается как факт (чек с несуществующим днём)',
      pattern: '    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || !(0..=23).contains(&h) || !(0..=59).contains(&min) {\n        return None;\n    }\n    let offset = offset_minutes(iso).unwrap_or(0);',
      replacement: '    let offset = offset_minutes(iso).unwrap_or(0);',
    },
    {
      name: 'время чека без смещения (ЛКФЛ получает чужое местное время)',
      pattern: '    let offset = offset_minutes(iso)?;',
      replacement: '    let offset = offset_minutes(iso).unwrap_or(0);',
    },
    {
      // Округление float-ом на наших суммах даёт тот же текст (проверено:
      // расходятся только значения >2^53 копеек, то есть >90 млрд ₽), поэтому
      // мутация была бы ЭКВИВАЛЕНТНОЙ. Мутируем то, что действительно ломает
      // документ: копейки без ведущего нуля («0.05» → «0.5» — десятикратная
      // сумма в чеке).
      name: 'копейки пишутся без ведущего нуля (0.05 ₽ превращается в 0.5 ₽)',
      pattern: '    format!("{}.{:02}", kopecks / 100, kopecks % 100)',
      replacement: '    format!("{}.{}", kopecks / 100, kopecks % 100)',
    },
    {
      name: 'токен ЛКФЛ кладётся мимо deviceInfo (сервер отвечает 422)',
      pattern: '    serde_json::json!({\n        "refreshToken": refresh_token,\n        "deviceInfo": {',
      replacement: '    serde_json::json!({\n        "refreshToken": refresh_token,\n        "token": refresh_token,\n        "deviceInfo": {',
    },
    {
      name: 'пустой token в ответе авторизации считается успехом (сверка чеков слепая)',
      pattern: '    if token.trim().is_empty() {\n        return Err("npd refresh: пустой token в ответе".to_string());\n    }',
      replacement: '    if false {\n        return Err("npd refresh: пустой token в ответе".to_string());\n    }',
    },
    {
      name: 'отсутствие content считается «чеков нет» (все оплаты уходят в чеки заново)',
      pattern: '        .and_then(|x| x.as_array())\n        .ok_or_else(|| "npd incomes: нет content в ответе".to_string())?;',
      replacement: '        .and_then(|x| x.as_array())\n        .map(|a| a.clone())\n        .unwrap_or_default();',
    },
    {
      name: 'чек без номера попадает в пары (пара «оплата ↔ черновик» закрывает продажу)',
      pattern: '        if uuid.is_empty() {\n            continue; // черновик/отменённый без номера — не чек\n        }',
      replacement: '        if false {\n            continue;\n        }',
    },
    {
      name: 'тестовые платежи считаются продажами (чек на деньги, которых не было)',
      pattern: '.filter(|p| p.paid && p.status == "succeeded" && !p.test)',
      replacement: '.filter(|p| p.paid && p.status == "succeeded")',
    },
    {
      // `p.paid` без проверки статуса — эквивалентная мутация: в платежах
      // «оплачено, но не списано» статус уже отсекает. Мутируем именно
      // статус: `paid: true` + `waiting_for_capture` — это заблокированные
      // деньги, чек на них был бы налогом с чужого дохода.
      name: 'деньги лишь заблокированы (waiting_for_capture) уходят в чеки',
      pattern: '.filter(|p| p.paid && p.status == "succeeded" && !p.test)',
      replacement: '.filter(|p| p.paid && !p.test)',
    },
    {
      name: 'уже отправленный платёж отправляется повторно (второй чек на ту же продажу)',
      pattern: '        if done.contains_key(&p.id) {\n            continue;\n        }',
      replacement: '        if false {\n            continue;\n        }',
    },
    {
      name: 'чек не выбывает из пула (один чек закрывает несколько оплат)',
      pattern: '                    pool.remove(pos);',
      replacement: '                    let _ = pos;',
    },
    {
      name: 'нераспознанная сумма или дата уходит в чеки (неверная сумма в документе)',
      // Комментарий — часть якоря: `_ => {}` в файле не один.
      pattern: '            // отправляем: неверная сумма в чеке хуже отсутствия автоматики.\n            _ => {}',
      replacement:
        '            // отправляем: неверная сумма в чеке хуже отсутствия автоматики.\n            _ => missing.push(p.clone()),',
    },
    {
      name: 'пара по сумме без дня (чек чужого дня закрывает оплату)',
      pattern: '                if let Some(pos) = pool.iter().position(|(pd, pk)| *pd == d && *pk == k) {',
      replacement: '                if let Some(pos) = pool.iter().position(|(_, pk)| *pk == k) {',
    },
    {
      name: 'имя услуги теряет префикс провайдера (в чеке «Vault: Vault pro: 1 мес»)',
      pattern: '        format!("Vault: {}", d.trim_start_matches("Vault ").trim_start_matches("vault "))',
      replacement: '        format!("Vault: {}", d)',
    },
    {
      name: 'пустое описание остаётся пустым (чек без имени услуги)',
      pattern: '    if d.is_empty() {\n        "Доступ к тарифу Pro (Vault)".to_string()',
      replacement: '    if false {\n        "Доступ к тарифу Pro (Vault)".to_string()',
    },
    {
      name: 'нет настроек выглядит как сбой провайдера (код 1 вместо 2 — журнал врёт)',
      pattern: '    if msg.starts_with(NO_SETTINGS) { 2 } else { 1 }',
      replacement: '    if msg.starts_with(NO_SETTINGS) { 1 } else { 1 }',
    },
    {
      name: 'нет настроек считается успехом (молчащий чек выглядит зелёным)',
      pattern: '    if msg.starts_with(NO_SETTINGS) { 2 } else { 1 }',
      replacement: '    if msg.starts_with(NO_SETTINGS) { 0 } else { 1 }',
    },
    {
      name: 'коды перепутаны (сбой провайдера выдаётся за отсутствие настроек)',
      pattern: '    if msg.starts_with(NO_SETTINGS) { 2 } else { 1 }',
      replacement: '    if msg.starts_with(NO_SETTINGS) { 1 } else { 2 }',
    },
  ],
};
