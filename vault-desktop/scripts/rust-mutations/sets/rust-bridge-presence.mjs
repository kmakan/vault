// Набор мутаций: rust-bridge-presence — реестр присутствия в мосте.
//
// ЗАЧЕМ (t_043d6a21, слепая зона №2 из списка density-гейта). Модуль
// `src-tauri/src/presence.rs` — 186 строк, 3 теста, ни одной закреплённой
// мутации. Три решения реестра (ключ записи, «уже известный» heartbeat, что
// переживает чистку) переехали в ядро и меряются набором `rust-presence`, но
// мост остаётся носителем другого контракта: ГДЕ лежит реестр, что происходит,
// когда файла нет или он битый, и что именно мост обязан передать ядру, а не
// пересчитать сам.
//
// Цена ошибки здесь — ложные сведения о человеке: реестр в чужом каталоге
// пустой («никогда не был онлайн»), heartbeat «ни от кого» заводит запись с
// пустым адресом, а чистка, которая считает удалённое и не сохраняет её,
// оставляет стертым запись ровно до следующего перезапуска.
//
// ЧЕСТНАЯ ГРАНИЦА. Два места сознательно НЕ мутируются:
//   • имя переменной редиректа `VAULT_PRESENCE_FILE` — единственный способ
//     изоляции тестов этого модуля; мутант, меняющий имя, отправляет прогон
//     писать и удалять живой `~/.vault/presence.json` разработчика. Проверяется
//     иначе: тест сверяет форму пути с ЛИТЕРАЛОМ, а редирект — что путь взят из
//     переменной.
//   • повтор правила чистки в мосту (`retain(|h| h.ts >= cutoff_ms)` вместо
//     `survives_prune`) — мутант ценностно эквивалентен, поведение не отличить;
//     это дефект РАЗМЕЩЕНИЯ (ADR-005), его ловит аудит, а не прогон мутаций.
export default {
  id: 'rust-bridge-presence',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/presence.rs',
  smoke: 'cargo test -p vault-desktop --lib presence',
  timeoutMs: 900_000,
  mutations: [
    // ── А. Где лежит реестр ──
    { name: 'файл реестра переименован: после обновления приложение читает пустой реестр',
      pattern: 'const PRESENCE_FILE: &str = "presence.json";',
      replacement: 'const PRESENCE_FILE: &str = "presence-log.json";' },
    { name: 'слой .vault убран: реестр ложится в дом, а не в каталог приложения',
      pattern: '    Ok(home.join(".vault"))',
      replacement: '    Ok(home)' },
    { name: 'родительский каталог не создаётся: первый же heartbeat в новую папку — ошибка',
      pattern: '    if let Some(parent) = path.parent() {\n        fs::create_dir_all(parent)?;\n    }',
      replacement: '    if let Some(parent) = path.parent() {\n        let _ = parent;\n    }' },

    // ── Б. Форма отказа: чего реестр не знает ──
    { name: 'отсутствующий файл стал ошибкой: синхронизация падает у нового пользователя',
      pattern: '    if !path.exists() {\n        return Ok(HashMap::new());\n    }',
      replacement: '    if path.is_dir() {\n        return Ok(HashMap::new());\n    }' },
    { name: 'битый JSON стал ошибкой вместо пустого реестра (fail-open зафиксирован как контракт)',
      pattern: '    Ok(serde_json::from_str(&data).unwrap_or_default())',
      replacement: '    Ok(serde_json::from_str(&data)?)' },
    { name: 'реестр не записан вовсе: всё, что было принято, живёт до перезапуска',
      pattern: '    fs::write(&path, data).map_err(|e| anyhow!("write presence: {}", e))?;',
      replacement: '    let _ = (&path, &data);' },

    // ── В. Мост обязан делегировать, а не пересчитывать ──
    { name: 'форма ключа пересчитана в мосту (своя копия правила вместо ядра)',
      pattern: '    let Some(key) = vault_client::vault::identity::ledger_key(email) else {',
      replacement: '    let Some(key) = Some(email.trim().to_lowercase()) else {' },
    { name: 'heartbeat ни от кого стал ошибкой: тихий отказ превращается в сбой синхронизации',
      pattern: '    let Some(key) = vault_client::vault::identity::ledger_key(email) else {\n        return Ok(());\n    };',
      replacement: '    let Some(key) = vault_client::vault::identity::ledger_key(email) else {\n        return Err(anyhow!("heartbeat без адреса"));\n    };' },
    { name: 'в записи лежит сырой адрес вместо нормального: вторая форма у одного человека',
      pattern: '            email: key,',
      replacement: '            email: email.to_string(),' },

    // ── Г. Дедуп и «последний раз онлайн» ──
    { name: 'дедуп слеп к метке времени: ретранслированный heartbeat позже не виден',
      pattern: '        entry.iter().map(|h| (h.source.as_str(), h.ts)),',
      replacement: '        entry.iter().map(|h| (h.source.as_str(), 0)),' },
    { name: 'последний визит ищется по сырому адресу: регистр адреса теряет реестр',
      pattern: '        .and_then(|k| store.get(k))',
      replacement: '        .and_then(|k| store.get(email))' },

    // ── Д. Чистка ──
    { name: 'единственное удалённое не сохраняется: стёртое возвращается после рестарта',
      pattern: '    if removed > 0 {',
      replacement: '    if removed > 1 {' },
  ],
};
