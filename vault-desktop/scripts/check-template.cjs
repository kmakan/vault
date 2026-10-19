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
 *   E4     this.X в скрипте/шаблоне компонента, которого нет среди
 *          data/computed/methods/props/setup → TypeError при вызове, и
 *          только у живого человека (клик), без стектрейса в интерфейсе.
 *          История класса: this.alertMsg в copyText (нет метода вовсе),
 *          this.uiStore в showToast (есть, но не в инстансе) — ADR-003 §5.5,
 *          партия 10, тикет t_ddc24f52.
 *
 * E2/E3 — частные случаи E1, но метятся отдельно: разные фиксы.
 * E4 — про СКРИПТ (E1 про шаблон): источник правды тот же bindings.
 * Запуск: node scripts/check-template.cjs [файлы...] (по умолчанию src/).
 * Выход: 0 = OK; 1 = проблемы (сборка падает).
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
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

/* Обход AST: fn на каждом узле. loc и комментарии не трогаем. */
function walkAst(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walkAst(c, fn); return; }
  if (typeof node.type === 'string') fn(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    walkAst(node[k], fn);
  }
}

/* this.X в скрипте — по AST. Текстовый разбор тут не годится: в этом же файле
 * `this.foo` встречается в комментариях-пояснениях и в строках, и любой такой
 * текст дал бы ложное срабатывание.
 *
 * Возвращаем:
 *   refs     — чтения/вызовы `this.X`;
 *   assigned — цели присваивания `this.X = ...` (заведённые ad-hoc поля).
 * В проекте так живут нереактивные хендлы (`this._unlistenMediaConnected`,
 * `this._nextInviteTimer`, `this.onWindowResize`) — они НЕ в data(), и ругаться
 * на них нельзя: это не поломка, а осознанный приём. А вот `this.alertMsg(...)`
 * (вызван, но нигде не объявлен и не присвоен) — ровно искомый класс.
 *   opaque   — члены, которых в bindings не видно по определению: миксины и
 *              extends (fail-closed: сообщаем, а не пропускаем молча). Тоже по
 *              AST, а не регэкспом: `extends:` внутри объекта метода — не опция.
 */
function thisRefsInScript(scriptContent) {
  let ast;
  try {
    ast = babel.parse(scriptContent, { sourceType: 'module' });
  } catch (e) {
    return { error: e.message, refs: [], assigned: new Set(), opaque: [] };
  }
  const refs = [];
  const assigned = new Set();
  const opaque = [];
  for (const n of ast.program.body) {
    if (n.type !== 'ExportDefaultDeclaration' || !n.declaration || n.declaration.type !== 'ObjectExpression') continue;
    for (const p of n.declaration.properties) {
      if (p.computed || !p.key) continue;
      const k = p.key.name || p.key.value;
      if (k === 'mixins' || k === 'extends') opaque.push(k);
    }
  }
  walkAst(ast, (n) => {
    if (n.type === 'AssignmentExpression' && n.operator === '=' &&
        n.left && n.left.type === 'MemberExpression' &&
        n.left.object && n.left.object.type === 'ThisExpression' &&
        !n.left.computed && n.left.property && n.left.property.type === 'Identifier') {
      assigned.add(n.left.property.name);
      return;
    }
    if (n.type !== 'MemberExpression') return;
    if (!n.object || n.object.type !== 'ThisExpression') return;
    if (n.computed || !n.property || n.property.type !== 'Identifier') return; // this['x'] — имя динамическое
    refs.push({ name: n.property.name, offset: n.property.start });
  });
  return { refs, assigned, opaque };
}

/* this.X в ВЫРАЖЕНИЯХ шаблона ({{ }} и :/@/v- атрибуты). В обычном тексте и в
 * литеральных атрибутах `this.foo` — это текст, а не код: справка вида
 * «вызовите this.foo» не должна валить гейт. */
function thisRefsInTemplate(content) {
  const exprs = [];
  for (const m of content.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    exprs.push({ text: m[1], index: m.index + m[0].indexOf('{{') + 2 });
  }
  const attr = /(?:^|\s)([:@][\w:.\-]*|v-(?:if|else-if|for|show|model|bind|on|html|text)[\w:.\-]*)\s*=\s*"([^"]*)"/g;
  for (const m of content.matchAll(attr)) {
    exprs.push({ text: m[2], index: m.index + m[0].indexOf(m[2]) });
  }
  const refs = [];
  for (const e of exprs) {
    for (const mm of e.text.matchAll(/this\.([A-Za-z_$][\w$]*)/g)) {
      refs.push({ name: mm[1], offset: e.index + mm.index + 5 });
    }
  }
  return refs;
}

/* ── ADR-001 Этап 1: спреды `...featureState()` в data() ──────────────
 *
 * Фичи выносят своё состояние в модуль (`foldersState()`), а App.vue
 * разворачивает спредом. Ни @vue/compiler-sfc, ни наш разбор такой спред
 * не разрешают — поля выпадали бы из bindings, и E1 ругался бы на КАЖДЫЙ
 * биндинг фичи (то есть гейт стал бы неучислимым и его перестали бы читать —
 * хуже, чем гейта нет).
 *
 * Поэтому резолвим спреды ЖИВЫМ импортом: поднимаем модуль, вызываем
 * фабрику, берём настоящие ключи. Не гадаем по AST — берём правду.
 *
 * Fail-closed: если модуль/фабрику не удалось поднять — это ПРОБЛЕМА, а не
 * «молча пропустить». Иначе сломанный импорт тихо отключил бы проверку.
 */
async function resolveStateSpreads(descriptor, file, problems) {
  const script = descriptor.script;
  if (!script) return {};
  let ast;
  try {
    ast = babel.parse(script.content, { sourceType: 'module' });
  } catch (e) {
    problems.push(`${file}: [spread] спреды состояния пропущены, parse: ${e.message}`);
    return {};
  }

  // имя локального импорта → путь модуля
  const importedFrom = new Map();
  for (const n of ast.program.body) {
    if (n.type !== 'ImportDeclaration') continue;
    const spec = n.source.value;
    for (const s of n.specifiers) {
      if (s.type === 'ImportSpecifier') importedFrom.set(s.local.name, { spec, name: s.imported.name });
      else if (s.type === 'ImportDefaultSpecifier') importedFrom.set(s.local.name, { spec, name: 'default' });
      else if (s.type === 'ImportNamespaceSpecifier') importedFrom.set(s.local.name, { spec, name: '*' });
    }
  }

  // спреды внутри возвращаемых объектов data() и setup(): оба кладут имена в
  // инстанс, и оба обязаны быть разрешены — иначе this.X из фичи станет
  // ложным срабатыванием E4.
  const retObjects = [];
  for (const n of ast.program.body) {
    if (n.type !== 'ExportDefaultDeclaration' || !n.declaration || n.declaration.type !== 'ObjectExpression') continue;
    for (const opt of ['data', 'setup']) {
      const prop = n.declaration.properties.find(
        p => !p.computed && p.key && (p.key.name === opt || p.key.value === opt));
      if (!prop) continue;
      // data() {...} — это ObjectMethod (сам узел = тело), а data: function(){}
      // — Property с .value. Поддерживаем оба.
      const fnNode = prop.type === 'ObjectMethod' ? prop : prop.value;
      if (!fnNode || !fnNode.body || !fnNode.body.body) continue;
      const ret = fnNode.body.body.find(
        s => s.type === 'ReturnStatement' && s.argument && s.argument.type === 'ObjectExpression');
      if (ret) retObjects.push({ opt, obj: ret.argument });
    }
  }
  const wanted = new Set();
  for (const { opt, obj } of retObjects) {
    for (const p of obj.properties) {
      if (p.type !== 'SpreadElement') continue;
      const a = p.argument;
      if (a && a.type === 'CallExpression' && a.callee && a.callee.type === 'Identifier') {
        wanted.add(a.callee.name);
      } else {
        // Fail-closed: неизвестный источник спреда = имена полей невидимы.
        problems.push(`${file}: [E1-spread] ${opt}(): спред не от фабрики — ключи не разрешены, this.* и биндинги из него гейт не проверит`);
      }
    }
  }
  if (!wanted.size) return {};

  const out = {};
  for (const local of wanted) {
    const imp = importedFrom.get(local);
    if (!imp || imp.name === '*' || imp.name === 'default') {
      problems.push(`${file}: [E1-spread] спред ...${local}() — импорт не распознан (нужен именованный импорт фабрики)`);
      continue;
    }
    const modPath = path.resolve(path.dirname(file), imp.spec);
    try {
      const mod = await import(pathToFileURL(modPath).href);
      const fn = mod[imp.name];
      if (typeof fn !== 'function') {
        problems.push(`${file}: [E1-spread] ${imp.spec} не экспортирует функцию ${imp.name}`);
        continue;
      }
      const state = fn();
      if (!state || typeof state !== 'object') {
        problems.push(`${file}: [E1-spread] ${imp.name}() вернула не объект`);
        continue;
      }
      for (const k of Object.keys(state)) out[k] = 'setup-reactive';
    } catch (e) {
      problems.push(`${file}: [E1-spread] не удалось поднять ${imp.spec} для спреда ...${local}(): ${e.message}`);
    }
  }
  return out;
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

  // ADR-001 Этап 1: состояние фич приезжает спредом `...featureState()`.
  // Компилятор такой спред не разворачивает — добавляем ключи сами (см.
  // resolveStateSpreads). Синхронно нельзя: там живой import().
  return resolveStateSpreads(descriptor, file, problems).then(spread => {
    Object.assign(bindings, spread);
    return analyzeWithBindings(file, descriptor, bindings, problems, src);
  });
}

function analyzeWithBindings(file, descriptor, bindings, problems, src) {

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

  /* ── E4: this.X — член инстанса ────────────────────────────────────────
   * Источник правды — те же bindings (data/computed/methods/props/setup) плюс
   * ключи спредов фич, которые resolveStateSpreads уже влил в bindings.
   * $-имена не проверяем: это прокси Vue ($refs/$emit/$nextTick/$route/...).
   *
   * Почему не текстовый поиск: `this.foo` в этом репозитории живёт ещё и в
   * комментариях-пояснениях и в строках — текстовый скан дал бы ложные
   * срабатывания. По AST комментарии и строки не MemberExpression.
   */
  // E4 — про Options API script-блок: у <script setup> `this` в скрипте не
  // существует (там setup-скоуп), проверять нечего.
  if (descriptor.script) {
    const scriptBase = descriptor.script.loc ? descriptor.script.loc.start.offset : src.indexOf(scriptContent);
    const tplBase = descriptor.template.loc ? descriptor.template.loc.start.offset : 0;
    const lineAt = (base, off) => src.slice(0, base + off).split('\n').length;
    const scan = thisRefsInScript(scriptContent);
    if (scan.error) problems.push(`${file}: [E4] this-скана нет, parse: ${scan.error}`);
    for (const src2 of scan.opaque) {
      problems.push(`${file}: [E4-${src2}] компонент использует ${src2} — члены оттуда в bindings не видны, this.* гейт не проверит`);
    }
    const thisRefs = [
      ...scan.refs.map(r => ({ ...r, line: lineAt(scriptBase, r.offset) })),
      ...thisRefsInTemplate(descriptor.template.content).map(r => ({ ...r, line: lineAt(tplBase, r.offset) })),
    ];
    const seen = new Set();
    for (const r of thisRefs.sort((a, b) => a.line - b.line)) {
      if (r.name.startsWith('$')) continue;        // прокси Vue: $refs/$emit/$nextTick/$route...
      if (known.has(r.name)) continue;             // data/computed/methods/props/setup (+ спреды фич)
      if (scan.assigned.has(r.name)) continue;     // ad-hoc поле: this.X = ... (см. thisRefsInScript)
      const key = `${r.line}:${r.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push(`${file}:${r.line}: [E4] this.${r.name} — нет в data/computed/methods/props/setup и нигде не присвоен: TypeError при вызове`);
    }
  }

  return problems;
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  const files = args.length
    ? args.map(a => path.resolve(a))
    : listVueFiles(path.join(root, 'src'));
  const all = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`нет файла: ${f}`); process.exit(2); }
    all.push(...await analyze(f));
  }
  if (all.length) {
    console.error(`✗ template-check: ${all.length} проблем(ы)`);
    for (const p of all) console.error('  ' + p);
    process.exit(1);
  }
  console.log(`✓ template-check: ${files.length} компонент(ов) чисты`);
}

main();
