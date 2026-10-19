// ХРАПОВИК «JS-ЛОГИКА» (ADR-005 §6/W0, t_8a422c38).
//
// ЗАЧЕМ. ADR-005 объявляет три нормы: ноль `ctx`, ноль логики в `App.vue`, ноль
// решений о протоколе в JS. Норма без измерения — пожелание, а измерение без
// потолка — отчёт, который никто не обязан читать. Этот гейт ставит потолок.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ `ctx-ratchet-gate`. Тот держит только связность (`ctx`) и
// только по модулям фич. Здесь — все три величины этапа сразу, потому что
// работа идёт пакетами: вынесли логику из `App.vue`, но по дороге завели разбор
// конверта в JS — суммарно прогресса нет, и это должно валить сборку, а не
// проходить по частям.
//
// ПОТОЛОК ТОЛЬКО ЗАТЯГИВАЕТСЯ. Опции `--write` нет; есть `--write` без
// повышения: если хоть одна величина выросла, запись отклоняется. Эталон
// читается из git HEAD, а не из рабочей копии, — иначе достаточно вписать
// большие числа в JSON, и ратчет примет это как норму (ровно этот дефект был
// найден в первой версии ctx-ratchet, см. его комментарий).
//
// САМОПРОВЕРКА. Детекторы и инвентарь проходят пары «заведомо плохо / заведомо
// чисто» при каждом запуске (`lib/arch-metrics.mjs#selfTest`, 10 пар). Проверка
// «на подставленном нарушении» выполнена и вживую, 19.10.2026, по одному
// нарушению за раз, с откатом после каждого:
//
//   1. `ctx`-ссылка: в `features/notes-store.js` добавлено `ctx.selfCheckProbe;`
//      → `✗ js-logic-ratchet: 2 нарушени(й) · всего ctx-ссылок: 686 → 687 ·
//      features/notes-store.js берёт НОВЫЕ ctx-поля: selfCheckProbe
//      (было 2, стало 3)` — код выхода 1.
//   2. метод с логикой: в `App.vue` добавлен `selfCheckProbe() { return 1; }`
//      → `✗ ... методов с логикой в App.vue: 198 → 199` — код выхода 1.
//   3. разбор конверта: в `features/receipts.js` добавлено
//      `const probe = parseEnvelope(text);`
//      → `✗ ... всего протокольных решений в JS: 69 → 70 ·
//      features/receipts.js — envelope-parse 1 → 2 (разбор wire-конверта в JS:
//      решение «что это за конверт» — в Rust)` — код выхода 1.
//
// После каждого откатывалось; три прогона подряд: 1 / 1 / 1 → 0 (чистое дерево).
//
// Что делать при срабатывании: НЕ поднимать потолок. Либо перенести решение в
// Rust (R1), либо вынести логику из `App.vue` (R4), либо передать зависимость
// явно вместо `ctx` (R3). Если рост осознан и неизбежен — это предмет ADR, а не
// молчаливая смена нормы.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { collectArchMetrics, selfTest, PROTOCOL_MARKERS } from './lib/arch-metrics.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE_FILE = path.join(ROOT, 'scripts', 'js-logic-baseline.json');
const childProcess = createRequire(import.meta.url)('node:child_process');

// Человеческое объяснение маркера — в сообщении об ошибке, а не в коде гейта.
const WHY = Object.fromEntries(PROTOCOL_MARKERS.map((m) => [m.id, m.why]));

// ── Самопроверка детекторов: сломанный регексп должен валить гейт ───────
const st = selfTest();
if (st.fails.length) {
  console.log('✗ js-logic-ratchet: самопроверка детекторов провалена — инструмент врёт, цифрам верить нельзя.');
  for (const f of st.fails) console.log('   • ' + f);
  process.exit(1);
}

const cur = collectArchMetrics();
const flatCtx = (m) => Object.entries(m.ctxByFile).sort(([a], [b]) => a.localeCompare(b));
const flatProto = (m) => Object.entries(m.protocolByFile).sort(([a], [b]) => a.localeCompare(b));

const current = {
  measuredAt: '2026-10-19',
  totals: {
    ctxRefSites: cur.totals.ctxRefSites,
    appVueOwn: cur.totals.appVueOwn,
    appVueMethods: cur.totals.appVueMethods,
    protocolSites: cur.totals.protocolSites,
    protocolFiles: cur.totals.protocolFiles,
  },
  ctxByFile: Object.fromEntries(flatCtx(cur)),
  ctxFieldsByFile: Object.fromEntries(Object.entries(cur.ctxFieldsByFile).sort(([a], [b]) => a.localeCompare(b))),
  protocolByFile: Object.fromEntries(flatProto(cur)),
  appVueOwnNames: cur.appVue.ownNames || [],
};

if (cur.totals.files === 0) {
  console.log('✗ js-logic-ratchet: не найдено ни одного JS-файла — гейт ничего не проверил.');
  process.exit(1);
}

// Эталон — то, что закоммичено. Путь в git относителен корня репозитория.
function committedBaseline() {
  if (!existsSync(BASE_FILE)) return null;
  try {
    const rel = childProcess.execFileSync('git', ['rev-parse', '--show-prefix'],
      { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return JSON.parse(childProcess.execFileSync('git',
      ['show', 'HEAD:' + rel + 'scripts/js-logic-baseline.json'],
      { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return JSON.parse(readFileSync(BASE_FILE, 'utf8'));
  }
}

// Список величин, которые выросли. Общий для --write и для проверки.
function growth(prev, now) {
  const out = [];
  const t = (k, label) => {
    const a = prev.totals?.[k];
    const b = now.totals?.[k];
    if (typeof a === 'number' && typeof b === 'number' && b > a) out.push(`${label}: ${a} → ${b}`);
  };
  t('ctxRefSites', 'всего ctx-ссылок');
  t('appVueOwn', 'методов с логикой в App.vue');
  t('protocolSites', 'всего протокольных решений в JS');
  t('protocolFiles', 'JS-модулей с протокольными решениями');

  // Пофайловый рост: перенос решений в другой файл не должен проходить.
  for (const [file, n] of Object.entries(now.ctxByFile)) {
    const before = prev.ctxByFile?.[file] || 0;
    if (n > before) {
      const known = new Set(prev.ctxFieldsByFile?.[file] || []);
      const added = (now.ctxFieldsByFile?.[file] || []).filter((f) => !known.has(f));
      out.push(`${file} берёт НОВЫЕ ctx-поля: ${added.join(', ') || '?'} (было ${before}, стало ${n})`);
    }
  }
  for (const [file, kinds] of Object.entries(now.protocolByFile)) {
    const before = prev.protocolByFile?.[file] || {};
    for (const [kind, n] of Object.entries(kinds)) {
      const was = before[kind] || 0;
      if (n > was) out.push(`${file} — ${kind} ${was} → ${n} (${WHY[kind] || 'протокольное решение в JS'})`);
    }
  }
  return out;
}

if (process.argv.includes('--write')) {
  const prev = committedBaseline();
  if (prev) {
    const back = growth(prev, current);
    if (back.length) {
      console.log('✗ храповик НЕ распускается — показатели выросли:');
      for (const b of back) console.log('   • ' + b);
      console.log('\n  Ослабить потолок нельзя. Сначала уменьшите величину, потом запишите.');
      process.exit(1);
    }
  }
  writeFileSync(BASE_FILE, JSON.stringify(current, null, 2) + '\n');
  console.log('✓ js-logic-ratchet записан (только ужесточение): '
    + current.totals.ctxRefSites + ' ctx-ссылок, '
    + current.totals.appVueOwn + ' методов с логикой, '
    + current.totals.protocolSites + ' протокольных решений в '
    + current.totals.protocolFiles + ' файлах');
  process.exit(0);
}

if (!existsSync(BASE_FILE)) {
  console.log('✗ js-logic-ratchet: потолка нет. Создай его текущей величиной: node scripts/js-logic-ratchet-gate.mjs --write');
  process.exit(1);
}

const prev = committedBaseline();

// Рабочая копия потолка не должна быть слабее закоммиченной: иначе ослабленный
// файл можно протащить в следующий коммит, а гейт до этого остаётся слепым.
if (existsSync(BASE_FILE)) {
  const work = JSON.parse(readFileSync(BASE_FILE, 'utf8'));
  const weaker = [];
  for (const k of ['ctxRefSites', 'appVueOwn', 'protocolSites']) {
    const a = prev.totals?.[k];
    const b = work.totals?.[k];
    if (typeof a === 'number' && typeof b === 'number' && b > a) weaker.push(`${k} в файле ${a} → ${b}`);
  }
  if (weaker.length) {
    console.log('✗ js-logic-ratchet: потолок ОСЛАБЛЕН в scripts/js-logic-baseline.json');
    for (const w of weaker) console.log('   • ' + w);
    console.log('\n  Эталон — закоммиченная версия. Ослабить можно только коммитом,');
    console.log('  и он будет виден на ревью.');
    process.exit(1);
  }
}

const problems = growth(prev, current);

// Крипто — жёсткий ноль, независимо от потолка: это не долг, а уже закрытая
// граница (ADR-005 §2.3). Появление любого маркера — регресс.
if (cur.cryptoHard.length) {
  for (const h of cur.cryptoHard) problems.push(`${h.file}: ${h.id} ×${h.n} — ${h.why}`);
}

if (problems.length) {
  console.log(`✗ js-logic-ratchet: ${problems.length} нарушени(й). JS-логика выросла — потолок не распускается.`);
  for (const p of problems) console.log('   • ' + p);
  console.log('\n  Как снять: решение о протоколе/формате — в Rust (R1); логика из App.vue —');
  console.log('  в фичу или в Rust (R4); зависимость вместо ctx — явным параметром (R3).');
  process.exit(1);
}

console.log('✓ js-logic-ratchet: держится — '
  + current.totals.ctxRefSites + '/' + prev.totals.ctxRefSites + ' ctx-ссылок, '
  + current.totals.appVueOwn + '/' + prev.totals.appVueOwn + ' методов с логикой в App.vue, '
  + current.totals.protocolSites + '/' + prev.totals.protocolSites + ' протокольных решений в '
  + current.totals.protocolFiles + '/' + prev.totals.protocolFiles + ' файлах, '
  + 'самопроверка ' + (st.total - st.fails.length) + '/' + st.total);
