#!/usr/bin/env node
// ЗАЧЕМ. Тесты моста редиректят процесс-глобальные переменные окружения
// (`VAULT_TEST_DB_FILE`, `VAULT_TEST_KEYS_DIR`, `VAULT_GROUPS_FILE`,
// `VAULT_KEYS_DIR`, `VAULT_CREDENTIALS_DIR`), чтобы не трогать живые данные
// разработчика. Cargo гоняет тесты параллельными потоками в ОДНОМ процессе,
// поэтому редирект обязан стоять под ЕДИНЫМ замком на весь крейт.
//
// Что краснеет (найдено 25.10 при подготовке проб `alias_pairs`, пункт 11
// очереди `t_61bd5090`): редиректы были заперты ТРИ разными способами —
// `TMP_LOCK` в key_store/groups/duress, `TEST_LOCK` в credential_store и
// чужой `ENV_MUTEX` в presence (он защищает `set_env_safe` раннера, а не
// тестовый прогон). Разные замки сериализуют тесты только внутри своего
// модуля, а между модулями поток спокойно снимал чужую переменную в момент
// `remove_var` — и тест дописывался в ЖИВУЮ базу/каталог ключей. Следствие
// хуже флейка: «зелёный» тест проверял не то, что он проверяет, а мутационный
// гейт ловил ложных выживших.
//
// ПРАВИЛА:
//  1. в исходниках моста не должно быть второго замка для env-редиректа —
//     единственный держатель `static ... Mutex<()>` с именем TMP_LOCK/TEST_LOCK
//     живёт в `lib.rs` как `ENV_TEST_LOCK`, доступ через `crate::env_test_guard()`;
//  2. каждый `set_env_safe("VAULT_…")` обязан идти сразу под `env_test_guard()`
//     (в пределах 25 строк выше) — иначе редирект ничем не защищён;
//  3. `std::env::remove_var("VAULT_…")` тоже обязан быть под защитой: без
//     замка он снимает чужой редирект.
//
// ВНЕ ОБЛАСТИ (заглушка, а не пропуск): `service_monitor.rs` под
// `cfg(target_os = "android")` двигает `HOME` — с хоста не компилируется,
// проверяется приёмкой на устройстве.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src');
const GUARD_WINDOW = 25;
// Переменные рантайма, а не редирект тестовых данных: держать их под
// тестовым замком нельзя (их ставит прод). `HOME` — service-процесс Android
// (`service_monitor.rs`, env пуст в FGS), `VAULT_LOG_INIT` — флаг инициализации
// лога в `run()`.
const PROD_ENV = new Set(['VAULT_LOG_INIT', 'HOME', 'RUST_LOG', 'PATH', 'TMPDIR']);

function rsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...rsFiles(p));
    else if (e.name.endsWith('.rs')) out.push(p);
  }
  return out;
}

const problems = [];
let files = 0, redirects = 0;

for (const f of existsSync(SRC) ? rsFiles(SRC) : []) {
  files += 1;
  const lines = readFileSync(f, 'utf8').split('\n');
  const rel = path.relative(path.join(SRC, '..', '..'), f);

  // правило 1: второго замка нет (в lib.rs — разрешено, это и есть единственный)
  lines.forEach((line, i) => {
    if (/^static\s+(TMP_LOCK|TEST_LOCK|ENV_LOCK)\b/.test(line.trim()) && rel !== 'src-tauri/src/lib.rs') {
      problems.push(`${rel}:${i + 1}: свой замок для env-редиректа — нужен crate::env_test_guard()`);
    }
  });

  // правила 2 и 3: каждый set/remove тестового редиректа стоит под guard
  const varOf = (l) => {
    const m = /(set_env_safe|remove_var|set_var)\(\s*"(VAULT_[A-Z_]+|HOME)"/.exec(l);
    return m ? m[2] : null;
  };
  lines.forEach((line, i) => {
    const name = varOf(line);
    if (!name || PROD_ENV.has(name)) return;
    redirects += 1;
    const windowStart = Math.max(0, i - GUARD_WINDOW);
    const guarded = lines
      .slice(windowStart, i + 1)
      .some((l) => /env_test_guard\(\)|ENV_TEST_LOCK\s*\.lock\(\)/.test(l));
    if (!guarded) {
      problems.push(`${rel}:${i + 1}: редирект ${name} без единого замка`);
    }
  });
}

if (!existsSync(SRC)) {
  console.error('  ✗ каталог моста не найден: ' + SRC);
  process.exit(1);
}

if (problems.length) {
  console.error(`✗ gate:test-isolation: тесты делят env без единого замка (${problems.length}):`);
  for (const p of problems) console.error('  · ' + p);
  process.exit(1);
}
console.log(
  `✓ gate:test-isolation: редиректов env ${redirects}, все под единым замком (проверено файлов: ${files}).`,
);
