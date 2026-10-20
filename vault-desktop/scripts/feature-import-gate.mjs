// Гейт: «фича не импортирует фичу» (ADR-004 Этап D, t_436d452d).
//
// ЗАЧЕМ. Каждая feature в src/features/ должна получать зависимости от
// других feature через deps-инъекцию (signature), а не через статический
// import — иначе тонкая фича A неявно зависит от внутреннего строения B,
// и правка B ломает A невидимо. Исключения: чистые примитивы (без состояния
// и без семантики фичи) и singleton-владельцы состояния.
//
// Алгоритм:
//   1. Для каждого src/features/X.js (только top-level .js, не подкаталоги)
//      собрать все статические относительные импорты (from './y.js' и
//      import('./y.js')).
//   2. Разрешить путь относительно features/.
//   3. Если цель — ДРУГОЙ top-level feature-файл (features/Y.js, а не
//      features/subdir/Y.js), извлечь имя Y (без .js).
//   4. Вычесть allowlist. Остаток = нарушения (печатается файл → цель).
//
// Защита от вырождения: если не рассмотрено ни одного ребра «фича → фича» —
// падение, а не «чисто» (иначе устаревший шаблон тихо даёт 0 нарушений).
//
// ADR-004: слоистая архитектура. feature = business logic; primitive =
// чистый utility без состояния; store-owner = singleton-владелец состояния.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FEATURES = path.join(ROOT, 'src', 'features');

// (а) Чистые примитивы без состояния и без семантики фичи.
// Каждая строка с обоснованием:
const PRIMITIVES = new Set([
  'envelope-id',     // чистый ID-генератор: PENDING_PREFIX, pendingIdOf(), envelopeIdOf(), matchesPending(). Счётчик seq — не feature-state, а гарант уникальности id в процессе.
  'timing',          // fire-and-forget delay/later/cancel — никакого состояния модуля.
  'group-pin-wire',  // константы PIN_WIRE_VERSION/PIN_ACTION + чистые buildPinPreview/buildPinDecision/buildPinWirePayload/parsePinWire. Ни состояния, ни семантики фичи.
  'call-clock',      // только factory createCallClock() — состояние живёт внутри created-объекта, а не в модуле. Owner = call-session/вызывающий.
  'call-idle',       // factory createFastFetcher/createConnLostGuard; singleton-экземпляры — владельцы idle-таймеров владения calls.js (ADR-004 H). Фабрики чистые; синглтоны — state-owner, но в рамках call-инфраструктуры, а не feature-логики.
  'call-resend',     // SIGNAL_RESEND_DELAYS_MS + factory createCallResender(); singleton-ресендеры — владельцы call-таймеров (ADR-004 I.2), аналогично call-idle.
  'call-watchdog',   // только factory createMediaWatchdog() — состояние внутри created-объекта.
  'call-ring',       // только factory createRingTimer() — состояние внутри created-объекта.
  'call-terminal',   // только factory createTerminalSender() — состояние внутри created-объекта.
  'recovery-session', // чистые функции над localStorage-маркером: storage инъектируется параметром. Нет feature-семантики, только durable-флаг.
  'contacts-load',   // loadContacts(email): чистая функция, возвращает {contacts, contactAliases}, не мутирует ctx. Инкапсулирует правило «один ключ — несколько адресов».
  'presence',        // heartbeat-signal format + чистые ingestSignal/isOnline. Приём: ingestSignal(noteSeen, robj, …) — связанная функция отметки, а не ctx (ADR-005 R3). Состояние отправки — в ctx (HB_TIMER как string-key, а не переменная). Инфраструктурный модуль presence-сигналов.
]);

// (б) Singleton-владельцы состояния + мост к владельцам.
// Паттерн *-store.js — автоматически разрешается (isStorePattern ниже).
const STATE_OWNERS = new Set([
  'mailbox-api',     // мост: lazy-импорты features через import(), фасад над session/chat/mailbox/ui stores. relay.js → mailbox-api — это bridge, а не feature-to-feature.
  'call-session',    // singleton state-owner для call-state (ADR-004 Этап C). Название не *-store.js, но роль та же: createCallSession() → reactive(callSession), useSession() — accessor. Владелец, а не feature-логика.
  'relay-idle',      // singleton state-owner relay-таймеров (ADR-004 H+/I.3/I.4): relayTicker/fastFetchCycle/pollingCycle/idleFallback/idleState — factory+singleton. Владелец таймеров relay.js, аналог *-store.js для relay-domain.
]);

// Паттерн: любой файл *-store.js автоматически в allowlist (категория б).
function isStorePattern(name) {
  return /-store$/.test(name);
}

// ИСКЛЮЧЕНИЕ ПО ИСТОЧНИКУ (не по цели): модуль-мост имеет право импортировать
// фичи — это его работа. Обычная фича такого права не имеет: она получает
// зависимости через deps-инъекцию. Список намеренно из одного элемента.
const BRIDGE_SOURCES = new Set([
  // Фасад/композиция над owner-ами (ADR-004 J.4): lazy-import фич через
  // import() — именно так он собирает владельцев без цикла
  // mailbox-api → feature → relay → mailbox-api. Не фича, а точка сборки.
  'mailbox-api',
]);

function isAllowed(featureName) {
  if (PRIMITIVES.has(featureName)) return true;
  if (STATE_OWNERS.has(featureName)) return true;
  if (isStorePattern(featureName)) return true;
  return false;
}

// ── Сбор всех top-level feature-файлов ──────────────────────────────
const featureFiles = readdirSync(FEATURES, { withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.js'))
  .map(e => e.name);
// Множество top-level feature-имен (без .js)
const featureNames = new Set(featureFiles.map(f => f.replace(/\.js$/, '')));

// ── Извлечение относительных импортов ────────────────────────────────
// Покрывает `import … from './x'`, `import './x'` и `import('./x')`.
const REL_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

const violations = [];
let candidates = 0;   // рассмотренных рёбер «top-level фича → top-level фича»

for (const file of featureFiles) {
  const realPath = path.join(FEATURES, file);
  const src = readFileSync(realPath, 'utf8');
  const sourceName = file.replace(/\.js$/, '');

  const relImports = new Set();
  let m;
  REL_IMPORT.lastIndex = 0;
  while ((m = REL_IMPORT.exec(src)) !== null) {
    relImports.add(m[1]);
  }

  for (const spec of relImports) {
    // Разрешить путь относительно features/
    const resolved = path.resolve(FEATURES, spec);
    // Только импорты, чья цель — top-level feature-файл (features/X.js,
    // а НЕ features/subdir/X.js). Подкаталоги (duress/state.js, poll/state.js)
    // — это внутренние sub-state, а не cross-feature импорт.
    const basename = path.basename(resolved);
    if (!basename.endsWith('.js')) continue;
    // Цель должна лежать ПРЯМО в features/ (не в подкаталоге)
    const parentDir = path.dirname(resolved);
    if (parentDir !== FEATURES) continue;
    // Цель должна быть известным feature-файлом
    if (!featureNames.has(basename.replace(/\.js$/, ''))) continue;

    candidates++;
    if (BRIDGE_SOURCES.has(sourceName)) continue;  // мост: исходящие связи разрешены
    const targetName = basename.replace(/\.js$/, '');
    if (!isAllowed(targetName)) {
      violations.push({ file, target: spec, targetName });
    }
  }
}

// Защита от вырождения: гейт обязан реально кого-то проверить. Если не
// рассмотрено НИ ОДНОГО ребра «фича → фича» — шаблон поиска устарел или
// features/ исчез, и «0 нарушений» ничего не доказывает.
if (!featureFiles.length || !candidates) {
  console.log('✗ feature-import-gate: не рассмотрено ни одного ребра «фича → фича»'
    + ' (' + featureFiles.length + ' top-level feature-файлов).');
  console.log('  Гейт ничего не проверил: шаблон поиска устарел или features/ исчез.');
  process.exit(1);
}

if (violations.length) {
  console.log('✗ feature-import-gate: ' + violations.length + ' нарушений (фича импортирует фичу):');
  for (const v of violations) {
    console.log('  ' + v.file + ' → ' + v.target + '  (' + v.targetName + ')');
  }
  console.log('');
  console.log('  Как снять: вынести зависимость через deps-инъекцию в сигнатуру');
  console.log('  (как в poll.js/recovery.js: export async function f(ctx, deps)), либо добавить');
  console.log('  в allowlist с письменным обоснованием (ADR-004).');
  process.exit(1);
}

console.log('✓ feature-import-gate: ' + featureFiles.length + ' top-level feature-файлов, '
  + candidates + ' рёбер «фича → фича» рассмотрено, 0 нарушений');
console.log('  allowlist: ' + PRIMITIVES.size + ' примитивов + ' + STATE_OWNERS.size +
  ' state-owner/bridge + *-store.js паттерн; мост-источник: ' + [...BRIDGE_SOURCES].join(', '));