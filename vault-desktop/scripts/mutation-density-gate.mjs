// РАТЧЕТ ПЛОТНОСТИ МУТАЦИЙ: у каждого модуля с логикой есть набор.
//
// ЗАЧЕМ. Гейт покрытия (feature-coverage-gate.mjs) отвечает на вопрос «есть ли
// смоук у фичи». Он НЕ отвечает на вопрос «а насколько глубоко этот смоук
// проверяет модуль». Модуль может иметь смоук с тремя проверками на 900 строк —
// и это формально «покрыто», хотя не проверено ничего.
//
// Мутационный гейт отвечает на второй вопрос, но только для тех модулей, для
// которых наборы УЖЕ написаны. Остальные — слепые зоны, и они не видны ни в
// одном отчёте. Этот ратчет их показывает и не даёт им РАСТИ.
//
// ПРАВИЛА (ратчет: ухудшаться нельзя, улучшаться можно):
//   1) у каждого модуля длиннее 40 строк, кроме явного списка исключений с
//      причиной, есть хотя бы ОДНА мутация — иначе модуль не проверен ничем;
//   2) список исключений — с причиной по каждой позиции (пустая причина не
//      считается причиной);
//   3) baseline хранит фактические счётчики по модулям: уменьшаться нельзя,
//      увеличиваться можно (новые наборы только помогают).
//
// ЗАПУСК:
//   node scripts/mutation-density-gate.mjs           # проверка
//   node scripts/mutation-density-gate.mjs --write   # записать baseline
//   node scripts/mutation-density-gate.mjs --report  # таблица «где дыры»
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;                        // vault-desktop/scripts
const REPO = path.resolve(HERE, '..', '..');              // корень репозитория
const DESKTOP = path.resolve(HERE, '..');
const BASELINE = path.join(HERE, 'mutation-density-baseline.json');

// Модули, которые по определению не содержат проверяемой логики.
// Причина обязательна.
const EXEMPT = new Map([
  ['vault-desktop/src/locales/ru.js', 'файл локализации — данные, а не логика'],
  ['vault-desktop/src/locales/en.js', 'файл локализации — данные, а не логика'],
  ['vault-desktop/src/locales/zh.js', 'файл локализации — данные, а не логика'],
  ['vault-desktop/src/icons.js', 'список иконок — данные'],
  ['vault-client/src/cli/repl.rs', 'REPL терминала — инструмент, не путь приложения; проверяется e2e'],
  ['vault-client/src/cli/commands/mod.rs', 'диспетчер команд CLI — маршрутизация без решений'],
  ['vault-client/src/cli/commands/attachments.rs', 'команды CLI вложений — обвязка транспорта'],
  ['vault-client/src/cli/main.rs', 'точка входа CLI — разбор аргументов'],
  ['vault-client/src/cli/commands/encrypt.rs', 'тонкая обёртка над crypto::Encryptor (ядро покрыто набором encryptor)'],
  ['vault-client/src/cli/commands/decrypt.rs', 'тонкая обёртка над crypto::Encryptor (ядро покрыто набором encryptor)'],
  ['vault-client/src/cli/commands/convert.rs', 'конвертер форматов файлов CLI — не путь приложения'],
  ['vault-client/src/cli/output.rs', 'оформление вывода CLI (баннер, цвета) — косметика'],
  ['vault-client/src/lib.rs', 'объявления модулей и реэкспорты — без логики'],
  ['vault-client/src/main.rs', 'точка входа CLI — разбор аргументов'],
  ['vault-client/src/vault/mod.rs', 'список модулей фичи и реэкспорты — без логики'],
  ['vault-desktop/src/main.js', 'точка входа фронтенда — сборка приложения'],
  ['vault-desktop/src/fonts.js', 'каталог шрифтов — данные, а не логика'],
  ['vault-client/src/api/email.rs', 'IMAP/SMTP-клиент: проверяется e2e-сценарием tests/email_e2e.rs (нужен живой сервер)'],
  ['vault-client/src/api/client.rs', 'тонкий HTTP-обвязка (23 строки) — решений нет'],
  ['vault-client/src/listen.rs', 'IMAP-listener: нужен живой сервер, проверяется e2e'],
  ['vault-client/src/storage/sqlite.rs', 'хранилище SQLite: проверяется e2e-сценариями (нужен файл БД)'],
  ['vault-core/src/lib.rs', 'объявления модулей и реэкспорты — без логики'],
  ['vault-core/src/key_store_types.rs', 'типы хранения и serde-форма — данных и решений нет'],
  ['vault-core/src/group_types.rs', 'общая форма groups.json (поля + serde-умолчания) — решений нет; правило владения меряется в rust-identity'],
]);

const MIN_LOC = 40;   // модули короче — не сигнал (обычно это константы/структуры)

function collectMutations() {
  const counts = new Map();
  for (const dir of [
    path.join(DESKTOP, 'scripts', 'mutations', 'sets'),
    path.join(DESKTOP, 'scripts', 'rust-mutations', 'sets'),
  ]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
      const src = readFileSync(path.join(dir, f), 'utf8');
      const defaultFile = (src.match(/file: ['"]([^'"]+)['"]/) || [])[1];
      for (const block of src.match(/\{ name: .*?\}/gs) || []) {
        const mf = block.match(/file: ['"]([^'"]+)['"]/);
        let target = mf ? mf[1] : defaultFile;
        if (!target) continue;
        // JS-наборы адресуют модули от корня vault-desktop ('src/features/…'),
        // Rust-наборы — от корня репозитория ('vault-client/src/…'). Приводим к
        // одному виду, иначе JS-модули выглядят непокрытыми.
        if (!target.includes('/') || target.startsWith('src/')) {
          if (target.startsWith('src/')) target = 'vault-desktop/' + target;
        }
        counts.set(target, (counts.get(target) || 0) + 1);
      }
    }
  }
  return counts;
}

function moduleFiles() {
  const out = [];
  const walk = (root, rel) => {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'target') continue;
      const full = path.join(root, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.js') && !e.name.endsWith('.rs')) continue;
      let n = 0;
      try { n = statSync(full).size; } catch { continue; }
      if (n < 200) continue;   // ~40 строк — грубо, но достаточно
      out.push(r);
    }
  };
  walk(path.join(DESKTOP, 'src'), 'vault-desktop/src');
  walk(path.join(REPO, 'vault-client', 'src'), 'vault-client/src');
  // Общий слой хранилищ: сюда переехала форма адреса, и мутация без набора
  // больше не должна становиться слепой зоной только из-за другого крейта.
  walk(path.join(REPO, 'vault-core', 'src'), 'vault-core/src');
  return out;
}

const mutations = collectMutations();
const files = moduleFiles();

// Фактические счётчики по модулям.
const actual = new Map();
for (const f of files) {
  if (EXEMPT.has(f)) continue;
  actual.set(f, mutations.get(f) || 0);
}

const problems = [];
const uncovered = [];
for (const [f, n] of actual) {
  if (n === 0) uncovered.push(f);
}

// Baseline: счётчики по модулям (уменьшаться нельзя) + список дыр
// (без единой мутации). Список дыр может только СОКРАЩАТЬСЯ: модуль, которому
// написали набор, из дыр выходит; новый модуль без набора — это регресс.
let baseline = { counts: {}, gaps: [] };
if (existsSync(BASELINE)) baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));

for (const [f, n] of Object.entries(baseline.counts || {})) {
  const cur = actual.get(f);
  if (cur === undefined) {
    problems.push(`модуль ${f} исчез — поправь baseline (он больше не проверяется)`);
    continue;
  }
  if (cur < n) problems.push(`модуль ${f}: мутаций стало ${cur}, а ратчет требовал ${n} — покрытие упало`);
}

const knownGaps = new Set(baseline.gaps || []);
for (const f of uncovered) {
  if (!knownGaps.has(f)) {
    problems.push(`НОВЫЙ модуль без единой мутации: ${f} — либо напиши набор, ` +
      `либо внеси его в список исключений с причиной`);
  }
}
// Дыра, которой больше нет, — повод убрать её из baseline (не ошибка).
const closedGaps = [...knownGaps].filter((f) => !uncovered.includes(f));

// Запись baseline — ДО проверки: иначе --write невозможен (в baseline ещё нет
// текущих дыр, и каждая из них выглядит бы «новым модулем»).
if (process.argv.includes('--write')) {
  const counts = Object.fromEntries([...actual.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  writeFileSync(BASELINE, JSON.stringify({
    note: 'Счётчики мутаций по модулям (уменьшаться нельзя) и список модулей без мутаций ' +
      '(может только сокращаться: закрытая дыра удаляется из списка).',
    counts,
    gaps: uncovered.sort(),
  }, null, 2) + '\n');
  console.log(`✓ baseline плотности записан: модулей ${Object.keys(counts).length}, ` +
    `мутаций ${Object.values(counts).reduce((a, b) => a + b, 0)}, ` +
    `дыр ${uncovered.length}`);
  process.exit(0);
}

const report = process.argv.includes('--report');
if (report) {
  const rows = [...actual.entries()].sort((a, b) => a[1] - b[1] || b[0].length - a[0].length);
  console.log('=== модули по количеству мутаций ===');
  for (const [f, n] of rows.slice(0, 30)) console.log(`${String(n).padStart(4)}  ${f}`);
}

if (problems.length) {
  console.error('═══ РАТЧЕТ ПЛОТНОСТИ МУТАЦИЙ: УХУДШЕНИЕ ═══\n');
  for (const p of problems) console.error('  • ' + p);
  process.exit(1);
}

if (uncovered.length) {
  console.error('═══ МОДУЛИ БЕЗ МУТАЦИЙ (слепые зоны) ═══\n');
  for (const f of uncovered) console.error(`  • ${f}`);
  console.error(`\n  Всего без мутаций: ${uncovered.length}. Каждый такой модуль —`);
  console.error('  слепая зона: его обычные тесты могут ничего не проверять, и никто');
  console.error('  об этом не узнает. Либо пишем набор мутаций, либо добавляем модуль');
  console.error('  в список исключений С ПРИЧИНОЙ (scripts/mutation-density-gate.mjs).');
}

const total = [...actual.values()].reduce((a, b) => a + b, 0);
console.log(`✓ mutation-density-gate: модулей под ратчетом ${actual.size}, ` +
  `мутаций ${total}, дыр ${uncovered.length}` +
  (closedGaps.length ? `, закрыто с прошлого раза ${closedGaps.length}` : ''));
