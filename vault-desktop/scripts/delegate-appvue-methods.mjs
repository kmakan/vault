import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Заменяет тела методов App.vue на однострочные делегаты — по той же причине,
// по которой извлечение дословное: переписанный вручную список аргументов
// расходится с телом (забытый аргумент, переставленный порядок) и ошибка
// выглядит как обычный код.
//
// Формат замены: `имя(арг1, арг2)` → `имя(арг1, арг2) { return M.имя(арг1, арг2); }`
// с сохранением префикса `async`.
//
// Использование: node scripts/delegate-appvue-methods.mjs M importSpec name1 name2 ...

const [importSpec, ...names] = process.argv.slice(2);
if (!importSpec || !names.length) {
  console.error('usage: delegate-appvue-methods.mjs "M = import(...)" name1 name2 ...');
  process.exit(2);
}
// У String нет .count — считаем вхождения подстроки явно.
const count = (s, ch) => s.split(ch).length - 1;
const P = path.resolve(import.meta.dirname, '..', 'src', 'App.vue');
const lines = readFileSync(P, 'utf8').split('\n');
const M = /^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/;

let changed = [];
for (let i = 0; i < lines.length; i++) {
  const m = M.exec(lines[i]);
  if (!m) continue;
  const [, name, args] = m;
  if (!names.includes(name)) continue;
  const isAsync = /^\s{4}async\s/.test(lines[i]);
  // Ищем конец метода по скобкам.
  let b = count(lines[i], '{') - count(lines[i], '}');
  let j = i + 1;
  while (b > 0 && j < lines.length) {
    b += count(lines[j], '{') - count(lines[j], '}');
    j++;
  }
  if (b !== 0) {
    console.error(`НЕЗАКРЫТЫЙ метод ${name} (строка ${i + 1}) — правку отменяю`);
    process.exit(1);
  }
  const sig = `    ${isAsync ? 'async ' : ''}${name}(${args}) { return ${importSpec}.${name}(${args}); },`;
  lines.splice(i, j - i, sig);
  changed.push(`${name} (${j - i} строк → 1)`);
  // i не двигаем: splice сдвинул всё выше на j-i-1
  i -= (j - i - 1);
}
const missing = names.filter((n) => !changed.some((c) => c.startsWith(n + ' ')));
if (missing.length) {
  console.error('НЕ НАЙДЕНЫ: ' + missing.join(', '));
  process.exit(1);
}
writeFileSync(P, lines.join('\n'), 'utf8');
console.log('заменено на делегаты:');
changed.forEach((c) => console.log('  ' + c));