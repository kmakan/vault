#!/usr/bin/env node
/*
 * Vault: статический анализатор шаблонов Vue SFC — на официальном компиляторе
 * (@vue/compiler-sfc) + @babel/parser (AST). Ловит классы «молчаливых
 * поломок», которые не видны ни линтеру, ни в проде:
 *
 *   E1     идентификатор в шаблоне не входит в bindings (data/computed/
 *          methods/props/setup) → клик/биндинг молча неработоспособен.
 *   E1-src не-функция, объявленная в methods{} — Vue дропает её в проде
 *          (молча): поля состояния обязаны жить в data().
 *   E2     template ref, использованный в выражении без $refs. —
 *          Vue 3 резолвит имя как поле инстанса → undefined →
 *          guard-клик молча ничего не делает (баг «Файл» 05.09–11.09).
 *   E3     модульный импорт, вызванный в шаблоне Options API —
 *          шаблон видит только свойства инстанса (баг openExternal).
 *
 * E2/E3 — частные случаи E1, но метятся отдельно: разные фиксы.
 * Запуск: node scripts/check-template.cjs [файлы...] (по умолчанию src/).
 * Выход: 0 = OK; 1 = проблемы (сборка падает).
 */
const fs = require('fs');
const path = require('path');
const { parse: sfcParse, compileScript, compileTemplate } = require('@vue/compiler-sfc');
const babel = require('@babel/parser');

function listVueFiles(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.vue')) out.push(p);
    }
  })(root);
  return out;
}

/* Не-функции верхнего уровня в methods{} — по настоящему AST. */
function nonFunctionsInMethods(scriptContent, file, problems) {
  if (!scriptContent) return [];
  let ast;
  try {
    ast = babel.parse(scriptContent.replace(/^export default/m, 'var __C ='),
      { sourceType: 'module' });
  } catch (e) {
    problems.push(`${file}: [parse] methods-скан пропущен: ${e.message}`);
    return [];
  }
  const out = [];
  for (const n of ast.program.body) {
    if (n.type !== 'VariableDeclaration') continue;
    for (const d of n.declarations) {
      if (d.id.type !== 'Identifier' || d.id.name !== '__C' || !d.init) continue;
      const methodsProp = (d.init.properties || []).find(
        p => !p.computed && p.key && (p.key.name === 'methods' || p.key.value === 'methods'));
      if (!methodsProp || methodsProp.value.type !== 'ObjectExpression') continue;
      for (const p of methodsProp.value.properties) {
        if (p.type === 'SpreadElement' || p.computed) continue;
        // методы вида foo() {} парсятся как ObjectMethod (сам узел = свойство,
        // без .value); foo: function / foo: () => — Property с .value
        const isFn = p.type === 'ObjectMethod'
          || (p.value && (p.value.type === 'FunctionExpression' || p.value.type === 'ArrowFunctionExpression'));
        if (!isFn) out.push(p.key.name || String(p.key.value));
      }
    }
  }
  return out;
}

/* Первый строк-локатор — грубый поиск имени в шаблоне. */
function findTplLine(tplLines, tplOffset, name) {
  const re = new RegExp('(?:^|[^\\w.$\'"`])' + name + '(?=[^\\w$]|$)');
  for (let i = 0; i < tplLines.length; i++) {
    if (re.test(tplLines[i])) return tplOffset + i + 1;
  }
  return 0;
}

function analyze(file) {
  const problems = [];
  const src = fs.readFileSync(file, 'utf8');
  const { descriptor, errors } = sfcParse(src, { filename: file });
  if (errors.length) {
    return errors.map(e => `${file}: SFC parse error: ${e.message}`);
  }
  if (!descriptor.template || (!descriptor.script && !descriptor.scriptSetup)) return problems;

  let bindings = {};
  try {
    const s = compileScript(descriptor, { id: 'check' });
    bindings = s.bindings || {};
  } catch (e) {
    return [`${file}: compileScript failed: ${e.message}`];
  }

  const t = compileTemplate({
    source: descriptor.template.content,
    filename: file,
    id: 'check',
    compilerOptions: { bindingMetadata: bindings, mode: 'module' },
  });
  for (const err of t.errors) {
    problems.push(`${file}: compileTemplate: ${err.message || err}`);
  }

  /* Идентификаторы, которые компилятор НЕ резолвил в bindings
   * (проходят через _ctx.X / $setup.X). $-префиксные — легитимны. */
  const used = new Set();
  for (const m of t.code.matchAll(/(?:_ctx|\$setup)\.([\w$]+)/g)) used.add(m[1]);
  const known = new Set(Object.keys(bindings));

  /* template refs (граница: не :href=) */
  const refs = new Set();
  for (const m of descriptor.template.content.matchAll(/(?:^|\s)ref="([\w$]+)"/g)) refs.add(m[1]);

  /* импорты Options-API script-блока */
  const scriptContent = descriptor.script ? descriptor.script.content : '';
  const imports = new Set();
  for (const m of scriptContent.matchAll(/import\s*\{([^}]+)\}/g)) {
    m[1].split(',').forEach(n => imports.add(n.trim().split(/\s+as\s+/).pop().trim()));
  }
  for (const m of scriptContent.matchAll(/import\s+([\w$]+)\s+from/g)) imports.add(m[1]);

  const tplLines = descriptor.template.content.split('\n');
  const tplStart = src.indexOf('<template>');
  const tplOffset = tplStart === -1 ? 0 : src.slice(0, tplStart).split('\n').length;

  for (const name of [...used].sort()) {
    if (name.startsWith('$')) continue;
    if (known.has(name)) continue;
    const line = findTplLine(tplLines, tplOffset, name);
    if (refs.has(name)) {
      problems.push(`${file}:${line}: [E2] template ref "${name}" используется без $refs. — Vue 3 резолвит в undefined → клик молча не работает`);
    } else if (imports.has(name)) {
      problems.push(`${file}:${line}: [E3] модульный импорт "${name}" вызван в шаблоне — Options API его не видит (нужен метод-обёртка)`);
    } else {
      problems.push(`${file}:${line}: [E1] "${name}" не объявлен в data/computed/methods/props — биндинг молча неработоспособен`);
    }
  }

  if (!descriptor.scriptSetup) {
    for (const name of nonFunctionsInMethods(scriptContent, file, problems)) {
      problems.push(`${file}: [E1-src] "${name}" объявлен в methods{} как не-функция — Vue дропает его в проде; перенести в data()`);
    }
  }

  return problems;
}

function main() {
  const root = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map(a => path.resolve(a))
    : listVueFiles(path.join(root, 'src'));
  const all = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`нет файла: ${f}`); process.exit(2); }
    all.push(...analyze(f));
  }
  if (all.length) {
    console.error(`✗ template-check: ${all.length} проблем(ы)`);
    for (const p of all) console.error('  ' + p);
    process.exit(1);
  }
  console.log(`✓ template-check: ${files.length} компонент(ов) чисты`);
}

main();
