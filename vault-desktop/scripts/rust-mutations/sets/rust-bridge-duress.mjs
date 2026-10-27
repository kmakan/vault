// ЗАЧЕМ. Очередь моста `t_61bd5090`, пункт 10 (диагностика SOS-цепочки на
// устройстве, 25.10). `duress.rs` был полностью слепой зоной: правило сборки
// текста SOS жило ВНУТРИ `#[cfg(target_os = "android")]` JNI-обёртки, значит с
// хоста до него нельзя было достать ни одной проверкой, а чтение/запись конфига
// замка шли через `Storage::open(None)` — живую БД разработчика.
//
// Что теперь измеримо:
//   * `compose_sos_text` (headless) и команды `duress_sos_text` /
//     `duress_geo_phrase` (WebView) — сами правила уехали в ядро (27.10, #38:
//     у правила была вторая копия во фронте, и копии разошлись), здесь
//     меряется ОБВЯЗКА — какие данные канала передаются ядру. Ошибка в обвязке
//     это письмо беды без текста, без места или не на том языке;
//   * `load_config`/`save_config` — после тестового редиректа
//     `VAULT_TEST_DB_FILE` (`storage/sqlite.rs::default_db_path`). Адрес строки
//     ('anon','duress-config') — общий контракт с Kotlin-замком и JS-фронтом:
//     перепутать аккаунт или ключ значит «замок настроен, но не читается».
//
// СОЗНАТЕЛЬНО НЕ МУТИРУЕТСЯ (не измеримо, а не «забыто»):
//   * само правило подстановки — оно в ядре, меряется набором `rust-duress`;
//   * JNI-обёртки (`nativeSendDuressSos`, `nativeVerifyPin`, `sync_prefs_android`,
//     `nativePanicWipe`) — под `cfg(target_os = "android")`, с хоста не
//     вызываются; их проверяет приёмка на устройстве;
//   * ветка `Err(_) => DuressConfig::default()` в `load_config` — при открытом
//     тестовом редиректе `Storage::open` не падает, мутант выживал бы всегда;
//   * `wipe_all_data` (порядок стирания) — на хосте трогает живые каталоги
//     ключей/кредов, проверяется только на тестовом устройстве;
//   * `hash_secret`/`verify_secret` — протокол замка, измерен в ядре.
//
// ИМЕНА ПРОБ (живость фильтра с 25.10 меряет `npm run gate:rust-smokes`,
// вердикт по-прежнему даёт весь либ-прогон):
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
//   headless_channel_passes_no_default_text
//   webview_command_uses_the_locale_default_and_no_separator
//   webview_geo_phrase_comes_from_the_core

export default {
  id: 'rust-bridge-duress',
  crate: 'vault-desktop/src-tauri',
  pkg: 'vault-desktop',
  kind: 'lib',
  file: 'vault-desktop/src-tauri/src/duress.rs',
  smoke: 'cargo test -p vault-desktop --lib duress',
  timeoutMs: 900_000,
  mutations: [
    // ── headless-обвязка: данные канала, которые передаются правилу ──
    { name: 'headless изобретает свой дефолтный текст (письмо не то, что настроено)',
      pattern: '        default_text: "",\n        geo_on: cfg.sos_geo,',
      replacement: '        default_text: "дефолт",\n        geo_on: cfg.sos_geo,' },
    { name: 'headless теряет свой разделитель хвоста (текст склеивается с местом)',
      pattern: '        separator: " | ",',
      replacement: '        separator: "",' },
    { name: 'настроенный текст не доезжает правила (всегда пустой вход)',
      pattern: '        text: &cfg.sos_text,',
      replacement: '        text: "",' },
    { name: 'координат не передаётся никогда (место человека теряется)',
      pattern: '        geo,\n        separator: " | ",',
      replacement: '        geo: "",\n        separator: " | ",' },
    { name: 'флаг гео подменяется включённым (координаты против настройки)',
      pattern: '        geo_on: cfg.sos_geo,',
      replacement: '        geo_on: true,' },
    { name: 'флаг гео подменяется выключенным (настроенное место не дописывается)',
      pattern: '        geo_on: cfg.sos_geo,',
      replacement: '        geo_on: false,' },
    // ── WebView-обвязка: дефолт из локали и пустой разделитель ──
    { name: 'дефолт из локали не доезжает (письмо без слов при пустой настройке)',
      pattern: '        default_text: &default_text,',
      replacement: '        default_text: "",' },
    { name: 'настроенный текст WebView теряется (всегда дефолт локали)',
      pattern: '        text: &sos_text,',
      replacement: '        text: "",' },
    { name: 'WebView дописывает чужой разделитель (в письме « | , мои координаты»)',
      pattern: '        separator: "",',
      replacement: '        separator: " | ",' },
    { name: 'WebView забывает флаг гео (хвост не дописывается никогда)',
      pattern: '        geo_on,\n        geo: &geo,',
      replacement: '        geo_on: false,\n        geo: &geo,' },
    { name: 'подпись координат теряется (письмо не на языке отправителя)',
      pattern: '    vault_client::vault::duress::geo_phrase(&label, lat, lon)',
      replacement: '    vault_client::vault::duress::geo_phrase("", lat, lon)' },
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
