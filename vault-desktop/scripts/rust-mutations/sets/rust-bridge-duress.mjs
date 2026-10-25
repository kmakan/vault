// ЗАЧЕМ. Очередь моста `t_61bd5090`, пункт 10 (диагностика SOS-цепочки на
// устройстве, 25.10). `duress.rs` был полностью слепой зоной: правило сборки
// текста SOS жило ВНУТРИ `#[cfg(target_os = "android")]` JNI-обёртки, значит с
// хоста до него нельзя было достать ни одной проверкой, а чтение/запись конфига
// замка шли через `Storage::open(None)` — живую БД разработчика.
//
// Что теперь измеримо:
//   * `compose_sos_text` — вынесено из обёртки (25.10). Ошибка в нём — это
//     письмо без текста или без места, где человек находится;
//   * `load_config`/`save_config` — после тестового редиректа
//     `VAULT_TEST_DB_FILE` (`storage/sqlite.rs::default_db_path`). Адрес строки
//     ('anon','duress-config') — общий контракт с Kotlin-замком и JS-фронтом:
//     перепутать аккаунт или ключ значит «замок настроен, но не читается».
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (не измеримо, а не «забыто»):
//   * ЭКВИВАЛЕНТНЫЙ мутант, найденный прогоном: хвост правила делал
//     `replace("{coords}", "")` на ветке, куда текст с плейсхолдером прийти уже
//     не может (её закрыла ветка выше). «Убрать replace» выжил 13/14 — не
//     потому, что проверка плохая, а потому, что на достижимом входе мутант
//     тождествен оригиналу. Правка сама в коде: хвост возвращает текст как
//     есть, а вместо мёртвой мутации стоит «хвост теряет текст письма».
//   * JNI-обёртки (`nativeSendDuressSos`, `nativeVerifyPin`, `sync_prefs_android`,
//     `nativePanicWipe`) — под `cfg(target_os = "android")`, с хоста не
//     вызываются; их проверяет приёмка на устройстве;
//   * ветка `Err(_) => DuressConfig::default()` в `load_config` — при открытом
//     тестовом редиректе `Storage::open` не падает, мутант выживал бы всегда;
//   * `wipe_all_data` (порядок стирания) — на хосте трогает живые каталоги
//     ключей/кредов, проверяется только на тестовом устройстве;
//   * `hash_secret`/`verify_secret` — протокол замка, измерен в ядре.
//
// ИМЕНА ПРОБ (смоук `duress` обязан собрать все десять; живость фильтра с 25.10
// меряет `npm run gate:rust-smokes`, но вердикт по-прежнему даёт весь
// либ-прогон):
//   duress_config_round_trips_through_the_anon_row
//   second_save_replaces_the_first_config_whole
//   absent_config_row_reads_as_disabled_lock
//   broken_config_json_currently_fails_open_to_default
//   partial_config_json_fills_absent_fields_with_defaults
//   sos_text_drops_the_placeholder_without_coordinates
//   sos_text_puts_coordinates_at_the_placeholder
//   sos_text_appends_coordinates_when_flag_is_on_and_placeholder_is_absent
//   sos_text_keeps_the_text_alone_when_geo_flag_is_off
//   sos_text_without_placeholder_and_without_coordinates_stays_untouched

export default {
  id: 'rust-bridge-duress',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/duress.rs',
  smoke: 'cargo test -p vault-desktop --lib duress',
  timeoutMs: 900_000,
  mutations: [
    // ── compose_sos_text: правило подстановки координат ──
    { name: 'координаты считаются отсутствующими, когда они есть (SOS без места)',
      pattern: `    if geo.is_empty() {
        return cfg.sos_text.replace("{coords}", "");`,
      replacement: `    if !geo.is_empty() {
        return cfg.sos_text.replace("{coords}", "");` },
    { name: 'плейсхолдер остаётся в письме ({coords} читается глазами)',
      pattern: `    if geo.is_empty() {
        return cfg.sos_text.replace("{coords}", "");`,
      replacement: `    if geo.is_empty() {
        return cfg.sos_text.clone();` },
    { name: 'место для координат не ищется — они никогда не встают по плейсхолдеру',
      pattern: '    if cfg.sos_text.contains("{coords}") {',
      replacement: '    if false {' },
    { name: 'подстановка наоборот: плейсхолдер затирает координаты',
      pattern: '        return cfg.sos_text.replace("{coords}", geo);',
      replacement: '        return cfg.sos_text.replace(geo, "{coords}");' },
    { name: 'гео выключено, а координаты дописываются (флаг не читается)',
      pattern: '    if cfg.sos_geo {',
      replacement: '    if !cfg.sos_geo {' },
    { name: 'гео включено, но хвост не дописывается (флаг всегда выключен)',
      pattern: '    if cfg.sos_geo {',
      replacement: '    if false {' },
    { name: 'в хвост вместо текста письма встают координаты',
      pattern: '        return format!("{} | {}", cfg.sos_text, geo);',
      replacement: '        return format!("{} | {}", geo, cfg.sos_text);' },
    { name: 'координаты теряются при дописывании',
      pattern: '        return format!("{} | {}", cfg.sos_text, geo);',
      replacement: '        return format!("{}", cfg.sos_text);' },
    { name: 'разделитель текста и координат теряется (читается как одно слово)',
      pattern: '        return format!("{} | {}", cfg.sos_text, geo);',
      replacement: '        return format!("{}{}", cfg.sos_text, geo);' },
    { name: 'хвост без гео теряет текст письма',
      pattern: `    cfg.sos_text.clone()
}`,
      replacement: `    String::new()
}` },
    // ── адрес строки конфига: общий контракт с Kotlin-замком и JS-фронтом ──
    { name: "конфиг читается не из строки 'anon' (замок «сбрасывается»)",
      pattern: '            .kv_get("anon", "duress-config")',
      replacement: '            .kv_get("duress", "duress-config")' },
    { name: 'конфиг читается не по тому ключу',
      pattern: '            .kv_get("anon", "duress-config")',
      replacement: '            .kv_get("anon", "duress_config")' },
    { name: 'конфиг пишется не по тому ключу (замок настроен, но не читается)',
      pattern: `    s.kv_set(
        "anon",
        "duress-config",`,
      replacement: `    s.kv_set(
        "anon",
        "duress_config",` },
    { name: 'сохраняется не введённый конфиг, а пустой',
      pattern: '        &serde_json::to_string(cfg).map_err(|e| e.to_string())?,',
      replacement: '        &serde_json::to_string(&DuressConfig::default()).map_err(|e| e.to_string())?,' },
  ],
};
