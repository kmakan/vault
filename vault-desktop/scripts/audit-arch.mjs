// Аудит границы Rust/JS и изоляции модулей (vault-desktop).
//
// Зачем отдельный инструмент, а не «посмотреть глазами». Четыре вопроса, на
// которые нужен ОТВЕТ, а не впечатление:
//   1. Осталась ли в JS логика, которой место в Rust — крипто-математика и
//      ПРОТОКОЛЬНЫЕ РЕШЕНИЯ (сборка/разбор конвертов, машина состояний звонка,
//      TTL/истечение)?
//   2. Связаны ли фичи между собой — то есть сломает ли правка одной соседнюю?
//   3. Есть ли циклы в графе модулей? Цикл = правка одного файла может
//      сломать инициализацию другого, причём не в том месте, где правили.
//   4. Сколько логики осталось в `App.vue` — монолит против делегатов.
//
// Каждая метрика считается из исходников и воспроизводится: `npm run
// audit:arch`. Числа в отчёте без прогона — мнение, а не измерение.
//
// КОД ВЫХОДА: 1, если в JS появилась крипто-логика (норма ADR-005 §2.3 — ноль,
// это не долг, а закрытая граница) или если ПРОВАЛИЛАСЬ САМОПРОВЕРКА
// детекторов. Протокольные решения — пока долг этапа (§5: цель 0, сейчас не 0),
// поэтому их рост останавливает не аудит, а ратчет
// `js-logic-ratchet-gate.mjs`; аудит их называет и считает.
//
// Метрики берутся из `scripts/lib/arch-metrics.mjs` — ОДНИМ кодом с ратчетом.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { collectArchMetrics, selfTest, SRC } from './lib/arch-metrics.mjs';

const ROOT = SRC;

// ── Самопроверка детекторов: до всякого отчёта ─────────────────────────
// Инструмент обязан быть проверен на заведомо известном нарушении, иначе он
// измеряет мнение (ADR-005 R7). Пары «плохо/чисто» гоняются при каждом запуске.
const st = selfTest();
console.log('═══ 0. САМОПРОВЕРКА ДЕТЕКТОРОВ ═══\n');
if (st.fails.length) {
  for (const f of st.fails) console.log('  ✗ ' + f);
  console.log(`\n  Самопроверка провалена (${st.fails.length} из ${st.total}). Цифрам ниже верить нельзя.`);
  process.exit(1);
}
console.log(`  ✓ ${st.total}/${st.total} пар «заведомо плохо / заведомо чисто» пройдено:`);
console.log('    pbkdf2 ловится, isCryptoReady — нет; вызов parseEnvelope ловится,');
console.log('    объявление функции — нет; setCallState ловится, ключ локали — нет.');

const metrics = collectArchMetrics();
const rows = metrics.files;

// ── 1. Граница Rust/JS ────────────────────────────────────────────────
console.log('\n═══ 1. ГРАНИЦА RUST/JS ═══\n');
const hard = metrics.cryptoHard;
if (hard.length === 0) {
  console.log('  ✓ Крипто-логики в JS нет: ни HMAC, ни KDF, ни subtle.encrypt/sign.');
} else {
  for (const h of hard) console.log(`  ✗ ${h.file}: ${h.id} ×${h.n} — ${h.why}`);
}
const inv = invokeStats();
console.log(`\n  Всего уникальных Rust-команд из JS: ${inv.unique}`);
console.log('  Распределение invoke по модулям (топ-10 по вызовам):');
rows.slice().sort((a, b) => (inv.byFile.get(b.file) || 0) - (inv.byFile.get(a.file) || 0)).slice(0, 10)
  .forEach((r) => console.log(`    ${String(inv.byFile.get(r.file) || 0).padStart(4)}  ${r.file}`));
console.log(`  Модулей JS: ${metrics.totals.files}, строк: ${metrics.totals.lines}`);

// ── 1b. Протокольные решения в JS (ADR-005 R1) ────────────────────────
console.log('\n═══ 1b. ПРОТОКОЛЬНЫЕ РЕШЕНИЯ В JS ═══\n');
const protoFiles = Object.entries(metrics.protocolByFile)
  .map(([file, kinds]) => ({ file, kinds, n: Object.values(kinds).reduce((a, b) => a + b, 0) }))
  .sort((a, b) => b.n - a.n);
if (!protoFiles.length) {
  console.log('  ✓ Решений о протоколе/формате в JS нет (цель ADR-005 §5 достигнута).');
} else {
  console.log(`  Всего решений: ${metrics.totals.protocolSites} в ${metrics.totals.protocolFiles} модулях.`);
  console.log('  По видам: ' + Object.entries(metrics.protocolByKind).map(([k, n]) => `${k} ${n}`).join(', '));
  console.log('  Модули (файл — решения):');
  for (const p of protoFiles) {
    const kinds = Object.entries(p.kinds).sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}×${n}`).join(', ');
    console.log(`    ${String(p.n).padStart(4)}  ${p.file}  — ${kinds}`);
  }
  console.log('  ⇒ Это долг этапа W4: решения о конвертах/состоянии — в Rust, JS — транспорт.');
}

// ── 2. Изоляция модулей: циклы в графе импортов ───────────────────────
// Цикл в ES-модулях не падает, но делает порядок инициализации частью
// контракта: правка одного файла может сломать другой не там, где правили.
console.log('\n═══ 2. ИЗОЛЯЦИЯ: ЦИКЛЫ ИМПОРТОВ ═══\n');
const cycles = importCycles();
if (cycles.length === 0) {
  console.log('  ✓ Циклов импортов нет.');
} else {
  console.log(`  ✗ Циклов: ${cycles.length}. Каждый — правка одного модуля может сломать другой:`);
  for (const c of cycles) console.log('    ' + c.join(' → '));
}

// ── 3. Связность через общее состояние ctx ────────────────────────────
// Модули, тянущие один и тот же ctx, — не модули, а клиенты одной сущности.
// Число считается ТЕМ ЖЕ правилом, что у ctx-ratchet-gate (features/*.js +
// api.js, комментарии не в счёт), иначе получаются две цифры об одной величине.
console.log('\n═══ 3. ОБЩЕЕ СОСТОЯНИЕ (ctx) ═══\n');
const ctxEntries = Object.entries(metrics.ctxByFile).sort((a, b) => b[1] - a[1]);
const linesOf = (f) => (rows.find((r) => r.file === f) || {}).lines || 0;
console.log(`  Всего ссылок ctx: ${metrics.totals.ctxRefSites} в ${ctxEntries.length} модулях `
  + `(правило и величина — как у ctx-ratchet-gate)`);
for (const [f, n] of ctxEntries.slice(0, 10)) {
  console.log(`    ${String(n).padStart(4)}  ${f}  (${linesOf(f)} строк, ${Math.round((n / Math.max(linesOf(f), 1)) * 100)}% строк)`);
}
if (metrics.ctxRawAllFiles !== metrics.totals.ctxRefSites) {
  console.log(`  Справка: сырой счёт по всем .js, включая комментарии — ${metrics.ctxRawAllFiles}.`);
  console.log('  Это не «новая ctx», а другое правило счёта: связь меряется по потребителям');
  console.log('  (features/*.js + api.js) без комментариев.');
}

// ── 4. App.vue: сколько логики ещё в монолите ─────────────────────────
// «Логика вынесена в фичи» проверяется не по факту наличия features/*, а по
// доле методов App.vue, которые являются чистыми делегатами. Остальное —
// логика, живущая в компоненте, то есть ровно то, что делает правку одной
// фичи риском для соседей. Правило делегата ОДНО и живёт в arch-metrics.mjs:
// разошедшиеся правила давали 178 против 166 (см. историю в §1 файла).
console.log('\n═══ 4. МОНОЛИТ App.vue ═══\n');
const app = metrics.appVue;
if (!app.found) {
  console.log('  блок methods не найден — структура изменилась, поправь аудит');
} else {
  const pct = app.methods ? Math.round((app.delegates / app.methods) * 100) : 0;
  console.log(`  App.vue: ${app.lines} строк, блок methods — ${app.blockLines} строк, методов ${app.methods}`);
  console.log(`  делегатов в модули: ${app.delegates} (${pct}%)`);
  console.log(`  методов с собственной логикой: ${app.own} (${100 - pct}%) — это и есть незавершённая часть монолита`);
  if (app.own > 0) {
    console.log('  ⇒ Правка features/* может менять поведение, определённое здесь.');
    console.log('    Пока own > 0, изоляция фич обеспечивается соглашением, а не границей.');
  }
}

// ── 5. Вердикт ────────────────────────────────────────────────────────
const verdict = [];
verdict.push(hard.length === 0 ? 'OK: крипто-логики в JS нет' : 'ПЛОХО: крипто-логика в JS');
verdict.push(cycles.length === 0 ? 'OK: циклов импортов нет' : `ПЛОХО: циклов импортов — ${cycles.length}`);
verdict.push(metrics.totals.protocolFiles === 0
  ? 'OK: протокольных решений в JS нет'
  : `ДОЛГ: протокольных решений в JS — ${metrics.totals.protocolSites} в ${metrics.totals.protocolFiles} модулях (держится ратчетом)`);
verdict.push(metrics.totals.appVueOwn === 0
  ? 'OK: App.vue — только делегаты'
  : `ДОЛГ: методов с логикой в App.vue — ${metrics.totals.appVueOwn}`);
console.log('\n═══ ВЕРДИКТ ═══');
verdict.forEach((v) => console.log('  ' + v));

// Крипто — ноль без обсуждений: это регресс закрытой границы (ADR-005 §2.3).
process.exit(hard.length ? 1 : 0);

// ── Вспомогательное: invoke и циклы (нужны только отчёту) ─────────────
// Регекспы объявлены ВНУТРИ функций, а не константами модуля: до них стоит
// `process.exit`, и обращение к `const` выше по телу — TDZ-ошибка, а не пустой
// результат. Инструмент, падающий вместо отчёта, ничего не измеряет.
function invokeStats() {
  const INVOKE = /invoke\(\s*'([a-z0-9_]+)'/g;
  const byFile = new Map();
  const all = new Set();
  for (const r of rows) {
    const s = readFileSync(path.join(ROOT, r.file), 'utf8');
    const cmds = [...s.matchAll(INVOKE)].map((m) => m[1]);
    byFile.set(r.file, cmds.length);
    cmds.forEach((c) => all.add(c));
  }
  return { byFile, unique: all.size };
}

// ── Циклы импортов ────────────────────────────────────────────────────
function importCycles() {
  const STATIC_IMPORT = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
  const AWAIT_IMPORT = /await import\(\s*['"]([^'"]+)['"]\s*\)/g;
  const known = new Set(rows.map((r) => path.join(ROOT, r.file)));
  const rel = (p) => path.relative(ROOT, p);
  const deps = new Map();
  for (const r of rows) {
    const s = readFileSync(path.join(ROOT, r.file), 'utf8');
    const set = new Set();
    const resolve = (spec) => {
      if (!spec.startsWith('.')) return null;
      const base = path.normalize(path.join(path.dirname(path.join(ROOT, r.file)), spec));
      return known.has(base) ? rel(base) : null;
    };
    [...s.matchAll(STATIC_IMPORT)].map((m) => m[1]).forEach((x) => { const t = resolve(x); if (t) set.add(t); });
    [...s.matchAll(AWAIT_IMPORT)].map((m) => m[1]).forEach((x) => { const t = resolve(x); if (t) set.add(t); });
    deps.set(r.file, set);
  }
  const cycles = [];
  const state = new Map();
  function dfs(node, stack) {
    if (state.get(node) === 1) { cycles.push(stack.slice(stack.indexOf(node)).concat(node)); return; }
    if (state.get(node) === 2) return;
    state.set(node, 1);
    stack.push(node);
    for (const d of deps.get(node) || []) dfs(d, stack);
    stack.pop();
    state.set(node, 2);
  }
  for (const f of rows.map((r) => r.file)) dfs(f, []);
  return cycles;
}
