# Изоляция тестов (env-переменные, HOME, файловые фикстуры)

Правила появились после разбора сессии `1792249289403_dz2dk` (18.10.2026, коммит
`f3db930`): три теста в `vault-desktop` были красными из-за гонок, а один
интеграционный тест требовал файл из `/tmp`.

## Почему это ломается

`cargo test` запускает тесты **параллельно в одном процессе**. Значит:

- `std::env::set_var` / `remove_var` видны **всем** потокам сразу;
- `dirs::home_dir()` / `dirs::download_dir()` читают `$HOME`/`XDG_*` в момент вызова.

Если один тест подменяет `HOME` или `VAULT_*`, пока другой их читает, второй ловит
чужое состояние. Симптом обманчив: тест «flaky», а при `--test-threads=1` проходит.
Это **не** flaky-тест, а гонка — её надо чинить, а не помечать.

## Правила

1. **Тесты, подменяющие env, обязаны держать общий мьютекс.**
   - В `vault-desktop` это `crate::ENV_MUTEX` (см. `set_env_safe` в `src/lib.rs`).
   - `set_env_safe(key, value)` берёт мьютекс сам.
   - Если тесту нужен мьютекс на **всё** тело (set → работа → restore), берите
     guard напрямую и **не** зовите внутри `set_env_safe` (иначе self-deadlock):

     ```rust
     let _guard = crate::ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
     std::env::set_var("VAULT_PRESENCE_FILE", &path);
     let result = f();
     // restore + cleanup
     ```
   - `.unwrap_or_else(|e| e.into_inner())` — чтобы падение одного теста не
     отравляло мьютекс (poisoning) для остальных.

2. **Никаких `$HOME` / `dirs::download_dir()` в тестах.** Явная директория
   (`std::env::temp_dir().join(unique_name)`) или `tempfile::TempDir`. Если прод-функция
   сама резолвит `$HOME`, вынесите чистую часть (`dir: &Path`) в отдельный хелпер и
   тестируйте её — как `save_base64_file(base64, filename, dir)` в `vault_bridge.rs`.

3. **Никаких внешних фикстур** (файлы в `/tmp`, скачанные письма и т.п.). Фикстура
   строится в тесте. Пример: `vault-client/tests/qp_transport.rs` — реальный конверт
   → quoted-printable (`=3D`) → проверка `is_encrypted`.

4. **Уникальные имена** для temp-файлов/каталогов: `pid` + атомарный счётчик
   (`format!("ks_{}-{}", std::process::id(), seq)`), а не общее имя на всех.

5. **Тест обязан звать прод-код**, а не повторять его построчно. Дублирование («Simulate
   what X does») не ловит регрессию в `X`.

## Где смотреть примеры

- `vault-desktop/src-tauri/src/presence.rs` — guard ENV_MUTEX на всё тело `with_tmp`.
- `vault-desktop/src-tauri/src/key_store.rs` — `TMP_LOCK` + `VAULT_KEYS_DIR`/`VAULT_TEST_KEYS_DIR`.
- `vault-core/src/key_store.rs` — чистые `*_at(path)`-функции + `tempfile::TempDir`
  (тесты вообще не трогают env).
- `vault-desktop/src-tauri/src/vault_bridge.rs` — `save_base64_file(dir)`.
- `vault-client/tests/qp_transport.rs` — самодостаточная фикстура.

## Прогон всех наборов одной командой

Workspace'а в репозитории нет (крейты автономны), поэтому `cargo test
--workspace` невозможен. Вместо него — `scripts/test-all.sh`:

```bash
./scripts/test-all.sh            # core + client + desktop + android
./scripts/test-all.sh core       # выборочно
VAULT_TEST_CARGO_ARGS="--offline" ./scripts/test-all.sh
```

Скрипт печатает `test result:` по каждому крейту, при падении — `error`/
`panicked at` из лога (логи остаются в `$TMPDIR/vault-test-all.*`).
Наборы: `vault-core` (lib), `vault-client` (lib+bin+`tests/*`),
`vault-desktop/src-tauri --lib`, `vault-android/src-tauri --lib`.
`tests/*_e2e.rs` в `vault-client` помечены `#[ignore]` (нужен живой ящик) —
запускаются отдельно: `cargo test --test email_e2e -- --ignored`.
