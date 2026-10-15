import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Извлекает методы App.vue В ФАЙЛ БЕЗ ПЕРЕПЕЧАТЫВАНИЯ.
//
// Почему генератор, а не копирование руками: тело функции, переписанное
// вручную, — это новый код, а не тот же самый. Опечатка в регулярке linkify
// или в списке расширений isTextMime не выглядит как ошибка и проходит
// ревью глазом. Здесь тело переносится символ в символ; единственное
// изменение — отступ (4 пробела) и префикс export.
//
// Использование: node scripts/extract-appvue-methods.mjs out.js name1 name2 ...

const [outFile, ...names] = process.argv.slice(2);
if (!outFile || !names.length) {
  console.error('usage: extract-appvue-methods.mjs out.js name1 name2 ...');
  process.exit(2);
}
const P = path.resolve(import.meta.dirname, '..', 'src', 'App.vue');
const lines = readFileSync(P, 'utf8').split('\n');
const start = lines.findIndex((l) => l.trim() === 'methods: {');
let depth = 0, end = start;
for (let i = start; i < lines.length; i++) {
  depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
  if (depth === 0 && i > start) { end = i; break; }
}
const block = lines.slice(start + 1, end);
const M = /^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/;

const out = [];
const found = [];
for (let i = 0; i < block.length; i++) {
  const m = M.exec(block[i]);
  if (!m) continue;
  const [, name, args] = m;
  if (!names.includes(name)) { i = (() => { let b = (block[i].match(/{/g) || []).length - (block[i].match(/}/g) || []).length, j = i + 1; while (b > 0 && j < block.length) { b += (block[j].match(/{/g) || []).length - (block[j].match(/}/g) || []).length; j++; } return j - 1; })(); continue; }
  let b = (block[i].match(/{/g) || []).length - (block[i].match(/}/g) || []).length;
  let j = i + 1;
  while (b > 0 && j < block.length) {
    b += (block[j].match(/{/g) || []).length - (block[j].match(/}/g) || []).length;
    j++;
  }
  const body = block.slice(i, j);
  // Отнимаем 4 пробела отступа метода — тело переезжает на уровень модуля.
  const dedented = body.map((l) => (l.startsWith('    ') ? l.slice(4) : l));
  // Первая строка: сигнатура метода → экспортная функция.
  dedented[0] = `export ${/^\s{4}async\s/.test(body[0]) ? 'async ' : ''}function ${name}(${args}) {`;
  dedented[dedented.length - 1] = '}';   // вместо '},'
  out.push(dedented.join('\n'));
  found.push(`${name} (App.vue L${start + 2 + i}, ${j - i} строк)`);
  i = j - 1;
}

const missing = names.filter((n) => !found.some((f) => f.startsWith(n + ' ')));
if (missing.length) {
  console.error('НЕ НАЙДЕНЫ в App.vue: ' + missing.join(', '));
  process.exit(1);
}
writeFileSync(outFile, out.join('\n\n') + '\n', 'utf8');
console.log(`извлечено в ${outFile}:`);
found.forEach((f) => console.log('  ' + f));