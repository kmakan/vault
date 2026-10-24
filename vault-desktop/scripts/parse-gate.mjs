// Гейт разбора: ЛЮБОЙ скрипт инструментов обязан быть синтаксически целым.
//
// ЗАЧЕМ. Проверки приёмки — такой же код, как приложение, но его не собирает
// ни vite, ни cargo. 24.10 правка пробы `flags` в scripts/device-accept.mjs
// оставила файл с незакрытым литералом: приёмка на телефоне падала на
// `SyntaxError: Unexpected end of input`, а все гейты перед этим были зелёные —
// они этот файл не парсят. Сломанный проверочный скрипт молчит ровно до того
// момента, когда должен был что-то поймать, то есть ведёт себя как «проверка
// прошла».
//
// ЧТО ПРОВЕРЯЕТ. `node --check` по каждому .mjs в scripts/ (рекурсивно: смоуки,
// гейты, наборы мутаций, библиотеки двойников). Разбор без выполнения — тесты
// запускаются своими гейтами, здесь только синтаксис.
//
// ЗАПУСК: node scripts/parse-gate.mjs
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPTS = path.resolve(import.meta.dirname);
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'gen']);

function collect(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) collect(full, out);
    } else if (name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = collect(SCRIPTS, []).sort();
const broken = [];
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    const first = (r.stderr || '').split('\n').find((l) => l.trim()) || 'не разобран';
    broken.push(path.relative(path.resolve(SCRIPTS, '..'), file) + ': ' + first);
  }
}

console.log(`▸ parse-gate: файлов ${files.length}`);
if (broken.length) {
  for (const b of broken) console.error('  ✗ ' + b);
  console.error('\n✗ parse-gate: проверочный скрипт не разбирается — он не может ничего проверить');
  process.exit(1);
}
console.log(`✓ parse-gate: все ${files.length} скриптов разбираются`);
