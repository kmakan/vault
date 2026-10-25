// Подбор минимальных уникальных контекстов для амбивалентных паттернов мутаций.
//
// ЗАЧЕМ. Движок мутаций берёт ПЕРВОЕ совпадение паттерна (`src.replace`).
// Если строка встречается в коде несколько раз, набор молча меряет только
// первое место, а остальные живут без проверки — и `--check-patterns` об этом
// только предупреждает. Этот помощник по имени мутации печатает для каждого
// совпадения минимальный блок (вверх/вниз по строкам), который встречается
// ровно один раз, — его остаётся вставить в набор как pattern/replacement.
//
// ЗАПУСК (из vault-desktop; пути наборов — относительно него):
//   node scripts/mutations/context.mjs scripts/rust-mutations/sets/<набор>.mjs "имя мутации" ["имя 2" …]
// Только чтение исходников + печать кандидатов; ничего не меняет.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [,, setPath, ...names] = process.argv;
const set = (await import('file://' + path.resolve(setPath))).default;
const src = readFileSync(path.isAbsolute(set.file) ? set.file : path.resolve('..', set.file), 'utf8');
const lines = src.split('\n');

function count(s) { return src.split(s).length - 1; }

for (const m of set.mutations) {
  if (!names.includes(m.name)) continue;
  const hits = lines.map((l, i) => [i, l]).filter(([, l]) => l === m.pattern);
  console.log('\n### ' + m.name + '  x' + count(m.pattern) + '  совпадений ровно ' + hits.length);
  hits.forEach(([idx]) => {
    let best = null;
    for (let up = 0; up <= 5 && !best; up++) {
      for (let down = 0; down <= 2 && !best; down++) {
        const block = lines.slice(idx - up, idx + down + 1).join('\n');
        if (block.includes(m.pattern) && count(block) === 1 && lines[idx - up].trim() !== '') best = { block, up, down };
      }
    }
    if (!best) { console.log('  L' + (idx + 1) + ' — НЕ НАЙДЕН уникальный контекст (up<=5, down<=2)'); return; }
    console.log('  L' + (idx + 1) + '  вверх=' + best.up + ' вниз=' + best.down);
    console.log('  pattern: ' + JSON.stringify(best.block));
    // замена: тот же блок, но целевая строка → replacement
    const mutated = best.block.split(m.pattern).join(m.replacement);
    console.log('  repl:    ' + JSON.stringify(mutated));
  });
}
