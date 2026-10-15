import { readFileSync } from 'node:fs';
import path from 'node:path';

const P = path.resolve(import.meta.dirname, '..', 'src', 'App.vue');
const lines = readFileSync(P, 'utf8').split('\n');
const start = lines.findIndex((l) => l.trim() === 'methods: {');
let depth = 0, end = start;
for (let i = start; i < lines.length; i++) {
  depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
  if (depth === 0 && i > start) { end = i; break; }
}
const block = lines.slice(start + 1, end);
const M = /^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/;

const methods = [];
for (let i = 0; i < block.length; i++) {
  const m = M.exec(block[i]);
  if (!m) continue;
  // exec() в JS возвращает плоский массив: группа — m[1], а не m.group(1).
  const name = m[1];
  const line0 = start + 2 + i;
  let b = (block[i].match(/{/g) || []).length - (block[i].match(/}/g) || []).length;
  if (b <= 0) {
    // body сохраняем и для однострочных: дальше считается this.* по нему.
    methods.push({ name, line: line0, n: 1, deleg: /Feature\./.test(block[i]), body: block[i] });
    continue;
  }
  let j = i + 1;
  while (j < block.length && b > 0) {
    b += (block[j].match(/{/g) || []).length - (block[j].match(/}/g) || []).length;
    j++;
  }
  const body = block.slice(i, j).join('\n');
  const isDeleg = /^\s*return\s+\w+Feature\.\w+\(.*\);?\s*\}?\s*$/m.test(body)
    && (body.match(/Feature\./g) || []).length === 1;
  methods.push({ name, line: line0, n: j - i, deleg: isDeleg, body });
  i = j - 1;
}

const own = methods.filter((m) => !m.deleg);
// Считаем РЕАЛЬНЫЕ зависимости this.*, а не по списку-эвристике: стоимость
// выноса определяется числом того, что методу надо передать. Метод с 30 this.X
// и метод без единого this.X — это принципиально разная работа, и выбирать
// надо по второй величине.
for (const m of own) {
  const deps = new Set();
  for (const x of m.body.matchAll(/\bthis\.([A-Za-z_$][\w$]*)/g)) deps.add(x[1]);
  m.deps = [...deps];
  m.cost = m.n + m.deps.length * 2; // грубая, но монотонная оценка трудозатрат
}
const byCost = own.slice().sort((a, b) => a.cost - b.cost);
console.log(`методов всего ${methods.length}, делегатов ${methods.length - own.length}, ` +
            `со своей логикой ${own.length}\n`);
console.log('=== самые ДЕШЁВЫЕ для выноса: много строк, мало this.* ===');
console.log('    (сначала они: поведение проверяемо, риск минимален, объём есть)');
for (const m of byCost.filter((x) => x.n >= 20).slice(0, 22)) {
  console.log(`  ${String(m.n).padStart(3)} ст  this×${String(m.deps.length).padStart(2)}  ` +
              `L${String(m.line).padStart(5)}  ${m.name.padEnd(28)} ${m.deps.slice(0, 6).join(',')}`);
}
const zero = own.filter((m) => m.deps.length === 0);
console.log(`\nметодов вообще без this.*: ${zero.length}, строк ${zero.reduce((a, b) => a + b.n, 0)}`);
console.log('  →', zero.slice(0, 20).map((m) => `${m.name}(${m.n})`).join(', '));
const totalOwn = own.reduce((a, b) => a + b.n, 0);
console.log(`\nстрок в методах со своей логикой: ${totalOwn} из ${end - start - 1} (блок methods)`);