// Аудит границы Rust/JS и изоляции модулей (vault-desktop).
//
// Зачем отдельный инструмент, а не «посмотреть глазами». Три вопроса, на
// которые нужен ОТВЕТ, а не впечатление:
//   1. Осталась ли в JS логика, которой место в Rust (крипто-математика,
//      протокольные решения, машины состояний)?
//   2. Связаны ли фичи между собой — то есть сломает ли правка одной соседнюю?
//   3. Есть ли циклы в графе модулей? Цикл = правка одного файла может
//      сломать инициализацию другого, причём не в том месте, где правили.
//
// Каждая метрика считается из исходников и воспроизводится: `npm run
// audit:arch`. Числа в отчёте без прогона — мнение, а не измерение.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'src');
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.js')) files.push(p);
  }
})(ROOT);
files.sort();

const rel = (p) => path.relative(ROOT, p);
const src = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

// ── 1. Граница Rust/JS ────────────────────────────────────────────────
// Признаки логики, которая обязана быть в Rust. Каждый — с привязкой к ADR:
// крипто-математика и протокол в JS означают, что JS доверенная сторона.
const LOGIC_MARKERS = [
  { id: 'crypto-subtle', re: /crypto\.subtle\.(importKey|deriveKey|encrypt|decrypt|sign|verify|digest)/g,
    why: 'крипто-операция в JS: WebView получает ключи' },
  { id: 'bitwise-b64', re: /atob\(|btoa\(|Uint8Array\(|Buffer\.from\(/g,
    why: 'ручная работа с байтами: транспортная кодировка допустима, крипто-разбор — нет',
    soft: true },
  { id: 'hmac-sha', re: /createHmac|createHash|subtle\.digest\(['"]SHA-?/g,
    why: 'своя хеш-функция вместо Rust' },
  { id: 'pbkdf', re: /pbkdf2|scrypt|argon2/i,
    why: 'KDF в JS' },
];

const INVOKE = /invoke\(\s*'([a-z0-9_]+)'/g;
const CTX_REF = /\bctx\.[a-zA-Z_$][\w$]*/g;
const AWAIT_IMPORT = /await import\(\s*['"]([^'"]+)['"]\s*\)/g;
const STATIC_IMPORT = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;

const rows = [];
const invokes = new Map();
for (const f of files) {
  const s = src.get(f);
  const lines = s.split('\n').length;
  const inv = [...s.matchAll(INVOKE)].map((m) => m[1]);
  inv.forEach((c) => invokes.set(c, (invokes.get(c) || 0) + 1));
  const ctx = [...s.matchAll(CTX_REF)].length;
  const stat = [...s.matchAll(STATIC_IMPORT)].map((m) => m[1]);
  const dyn = [...s.matchAll(AWAIT_IMPORT)].map((m) => m[1]);
  const hits = LOGIC_MARKERS.map((m) => ({ id: m.id, why: m.why, soft: !!m.soft, n: (s.match(m.re) || []).length }))
    .filter((h) => h.n > 0);
  rows.push({ f: rel(f), lines, inv: inv.length, cmds: [...new Set(inv)], ctx, stat, dyn, hits });
}

console.log('═══ 1. ГРАНИЦА RUST/JS ═══\n');
// Хит помнит свой файл: `rows.flatMap(r => r.hits)` отдавал хит БЕЗ имени файла,
// и цикл ниже падал с TypeError (`r.hits` у хита нет) — весь аудит архитектуры
// не запускался, возвращая трейс вместо отчёта.
const hard = rows.flatMap((r) => r.hits.filter((h) => !h.soft).map((h) => ({ ...h, f: r.f })));
if (hard.length === 0) {
  console.log('  ✓ Крипто-логики в JS нет: ни HMAC, ни KDF, ни subtle.encrypt/sign.');
} else {
  for (const h of hard) console.log(`  ✗ ${h.f}: ${h.id} ×${h.n} — ${h.why}`);
}
const soft = rows.flatMap((r) => r.hits.filter((h) => h.soft));
console.log(`\n  Байтовая работа в JS (допустима как транспорт): ${soft.reduce((a, b) => a + b.n, 0)} вхождений`);
console.log('  Распределение invoke по модулям (топ-10 по вызовам):');
rows.slice().sort((a, b) => b.inv - a.inv).slice(0, 10)
  .forEach((r) => console.log(`    ${String(r.inv).padStart(4)}  ${r.f}`));
console.log(`\n  Всего уникальных Rust-команд из JS: ${invokes.size}`);
console.log(`  Модулей JS: ${rows.length}, строк: ${rows.reduce((a, b) => a + b.lines, 0)}`);

// ── 2. Изоляция модулей: циклы в графе импортов ───────────────────────
// Цикл в ES-модулях не падает, но делает порядок инициализации частью
// контракта: правка одного файла может сломать другой не там, где правили.
// Разделитель ключа «откуда → куда» в паре динамических рёбер. Пишется
// escape-последовательностью, а не сырым байтом: сырой NUL в исходнике
// делает файл бинарным для grep и молча ломает чтение редактором.
const SEP = '\u0000';
const deps = new Map();
const dynamicEdges = new Set();
for (const r of rows) {
  const set = new Set();
  const resolve = (spec) => {
    if (!spec.startsWith('.')) return null;
    const base = path.normalize(path.join(path.dirname(path.join(ROOT, r.f)), spec));
    return files.includes(base) ? rel(base) : null;
  };
  // Ключ ребра — ЧИСТЫЙ путь. Раньше динамические помечались суффиксом
  // ' (динамич.)', и такой ключ не совпадал с ключом в deps — обход по ним
  // молча не шёл, а отчёт радостно писал «циклов нет». Отсутствие цикла,
  // которого инструмент не умеет видеть, опаснее самого цикла.
  r.stat.forEach((s) => { const t = resolve(s); if (t) set.add(t); });
  r.dyn.forEach((s) => {
    const t = resolve(s);
    if (t) { set.add(t); dynamicEdges.add(r.f + SEP + t); }
  });
  deps.set(r.f, set);
}

const cycles = [];
const state = new Map();
function dfs(node, stack) {
  if (state.get(node) === 1) {
    cycles.push(stack.slice(stack.indexOf(node)).concat(node));
    return;
  }
  if (state.get(node) === 2) return;
  state.set(node, 1);
  stack.push(node);
  for (const d of deps.get(node) || []) dfs(d, stack);
  stack.pop();
  state.set(node, 2);
}
for (const f of rows.map((r) => r.f)) dfs(f, []);

console.log('\n═══ 2. ИЗОЛЯЦИЯ: ЦИКЛЫ ИМПОРТОВ ═══\n');
if (cycles.length === 0) {
  console.log('  ✓ Циклов импортов нет.');
} else {
  console.log(`  ✗ Циклов: ${cycles.length}. Каждый — правка одного модуля может сломать другой:`);
  for (const c of cycles) {
    console.log('    ' + c.map((n, i) => {
      const dyn = dynamicEdges.has(c[i] + SEP + n) ? '  [динамич.]' : '';
      return n + dyn;
    }).join(' → '));
  }
}

// ── 3. Связность через общее состояние ctx ────────────────────────────
// Модули, тянущие один и тот же ctx, — не модули, а клиенты одной сущности.
console.log('\n═══ 3. ОБЩЕЕ СОСТОЯНИЕ (ctx) ═══\n');
const withCtx = rows.filter((r) => r.ctx > 0).sort((a, b) => b.ctx - a.ctx);
const totalCtx = withCtx.reduce((a, b) => a + b.ctx, 0);
console.log(`  Всего ссылок ctx: ${totalCtx} в ${withCtx.length} модулях`);
for (const r of withCtx.slice(0, 10)) {
  console.log(`    ${String(r.ctx).padStart(4)}  ${r.f}  (${r.lines} строк, ${Math.round((r.ctx / r.lines) * 100)}% строк)`);
}

// ── 4. App.vue: сколько логики ещё в монолите ─────────────────────────
// «Логика вынесена в фичи» проверяется не по факту наличия features/*, а по
// доле методов App.vue, которые являются чистыми делегатами. Остальное —
// логика, живущая в компоненте, то есть ровно то, что делает правку одной
// фичи риском для соседей.
console.log('\n═══ 4. МОНОЛИТ App.vue ═══\n');
const appPath = path.join(ROOT, 'App.vue');
if (files.includes(appPath) || true) {
  const app = readFileSync(appPath, 'utf8');
  const appLines = app.split('\n');
  const ms = appLines.findIndex((l) => l.trim() === 'methods: {');
  if (ms < 0) {
    console.log('  блок methods не найден — структура изменилась, поправь аудит');
  } else {
    let depth = 0, me = ms;
    for (let i = ms; i < appLines.length; i++) {
      depth += (appLines[i].match(/{/g) || []).length - (appLines[i].match(/}/g) || []).length;
      if (depth === 0 && i > ms) { me = i; break; }
    }
    const block = appLines.slice(ms + 1, me);
    const MM = /^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/;
    // Делегат — метод, тело которого РОВНО `return <любой модуль>.<тот же>(<те же аргументы>);`.
    // Раньше здесь жёстко искалось `Feature.`, и после ADR-003 Этапа 3 (делегаты
    // в MsgFormat/MsgStore) метрика замерла на 178, хотя 10 методов вынесли.
    // Метрика, которая не двигается вместе с работой, вредна: она сообщает
    // «прогресса нет» там, где прогресс есть, и за этим перестают смотреть.
    // Делегат — метод, тело которого это ровно один вызов
    // `return <модуль>.<функция>(...);` и ничего больше.
    // Правило намеренно простое. Сначала здесь искалось жёстко `Feature.` —
    // метрика замерла на 178, когда 10 методов уехали в MsgFormat/MsgStore.
    // Потом я ужесточил до посимвольного совпадения аргументов — получил 23
    // вместо 164. Метрика, которая не двигается вместе с работой, вредна: она
    // сообщает «прогресса нет» там, где прогресс есть, и за ней перестают
    // смотреть. Несовпадение аргументов — отдельный запах, считается ниже.
    const DELEG_RE = /^\s*return\s+[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([^;]*\);\s*$/;
    const isDeleg = (_name, _args, body) => DELEG_RE.test(body);
    let deleg = 0, own = 0, total = 0;
    // Тело метода — между первой { и ПОСЛЕДНЕЙ }. Срез по последней скобке
    // обязателен: у однострочного метода строка кончается на «};», и наивный
    // срез по первой { оставлял хвост «}», из-за чего ни один делегат не
    // распознавался (0 вместо 153).
    const inner = (s) => {
      const a = s.indexOf('{'), b = s.lastIndexOf('}');
      return a < 0 || b < a ? '' : s.slice(a + 1, b);
    };
    for (let i = 0; i < block.length; i++) {
      const m = MM.exec(block[i]);
      if (!m) continue;
      const [, name, args] = m;
      const bal = (block[i].match(/{/g) || []).length - (block[i].match(/}/g) || []).length;
      if (bal <= 0) {
        if (isDeleg(name, args, inner(block[i]))) deleg++; else own++;
        total++;
        continue;
      }
      let b = bal, j = i + 1;
      while (j < block.length && b > 0) {
        b += (block[j].match(/{/g) || []).length - (block[j].match(/}/g) || []).length;
        j++;
      }
      if (isDeleg(name, args, inner(block.slice(i, j).join('\n')))) deleg++; else own++;
      total++;
      i = j - 1;
    }
    const pct = total ? Math.round((deleg / total) * 100) : 0;
    console.log(`  App.vue: ${appLines.length} строк, блок methods — ${me - ms - 1} строк, методов ${total}`);
    console.log(`  делегатов в модули: ${deleg} (${pct}%)`);
    console.log(`  методов с собственной логикой: ${own} (${100 - pct}%) — это и есть незавершённая часть монолита`);
    if (own > 0) {
      console.log('  ⇒ Правка features/* может менять поведение, определённое здесь.');
      console.log('    Пока own > 0, изоляция фич обеспечивается соглашением, а не границей.');
    }
  }
}

// ── 5. Вердикт ────────────────────────────────────────────────────────
const verdict = [];
verdict.push(hard.length === 0 ? 'OK: крипто-логики в JS нет' : 'ПЛОХО: крипто-логика в JS');
verdict.push(cycles.length === 0 ? 'OK: циклов импортов нет' : `ПЛОХО: циклов импортов — ${cycles.length}`);
console.log('\n═══ ВЕРДИКТ ═══');
verdict.forEach((v) => console.log('  ' + v));