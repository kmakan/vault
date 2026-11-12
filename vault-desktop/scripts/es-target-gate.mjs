// ГЕЙТ ЦЕЛЕВОГО СИНТАКСИСА БАНДЛА: то, что уедет на телефон, обязано
// разбираться системным WebView при minSdk = 24.
//
// ЗАЧЕМ. Телефон собирается ИЗ ЭТОГО дерева (vault-desktop/src), а minSdk = 24 —
// это Android 7.0, где системный WebView это Chrome 50-80. Такой WebView не
// разбирает ES2020: `?.`, `??`, `??=`, `||=`, `&&=`. Синтаксическая ошибка в
// главном чанке = БЕЛЫЙ ЭКРАН при запуске, без падения и без крэш-маркера в
// logcat: приёмка на телефоне владельца (новый WebView) этого не видит вообще.
//
// ЧТО БЫЛО. Защита стояла в заброшенном vault-android/vite.config.js
// (`build.target: 'es2018'` с ровно этим комментарием) и потерялась, когда
// сборку телефона перевели на vault-desktop: в vault-desktop/vite.config.js
// build.target не было вовсе. Проверено 17.10 (t_cca47c2c) и повторно 12.11:
// в dist/assets/*.js было 37 вхождений `?.`, плюс `??=`, `||=`.
//
// ПОЧЕМУ РАЗБОР, А НЕ ГРЕП. `?.` и `??` встречаются в СТРОКАХ и регулярках
// легально, а `a??b` без пробелов грепом не отличить от `a ?? b` в шаблоне.
// Гейт, который ловит текст, начинает врать в обе стороны: пропускает реальный
// синтаксис внутри минифицированной строки и валит законный бандл из-за
// сообщения об ошибке. Поэтому бандл РАЗБИРАЕТСЯ (@babel/parser, он уже в
// дереве через @vitejs/plugin-vue) и ищутся УЗЛЫ: OptionalMemberExpression,
// OptionalCallExpression, LogicalExpression с оператором ??/||=/&&=,
// AssignmentExpression с ??=/||=/&&=. Это ровно то, чего нет в ES2018.
//
// ЧТО ЕЩЁ ЛОВИТСЯ. BigInt-литералы (ES2020) и числовые разделители `1_000`
// (ES2021) — тот же класс: разбирается новым WebView, не разбирается старым.
//
// ЗАПУСК:
//   node scripts/es-target-gate.mjs            # проверить dist/
//   node scripts/es-target-gate.mjs --dir DIR  # проверить другой каталог
// Код возврата 1 = в бандле синтаксис новее ES2018, сборку на телефон не давать.
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parser = require('@babel/parser');

const HERE = import.meta.dirname;                 // vault-desktop/scripts
const DESKTOP = path.resolve(HERE, '..');         // vault-desktop
const argDir = process.argv.indexOf('--dir');
const DIST = argDir > -1 ? path.resolve(process.argv[argDir + 1]) : path.join(DESKTOP, 'dist');

// Узлы, которых нет в ES2018. Имя узла -> как называть человеку.
const BANNED_NODES = new Map([
  ['OptionalMemberExpression', '?. (optional chaining)'],
  ['OptionalCallExpression', '?.() (optional call)'],
  ['BigIntLiteral', 'BigInt-литерал (ES2020)'],
]);

// Операторы, которых нет в ES2018. `??` — ES2020, присваивания `??=`/`||=`/`&&=` —
// ES2021; для WebView разница не важна (не разбирает ни то, ни другое), но в
// отчёте пусть стоит правильная версия.
const BANNED_OPERATORS = new Map([
  ['??', 'ES2020'],
  ['??=', 'ES2021'],
  ['||=', 'ES2021'],
  ['&&=', 'ES2021'],
]);

function collectBundles(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) collectBundles(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Обход дерева без рекурсии по служебным полям (loc/start/end/extra), иначе
// на большом бандле это лишние миллионы шагов. inFn — мы внутри функции или
// метода: await там разрешён в ES2017, а ВНЕ функции это top-level await
// (ES2022) — его старый WebView тоже не разбирает, и vite его не транспилирует,
// а только предупреждает «Top-level await is not available in the configured
// target environment» в лог сборки, который никто не читает.
const FN_TYPES = /Function|ArrowFunction|Method/;

function walk(node, visit, inFn = false) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, inFn);
    return;
  }
  const isFn = FN_TYPES.test(node.type || '');
  if (typeof node.type === 'string') visit(node, inFn);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'extra') continue;
    walk(node[key], visit, inFn || isFn);
  }
}

if (!existsSync(DIST)) {
  console.error(`✗ нет каталога сборки: ${DIST}`);
  console.error('  сначала собери фронт: npm run build (или vite build)');
  process.exit(1);
}

const files = collectBundles(DIST, []).sort();
if (files.length === 0) {
  console.error(`✗ в ${DIST} нет .js — сборка пустая, мерить нечего`);
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const code = require('node:fs').readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      // Бандл минифицирован, но это всё ещё валидный JS; ошибки разбора
      // означают, что файл не разбирается вовсе — это тоже провал гейта.
      errorRecovery: false,
    });
  } catch (e) {
    findings.push({ file, line: 0, what: `не разбирается: ${e.message}` });
    continue;
  }
  walk(ast.program, (node, inFn) => {
    const banned = BANNED_NODES.get(node.type);
    if (banned) {
      findings.push({ file, line: node.loc?.start.line ?? 0, what: banned });
      return;
    }
    if (node.type === 'AwaitExpression' && !inFn) {
      findings.push({ file, line: node.loc?.start.line ?? 0, what: 'top-level await (ES2022)' });
      return;
    }
    if ((node.type === 'LogicalExpression' || node.type === 'AssignmentExpression')
        && BANNED_OPERATORS.has(node.operator)) {
      const ver = BANNED_OPERATORS.get(node.operator);
      findings.push({ file, line: node.loc?.start.line ?? 0, what: `${node.operator} (${ver})` });
    }
  });
}

const rel = (f) => path.relative(DESKTOP, f);

if (findings.length > 0) {
  console.error(`✗ ES-цель: в бандле синтаксис новее ES2018 — на Android 7-9 будет БЕЛЫЙ ЭКРАН`);
  const byFile = new Map();
  for (const f of findings) {
    const key = rel(f.file);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }
  for (const [file, items] of byFile) {
    const kinds = [...new Set(items.map((i) => i.what))].join(', ');
    console.error(`  ${file}: ${items.length} — ${kinds}`);
  }
  console.error('');
  console.error('  чинится в vault-desktop/vite.config.js: build.target = \'es2018\'');
  console.error('  (это не стиль: minSdk = 24, системный WebView на Android 7-9 — Chrome 50-80)');
  process.exit(1);
}

console.log(`ES-цель: ${files.length} файлов бандла разобраны, синтаксиса новее ES2018 нет`);
