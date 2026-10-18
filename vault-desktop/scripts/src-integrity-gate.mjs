// Гейт целостности исходников: в src/ не должно быть абсолютных путей и /tmp.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ГЕЙТ. 17.10 в ветке появился коммит `fix(contacts): contacts-load
// restore owner import`, который «починил» импорт так:
//
//   -import api from '../api.js';
//   +import api from "/tmp/contacts-store-smoke-mocks/api.js";
//
// Это путь к МОКУ СМОУКА, записанный в продовый модуль. rolldown разрешил
// абсолютный путь, вшил мок в бандл (`getContacts: async () => []`) — контакты
// в приложении стали пустыми, — а `npm run build` и все существующие гейты
// этого не увидели: import-gate проверяет только ОТНОСИТЕЛЬНЫЕ импорты
// копируемых смоуками модулей, и файл без относительных импортов он молча
// пропускает (`if (!relImports.length) continue`).
//
// Второй класс поломки — тот же случай с другой стороны: смоук
// `contacts-store-smoke.mjs` писал в НАСТОЯЩИЙ src/features/contacts-load.js и
// восстанавливал файл в finally. Второй запуск читал уже подменённый файл как
// «оригинал», и подмена осталась навсегда. Запись в src/ из scripts/ запрещена
// здесь же: исходник, который правит смоук, — это не исходник.
//
// Гейт дешёвый (чтение файлов) и проверяет ровно два инварианта:
//   1. ни один файл src/ не импортирует абсолютный путь и не упоминает /tmp;
//   2. ни один скрипт из scripts/ не пишет в src/.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const SCRIPTS = path.join(ROOT, 'scripts');

// ── 1. Абсолютные импорты и /tmp в src/ ────────────────────────────────
const SRC_EXT = /\.(js|mjs|vue|ts)$/;
const ABS_IMPORT = /(?:from|import)\s*\(?\s*['"](\/[^'"]*)['"]/g;
const TMP_LITERAL = /['"`][^'"`]*\/tmp\/[^'"`]*['"`]/;

const srcFiles = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (SRC_EXT.test(e)) srcFiles.push(p);
  }
})(SRC);
srcFiles.sort();

const problems = [];
for (const f of srcFiles) {
  const rel = path.relative(ROOT, f);
  const body = readFileSync(f, 'utf8');
  body.split('\n').forEach((line, i) => {
    const where = rel + ':' + (i + 1);
    for (const m of line.matchAll(ABS_IMPORT)) {
      problems.push(where + ' — абсолютный импорт ' + m[1]
        + ': путь существует только на машине автора, и сборщик вшивает по нему ЧУЖОЙ файл');
    }
    if (TMP_LITERAL.test(line)) {
      problems.push(where + ' — ссылка на /tmp в исходнике: прод не должен зависеть от временного каталога');
    }
  });
}

// ── 2. Запись в src/ из scripts/ ───────────────────────────────────────
// Список — только мутирующие вызовы: чтение src (readFileSync, copyFile —
// src → /tmp) законно и используется всеми смоуками.
//
// Проверяется ПЕРВЫЙ АРГУМЕНТ (адрес записи), а не вся строка: строка вида
// `writeFileSync(MOCKS + '/x.mjs', readFileSync(ROOT + '/src/x.js'))` пишет в
// /tmp и лишь читает src — построчная проверка «есть ли src в строке»
// объявляла бы исправный смоук сломанным (та же ловушка, что в import-gate с
// ложными срабатываниями — врущий гейт отключают).
const MUTATORS = /(writeFileSync|appendFileSync|unlinkSync|rmSync|rmdirSync|createWriteStream|truncateSync|renameSync|chmodSync)\s*\(/g;
const TOUCHES_SRC = /['"`][^'"`]*\/?src\//;

// Первый аргумент вызова: от открывающей скобки до запятой/закрывающей скобки
// верхнего уровня (с учётом строковых литералов и вложенных скобок).
function firstArg(body, openParen) {
  let depth = 0, i = openParen + 1, quote = null;
  for (; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return body.slice(openParen + 1, i);
}

const scriptFiles = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(mjs|js|cjs)$/.test(e)) scriptFiles.push(p);
  }
})(SCRIPTS);
scriptFiles.sort();

for (const f of scriptFiles) {
  const rel = path.relative(ROOT, f);
  const body = readFileSync(f, 'utf8');
  for (const m of body.matchAll(MUTATORS)) {
    const openParen = m.index + m[0].length - 1;
    const dest = firstArg(body, openParen);
    if (!TOUCHES_SRC.test(dest)) continue;
    const line = body.slice(0, openParen).split('\n').length;
    problems.push(rel + ':' + line + ' — скрипт пишет в src/: ' + dest.trim().slice(0, 120));
  }
}

// Ноль проверенных файлов — это не «чисто», а «гейт ничего не проверил»
// (та же ловушка, что описана в import-gate).
if (srcFiles.length < 20 || scriptFiles.length < 20) {
  console.log('✗ src-integrity: проверять нечего — найдено файлов src: '
    + srcFiles.length + ', scripts: ' + scriptFiles.length);
  process.exit(1);
}

if (problems.length) {
  console.log('✗ src-integrity: ' + problems.length + ' проблем(ы)');
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('✓ src-integrity: ' + srcFiles.length + ' файлов src без абсолютных путей и /tmp, '
  + scriptFiles.length + ' скриптов не пишут в src/');
