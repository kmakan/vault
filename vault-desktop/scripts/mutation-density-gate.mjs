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
  // Мост: привязки платформенных API и кодека. Решением тут является форма
  // вызова чужой библиотеки (FFI), а не ветвление над нашими данными; проверяется
  // звонком/записью на живом устройстве, куда мутационный гейт не дотягивается.
  ['vault-desktop/src-tauri/src/android_save.rs', 'обёртка Android MediaStore (FFI) — форма платформенного вызова, меряется приёмкой на X50'],
  ['vault-desktop/src-tauri/src/audio/audio_android.rs', 'привязки AAudio (FFI, unsafe) — устройства-зависимый код, меряется живым звонком'],
  ['vault-desktop/src-tauri/src/vp8_decoder.rs', 'привязки libvpx (FFI) — декодер без решений о протоколе, меряется живым звонком'],
  ['vault-desktop/src-tauri/src/vp8_encoder.rs', 'привязки libvpx (FFI) — энкодер без решений о протоколе, меряется живым звонком'],
  ['vault-desktop/src-tauri/src/peer_index.rs', 'индекс peer по публичному ключу — чистый делегат ядру (очередь t_61bd5090: не кандидат)'],
  // Единственная дыра моста, закрытая 26.10 не «причиной», а выносом: всё, что
  // работает без JNI, живёт в measure-ном monitor_state (62 мутации) и ядре, а
  // здесь осталось ровно то, что с хоста НЕ КОМПИЛИРУЕТСЯ (модуль целиком под
  // #[cfg(target_os = "android")], jni — зависимость android-цели).
  ['vault-desktop/src-tauri/src/service_monitor.rs', 'ОСТАТОК (перечислено, а не «логика без мер»): 5 JNI-входов из Kotlin (nativeStartMonitor / nativeStopMonitor / nativePauseMonitor / nativeSendCallSignal / nativeCallDecision), 2 прямых вызова в Kotlin (VaultForegroundService.showMessage, MainActivity.dispatchCallAction) и показ/снятие уведомления звонка через audio_android; IMAP-цикл с его pacing (IDLE_TICK 7s, backoff 2s/5s, опрос 60×200ms — числа сознательно НЕ перенесены в vault::timings); SMTP-отправка call_accept/reject и SOS; запись курсора и логи в logcat. Модуль под cfg(target_os = "android"): с хоста не компилируется, jni — зависимость android-цели, поэтому мутационный гейт до него не дотягивается; единственная мера — cargo check --target aarch64 + приёмка на устройстве. Решающие правила (очередь, дедуп, надгробия, порядок ключей, лимит попыток, путь к БД, тексты уведомлений, формат сигналов звонка и SOS) вынесены в monitor_state/call/duress и измерены там.'],
  ['vault-desktop/src-tauri/src/key_escrow.rs', 'реэкспорт ядрового формата восстановления (vault::key_escrow) — решений нет, мера у ядра: набор rust-key-escrow'],
  ['vault-desktop/src-tauri/src/voicenote.rs', '56 строк, одно ветвление — тонкая обвязка сохранения, решений нет'],
  ['vault-relay/src/lib.rs', 'объявления модулей и реэкспорты — без логики'],
  ['vault-relay/src/bin/gen_token.rs', 'CLI-генератор токенов, не путь обслуживания; форма токена меряется в tokens.rs (в очереди)'],
]);

const MIN_LOC = 40;   // модули короче — не сигнал (обычно это константы/структуры)

// Счёт по РЕГУЛЯРКЕ молча недоглядел набор: `{ name: … }` на новой строке
// (26 мутаций rust-bridge-batch-bodies) не матчился, и ратчет показал прежнее
// число, хотя дыра закрылась. Измерение, которое врёт в пользу «всё хорошо»,
// хуже отсутствия измерения — теперь счёт идёт по фактическим модулям набора
// (те же объекты, что читает мутационный гейт).
async function collectMutations() {
  const counts = new Map();
  const unreadable = [];
  for (const dir of [
    path.join(DESKTOP, 'scripts', 'mutations', 'sets'),
    path.join(DESKTOP, 'scripts', 'rust-mutations', 'sets'),
  ]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
      const abs = path.join(dir, f);
      let set;
      try {
        const mod = await import(abs);
        set = mod.default || mod;
      } catch (e) {
        unreadable.push(`${f}: ${e.message.split('\n')[0]}`);
        continue;
      }
      if (!set || !set.file || !Array.isArray(set.mutations)) {
        unreadable.push(`${f}: нет { file, mutations[] } — ратчет его не видит`);
        continue;
      }
      for (const m of set.mutations) {
        let target = (m && m.file) || set.file;
        // JS-наборы адресуют модули от корня vault-desktop ('src/features/…'),
        // Rust-наборы — от корня репозитория ('vault-client/src/…'). Приводим к
        // одному виду, иначе JS-модули выглядят непокрытыми.
        if (target.startsWith('src/')) target = 'vault-desktop/' + target;
        counts.set(target, (counts.get(target) || 0) + 1);
      }
    }
  }
  if (unreadable.length) {
    console.error('═══ РАТЧЕТ ПЛОТНОСТИ: НАБОРЫ ВНЕ СЧЁТА ═══');
    for (const u of unreadable) console.error('  • ' + u);
    process.exit(1);
  }
  return counts;
}

function moduleFiles() {
  const out = [];
  const walk = (root, rel) => {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'target') continue;
      // Тестовый файл САМ является проверкой; требовать у него набор мутаций
      // значит требовать набора на набор (и плодить ложные дыры).
      if (/(^|_)(tests?|smoke)\.rs$/.test(e.name)) continue;
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
  // Мост (Tauri-команды). С 25.10 он измерим мутациями (первые наборы), но до
  // этого хода ратчет его вообще НЕ ВИДЕЛ: счётчик «0 дыр» молчал про 30
  // файлов с решениями, и это ровно та же слепая зона, из которой вырос класс
  // «тест измерял свою копию правила».
  walk(path.join(DESKTOP, 'src-tauri', 'src'), 'vault-desktop/src-tauri/src');
  // Релей — серверная половина монетизации и троттлинга. Пока он не в обходе,
  // счётчик «где дыры» молчит про новый файл с решением на пути, где 429
  // стоит денег (25.10: набор лимита ослеп, и плотность этого не увидела).
  walk(path.join(REPO, 'vault-relay', 'src'), 'vault-relay/src');
  return out;
}

const mutations = await collectMutations();
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
