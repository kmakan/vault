// ГЕЙТ ЦИКЛОВ ИМПОРТОВ. Блокирует сборку, если в src/ появился цикл.
//
// Почему это отдельный файл, а не строка в ctx-coupling-gate: тот меряет
// СВЯЗНОСТЬ (сколько ctx-ссылок) и пропускает рост по baseline. Цикл —
// качественная ошибка, а не число: он делает порядок инициализации частью
// контракта, и правка одного файла ломает другой не там, где правили.
// Числовой baseline такое не ловит по определению.
//
// Что уже случилось без этого гейта (обоснование, а не гипотеза):
//   · audit-arch нашёл 3 цикла, все через relay-client.js;
//   · оба корня были перекрёстными нуждами низкого уровня
//     (channelTokens внутри фичи, accountNamespace внутри api.js);
//   · убраны переносом в примитивы channels-tokens.js и identity.js.
//
// Файл fail-closed: любая ошибка разбора считается РЕЗУЛЬТАТОМ. Молчаливый
// «гейт ничего не нашёл» хуже отсутствия гейта — он выглядит как чистота.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'src');
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.js') || e.endsWith('.vue')) files.push(p);
  }
})(ROOT);
files.sort();
const rel = (p) => path.relative(ROOT, p);
const read = (p) => readFileSync(p, 'utf8');

// .vue разбираем только на <script>: шаблон не содержит импортов, а разбирать
// его регуляркой значит завести ещё один источник ложных срабатываний.
const text = (p) => {
  const s = read(p);
  if (!p.endsWith('.vue')) return s;
  const m = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let out = '', x;
  while ((x = m.exec(s))) out += x[1] + '\n';
  return out;
};

const STATIC = /^\s*import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm;
const DYNAMIC = /await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;

const deps = new Map();
for (const f of files) {
  const s = text(f);
  const set = new Set();
  for (const re of [STATIC, DYNAMIC]) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const base = path.normalize(path.join(path.dirname(f), spec));
      if (files.includes(base)) set.add(rel(base));
    }
  }
  deps.set(rel(f), set);
}

const cycles = [];
const state = new Map();
const stack = [];
function visit(node) {
  const st = state.get(node);
  if (st === 1) { cycles.push(stack.slice(stack.indexOf(node)).concat(node)); return; }
  if (st === 2) return;
  state.set(node, 1);
  stack.push(node);
  for (const d of deps.get(node) || []) visit(d);
  stack.pop();
  state.set(node, 2);
}
for (const f of [...deps.keys()].sort()) visit(f);

if (cycles.length) {
  console.error('✗ ctx-cycles: найдены циклы импортов (правка одного модуля ломает другой):');
  const seen = new Set();
  for (const c of cycles) {
    const key = c.join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    console.error('    ' + c.join(' → '));
  }
  console.error('  Как чинить: примитив, который нужен двум слоям, живёт НИЖЕ обоих.');
  console.error('  Примеры: channels-tokens.js, identity.js, crypto.js.');
  process.exit(1);
}
console.log(`✓ ctx-cycles: циклов нет (${deps.size} модулей, ${[...deps.values()].reduce((a, s) => a + s.size, 0)} рёбер)`);
