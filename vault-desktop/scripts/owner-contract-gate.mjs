// Гейт контракта «App.vue → фича»: типизированный владелец передаётся правильно.
//
// ЗАЧЕМ ЭТО В РЕПОЗИТОРИИ.
// 22.10.2026 «отправленное сообщение исчезает» прожил в продукте ровно потому,
// что НИКТО не проверял форму объекта на границе фичи. App.vue отдаёт владельцу
// переписки фиче объект-владельца (`this.chat`, поле `state.messages`), а фича
// прочитала `chat.messages` — поля с таким именем у владельца нет. Ошибка
// безобидная на вид: `(chat && chat.messages) || []` даёт пустой список,
// запись в архив проходит «успешно», и локальная история не наполнялась НИКОГДА.
// Ни один гейт это не ловил: owner-refs-gate смотрит на импорты, ctx-ratchet —
// на писателей поля, смоуки фич собирали себе самописный `{messages: [...]}`
// «по форме» и оставались зелёными.
//
// ПРАВИЛО. Для каждого вызова `Фича.fn(...)` в App.vue, аргумент которого —
// владелец состояния (`this.chat` и т.п.), имя параметра в сигнатуре `fn`
// получает профиль этого владельца. В теле функции:
//   · `param.<поле из state>` — нарушение: у владельца такого поля нет,
//     правильный путь — `param.state.<поле>`;
//   · `param.<чего-то>` вне state/методов/`state` — нарушение: фича обращается
//     к члену, которого у владельца не объявлено (опечатка или рот API).
//
// ЧЕГО НЕ ПРОВЕРЯЕТ (осознанно): аргументы, пришедшие не от владельца (обычные
// значения), замыкания и цепочки через вспомогательные переменные. Гейт ловит
// КЛАСС «граница фичи разошлась с владельцем», а не делает строгую типизацию —
// для строгой был бы TypeScript, а TS в этом фронте не решение этапа.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

// Убираем комментарии С ТОКИНИЗОМ (строка/шаблон ≠ код). Регулярка вида
// `/\*[\s\S]*?\*\//` съедает код, если в файле встретился одиночный `/*`
// (в App.vue их полно в <style> и в шаблонных строках) — проверка тогда
// молча ослепает, а ослепший гейт хуже отсутствующего.
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2; out += ' '; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ── 1. Профили владельцев: фабрика → { state-поля, методы } ───────────────
//
// Фабрика — `export function createXStore() { return { state: {...}, методы } }`.
// Читаем текст фабрики: поля `state` — ключи первого уровня объекта `state: {`,
// методы — `name(args) {` на первом уровне того же возвращаемого объекта.
function factoryProfile(source, factoryName) {
  const start = source.indexOf('function ' + factoryName);
  if (start < 0) return null;
  const body = source.slice(start);
  const stateBlock = body.match(/state:\s*\{([\s\S]*?)\n\s{4}\}/);
  const fields = stateBlock
    ? [...stateBlock[1].matchAll(/^\s{2,}(\w+)\s*:/gm)].map((m) => m[1])
    : [];
  const methods = [...body.matchAll(/^\s{2,}(\w+)\s*\(/gm)].map((m) => m[1]);
  return { fields: new Set(fields), methods: new Set(methods) };
}

const allFiles = [...jsFiles(SRC), path.join(ROOT, 'src', 'App.vue')].filter((f) => statSync(f).isFile());
const sources = new Map(allFiles.map((f) => [f, readFileSync(f, 'utf8')]));

// Профили привязаны к ФАЙЛУ: одно и то же имя фабрики (`createChatStore`)
// живёт в двух модулях — владелец переписки и узкий владелец активного чата.
// Какую именно имел в виду App.vue, решается по его импорту (см. §2).
const factories = new Map();   // "src/chat-store.js#createChatStore" → profile
for (const [f, src0] of sources) {
  if (f.endsWith('App.vue')) continue;
  for (const m of src0.matchAll(/export function (create\w+)\s*\(/g)) {
    const p = factoryProfile(src0, m[1]);
    if (p && (p.fields.size || p.methods.size)) {
      factories.set(path.relative(ROOT, f) + '#' + m[1], p);
    }
  }
}

// ── 2. Алиасы владельцев в композиционном корне ───────────────────────────
// `const chat = reactive(createChatStore())` / `const chat = createChatStore()`
const appSrc = stripComments(sources.get(path.join(ROOT, 'src', 'App.vue')));
// Имя фабрики → файл, ОТКУДА её импортировал App.vue (совпадающие имена в двух
// модулях разрешаются именно так).
const factoryFromFile = new Map();
for (const m of appSrc.matchAll(/import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g)) {
  const rel = m[2].replace(/^\.\//, '');
  const abs = path.join(ROOT, 'src', rel.endsWith('.js') ? rel : rel + '.js');
  const key = path.relative(ROOT, abs);
  if (!factories.size || !sources.has(abs)) continue;
  for (const part of m[1].split(',')) {
    const name = part.trim().split(/\s+as\s+/).pop().trim();
    if (factories.has(key + '#' + name)) factoryFromFile.set(name, key);
  }
}
const aliases = new Map();     // alias → profile
for (const m of appSrc.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:reactive\s*\(\s*)?(create\w+)\s*\(/g)) {
  const from = factoryFromFile.get(m[2]);
  const profile = from ? factories.get(from + '#' + m[2]) : null;
  if (profile) aliases.set(m[1], profile);
}
if (!aliases.size) {
  console.log('✗ owner-contract-gate: в App.vue не найдено ни одного владельца — гейт ослеп');
  process.exit(1);
}

// ── 3. Импорты фич в App.vue: HistoryFeature → src/features/history.js ────
const nsToModule = new Map();
for (const m of appSrc.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) {
  const rel = m[2].replace(/^\.\//, '');
  const abs = path.join(ROOT, 'src', rel.endsWith('.js') ? rel : rel + '.js');
  if (sources.has(abs)) nsToModule.set(m[1], abs);
}

// Разбор сигнатур экспортируемых функций модуля: имя → список имён параметров.
function signatures(src) {
  const out = new Map();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)) {
    const params = m[2].split(',').map((p) => {
      const t = p.trim().replace(/^\.\.\./, '');
      const name = t.split(/[=\s]/)[0];
      return name || null;
    });
    out.set(m[1], params);
  }
  return out;
}

// Тело функции в исходнике: от закрывающей скобки сигнатуры до matching }.
function functionBody(src, fnName) {
  const sig = new RegExp('export\\s+(?:async\\s+)?function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{');
  const m = sig.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index + m[0].length, i - 1);
}

// Деструктуризация первого параметра (`const { a, b } = deps`) тоже считается:
// имена из неё — локальные алиасы, но профиля у них нет, поэтому они не
// проверяются (осознанно: deps-ключи типизируются смоуками моста).

const violations = [];
for (const [ns, abs] of nsToModule) {
  const src = stripComments(sources.get(abs));
  const sigs = signatures(src);
  // Вызовы `Ns.fn(...)` из App.vue: разбираем позиционные аргументы.
  for (const call of appSrc.matchAll(new RegExp('(?:window\\.)?' + ns + '\\.(\\w+)\\(', 'g'))) {
    const fn = call[1];
    const params = sigs.get(fn);
    if (!params) continue;
    // Аргументы вызова — с balances по скобкам, начиная после `(`.
    const openIdx = appSrc.indexOf('(', call.index + ns.length);
    if (openIdx < 0) continue;
    const argsText = splitArgs(appSrc, openIdx);
    if (!argsText) continue;
    argsText.forEach((arg, i) => {
      const am = /^\s*this\.(\w+)\s*$/.exec(arg);
      if (!am) return;
      const profile = aliases.get(am[1]);
      if (!profile) return;
      const param = params[i];
      if (!param) return;
      const body = functionBody(src, fn);
      if (!body) return;
      for (const acc of body.matchAll(new RegExp('(?<![\\w.$])' + param + '\\.([\\w]+)', 'g'))) {
        const member = acc[1];
        if (member === 'state' || profile.methods.has(member)) continue;
        const line = src.slice(0, src.indexOf(body)).split('\n').length;
        if (profile.fields.has(member)) {
          violations.push({ file: abs, fn, param, member, line, kind: 'поле владельца читается мимо .state' });
        } else {
          violations.push({ file: abs, fn, param, member, line, kind: 'члена с таким именем у владельца нет' });
        }
      }
    });
  }
}

// ── 3.5 Граница «фича → зависимость»: арность и позиции аргументов ─────────
//
// Второе изделие того же класса. Композиционный корень подставляет фиче
// замыкания: `{ setPendingOutgoing: (k, m) => this.setPendingOutgoing(k, m) }`.
// Фича зовёт их СВОИМИ аргументами — `setPendingOutgoing(chatKey, msg)`. Если
// замыкание принимает меньше параметров, чем ему передают, или ставит параметр
// не на своё место, аргумент теряется молча: звонки-то «успешные».
//
// Поймано на 22.10 (второй день той же жалобы): `v => this.setPendingOutgoing
// (chatKey, v)` — фича передаёт (chatKey, msg), а в метод попадает (chatKey,
// chatKey): бакет pending стал СТРОКОЙ, `Object.assign` рассыпал её по символам,
// поллинг подмешал 17 символов в чат — «пустые пузыри» вместо переписки.
//
// ПРОВЕРЯЮТСЯ ОБЕ СТОРОНЫ ОТНОШЕНИЯ, потому что дефект живёт с обеих:
//   · ПОЗИЦИИ (scanBoundary): параметр №i замыкания обязан стоять в аргументе
//     №i вызываемого метода — порядок либо позиционный, либо явный комментарий;
//   · АРНОСТЬ (checkArity, ниже): замыкание в App.vue обязано принимать РОВНО
//     столько аргументов, сколько ему передаёт фича. Недобор = потеря аргумента
//     (22.10), перебор = `undefined` внутри метода владельца (тоже испорченное
//     состояние владельца, просто с другим лицом).
//
// Аргументы считаются по ФАКТУ вызова в теле функции фичи, а не по её сигнатуре:
// фича вольна звать зависимость из любого места, а контракт — у вызова.
const boundary = scanBoundary(appSrc);

function scanBoundary(code) {
  const found = [];
  for (const m of code.matchAll(/\b(\w+)\s*:\s*(?:async\s*)?(?:\(([^)]*)\)|(\w+))\s*=>\s*(?:this\.)?([\w.$]+)\s*\(/g)) {
    const depsName = m[1];
    const params = (m[2] !== undefined ? m[2] : m[3]).split(',').map((p) => p.trim().split(/[=\s]/)[0]).filter(Boolean);
    if (!params.length || params.some((p) => p.startsWith('...'))) continue;
    const openIdx = code.indexOf('(', m.index + m[0].length - 1);
    const args = openIdx < 0 ? null : splitArgs(code, openIdx);
    if (!args) continue;
    params.forEach((p, i) => {
      const at = args.findIndex((a) => new RegExp('^\\s*' + p + '\\s*$').test(a));
      if (at < 0 || at === i) return;
      // Параметр уехал ВЛЕВО (f(m, k) при сигнатуре (k, m)) — нарушение всегда:
      // поменялся порядок аргументов. Уехал ВПРАВО (f(chatKey, v) при (v)) —
      // законно, когда освободившиеся места заняты литералом или контекстом
      // (`console.log('текст', e)`, `F.f(this.deps, force)`). Опасно в одном
      // случае: если спереди встало простое имя переменной из объёма App.vue —
      // это потерянный аргумент вызывающего (22.10: на место `msg` встал
      // `chatKey`, и бакет pending стал строкой).
      if (at > i) {
        const captured = args.slice(0, at).some((a) => {
          const t = a.trim();
          return /^[A-Za-z_$][\w$]*$/.test(t) && !params.includes(t) && !['this', 'undefined', 'null'].includes(t);
        });
        if (!captured) return;
      }
      const line = code.slice(0, m.index).split('\n').length;
      found.push({ depsName, param: p, from: i, to: at, line, call: m[4] });
    });
  }
  return found;
}

// АРНОСТЬ. Инъекция вида `Фича.fn({ dep: (a, b) => … }, …)` (или
// `Фича.fn(this.depsGetter, …)`) обязана совпадать с тем, сколько аргументов
// фича реально передаёт `dep(...)`.
//
// Считаем СТРОГО внутри тела `fn` и строго по алиасу, который фича выбрала при
// деструктуризации (`{ broadcastProfile: doBroadcast }`). Поиск по всему модулю
// давал пять ложных срабатываний: декларация `export function dep(a, b, c)`
// считалась вызовом на 3 аргумента, а одно и то же имя (`loadHistory`) в модуле
// значит и инжектированную зависимость, и импорт адаптера из другой функции.
// Цена ограничения: если `fn` перекладывает deps-объект во вспомогательную
// функцию, вызовов в теле мы не увидим и нарушение промолчим — недосказанность
// лучше ложного отказа, такие границы закрывает смоук моста.
function checkArity(appCode = appSrc, scopes = nsToModule, srcs = sources, getters = depsGetters) {
  const found = [];
  for (const [ns, abs] of scopes) {
    if (!srcs.has(abs)) continue;
    const src = stripComments(srcs.get(abs));
    for (const call of appCode.matchAll(new RegExp('(?:window\\.)?' + ns + '\\.(\\w+)\\(', 'g'))) {
      const fn = call[1];
      const openIdx = appCode.indexOf('(', call.index + ns.length);
      if (openIdx < 0) continue;
      const args = splitArgs(appCode, openIdx);
      if (!args) continue;
      const entries = injectionEntries(appCode, args[0], openIdx, getters);
      if (!entries) continue;
      const body = functionBody(src, fn);
      if (!body) continue;
      const alias = depAlias(src, fn);
      for (const entry of entries) {
        const dep = parseDepClosure(entry);
        if (!dep || dep.rest || dep.arity === null) continue;
        const passed = callArities(body, dep.name, alias);
        if (!passed.length) continue;
        const maxPassed = Math.max(...passed);
        const line = appCode.slice(0, call.index).split('\n').length;
        if (dep.arity < maxPassed) {
          found.push({ dep: dep.name, arity: dep.arity, passed: maxPassed, line, ns, fn, kind: 'аргумент теряется (фича передаёт больше, чем принимает замыкание)' });
        } else if (dep.arity > maxPassed) {
          // Обратное направление меряем ПО ВСЕМУ МОДУЛЮ: зависимость общая, и
          // если хотя бы одна функция фичи передаёт аргумент, параметр жив.
          // В пределах одной fn это выглядело бы «мёртвым» (startPolling:
          // changeEmail зовёт без интервала, логин — с 60000).
          const union = Math.max(maxPassed, ...moduleUnionArities(src, dep.name));
          if (dep.arity > union) {
            found.push({ dep: dep.name, arity: dep.arity, passed: maxPassed, union, line, ns, fn, kind: 'параметр никогда не получает значения (всегда undefined)' });
          }
        }
      }
    }
  }
  return found;
}

// Откуда брать список зависимостей для первого аргумента: литерал объекта прямо
// в вызове (`Фича.fn({ a: … })`) или геттер композиционного корня
// (`Фича.fn(this.emailsDeps)` — так устроены 206 инъекций из 220).
function injectionEntries(appCode, firstArg, openIdx, getters) {
  const t = firstArg.trim();
  if (t.startsWith('{')) return splitArgs(appCode, appCode.indexOf('{', openIdx));
  const g = /^this\.(\w+)$/.exec(t);
  if (g) return getters.get(g[1]) || null;
  return null;
}

// Геттеры deps-объектов в App.vue: `name() { return { dep: (…) => …, … } }`.
function scanDepsGetters(code) {
  const out = new Map();
  for (const m of code.matchAll(/(\w+)\s*\(\s*\)\s*\{\s*return\s*\{/g)) {
    const brace = code.indexOf('{', m.index + m[0].length - 1);
    const entries = splitArgs(code, brace);
    if (entries && entries.some((e) => parseDepClosure(e))) out.set(m[1], entries);
  }
  return out;
}
const depsGetters = scanDepsGetters(appSrc);
const arity = checkArity();

// Имя зависимости → локальный алиас внутри `fn`. `{ a, b: c }` → a→a, b→c;
// одиночный параметр (`deps`) → алиасы совпадают с именами, вызов ищется как
// `deps.<имя>(`.
// `{ a, b: c }` → {a→a, b→c} + bound=null; одиночный параметр `deps` → карта
// пустая, bound='deps' (тогда считается толькоqualified-вызов `deps.a(...)`).
function depAlias(src, fnName) {
  const out = { map: new Map(), bound: null };
  const sig = new RegExp('export\\s+(?:async\\s+)?function\\s+' + fnName + '\\s*\\(');
  const m = sig.exec(src);
  if (!m) return out;
  const params = splitArgs(src, m.index + m[0].length - 1);
  if (!params) return out;
  const first = params[0].trim();
  if (first.startsWith('{')) {
    const brace = src.indexOf('{', m.index + m[0].length);
    for (const e of splitArgs(src, brace) || []) {
      const t = e.trim();
      const renamed = /^(\w+)\s*:\s*(\w+)\s*(=.*)?$/.exec(t);
      if (renamed) { out.map.set(renamed[1], renamed[2]); continue; }
      const plain = /^(\w+)\s*(=.*)?$/.exec(t);
      if (plain) out.map.set(plain[1], plain[1]);
    }
  } else if (/^\w+$/.test(first)) {
    out.bound = first;
  }
  return out;
}

// Одна строка deps-объекта → { name, arity } | null. `arity: null` — значение
// не замыкание (готовая функция/поле), арность отсюда неизвестна.
function parseDepClosure(entry) {
  const arrow = /^\s*(\w+)\s*:\s*(?:async\s*)?\(([^)]*)\)\s*=>/.exec(entry);
  if (arrow) {
    const raw = arrow[2].split(',').map((p) => p.trim()).filter(Boolean);
    return {
      name: arrow[1],
      rest: raw.some((p) => p.startsWith('...')),
      arity: raw.filter((p) => !p.includes('=')).length
    };
  }
  // Одиночный параметр без скобок — именно так выглядел дефект 22.10:
  // `setPendingOutgoing: v => this.setPendingOutgoing(chatKey, v)`.
  const one = /^\s*(\w+)\s*:\s*(?:async\s*)?([A-Za-z_$][\w$]*)\s*=>/.exec(entry);
  if (one) return { name: one[1], rest: false, arity: 1 };
  const bare = /^\s*(\w+)\s*:\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*$/.exec(entry);
  if (bare) return { name: bare[1], rest: false, arity: null };
  return null;
}

// Сколько аргументов передают зависимости в ТЕЛЕ функции фичи. `alias` — имя,
// под которым зависимость лежит внутри (`{ dropBucket }` → dropBucket,
// `{ broadcastProfile: doBroadcast }` → doBroadcast); если алиаса нет,
// зависимость не деструктурирована и вызывается только как `deps.<имя>(`.
function callArities(body, depName, aliasInfo) {
  const out = [];
  const local = aliasInfo.map.get(depName) || depName;
  const boundCheck = aliasInfo.bound
    ? new RegExp('(?:^|[^\\w$.])' + aliasInfo.bound + '\\.\\s*$')
    : null;
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    const word = m[1];
    const before = body.slice(0, m.index);
    if (/[.]\s*$/.test(before)) {
      // Через объект deps (`deps.dropBucket(...)`) — считаем только если объект
      // и есть тот самый параметр, которому корень подставил замыкания.
      if (!boundCheck || word !== depName || !boundCheck.test(before)) continue;
    } else {
      // Голый вызов из деструктуризации. Если deps не деструктурирован, голые
      // имена к нашей инъекции отношения не имеют (это импорты).
      if (aliasInfo.bound) continue;
      if (word !== local) continue;
    }
    if (/(?:function|class)\s*$/.test(before)) continue;   // декларация, не вызов
    const openIdx = m.index + m[0].length - 1;
    const args = splitArgs(body, openIdx);
    if (!args) continue;
    if (args.some((a) => /^\s*\.\.\./.test(a))) continue;  // spread — арность не вывести
    if (args.length === 1 && /^\s*$/.test(args[0])) { out.push(0); continue; }
    out.push(args.length);
  }
  return out;
}

// Поколение аргументов зависимости ПО ВСЕМУ МОДУЛЮ фичи (каждая экспортируемая
// функция со своими алиасами). Нужно для направления «параметр никогда не
// получает значения»: зависимость общая, и достаточно одного вызова с аргументом.
function moduleUnionArities(moduleSrc, depName) {
  const out = [];
  for (const name of signatures(moduleSrc).keys()) {
    const body = functionBody(moduleSrc, name);
    if (!body) continue;
    out.push(...callArities(body, depName, depAlias(moduleSrc, name)));
  }
  return out;
}

// Разбор списка аргументов вызова с учётом вложенных скобок/кавычек.
// Отсчёт ведётся от ОТКРЫВАЮЩЕЙ скобки: она не попадает в первый аргумент,
// иначе `f(this.chat)` читается как `(this.chat` и проверка первого аргумента
// просто не срабатывает (так и было, пока не разбирали «пустые пузыри»).
function splitArgs(code, openIdx) {
  let depth = 0, i = openIdx, cur = '', out = [];
  let quote = null;
  for (; i < code.length; i++) {
    const c = code[i];
    if (i === openIdx) { depth = 1; continue; }
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) { out.push(cur); return out; } }
    if (c === ',' && depth === 1) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  return null;
}

// ── Анти-рот: гейт обязан ловить подделку и не ловить правку ──────────────
selfCheck();

function selfCheck() {
  const profile = { fields: new Set(['messages']), methods: new Set(['set', 'append']) };
  const badSrc = 'export function save(a, k, chat) { return save2(a, k, chat.messages || []); }';
  const goodSrc = 'export function save(a, k, chat) { return save2(a, k, chat.state.messages || []); }';
  const unknownSrc = 'export function save(a, k, chat) { return chat.purge(); }';
  const check = (src, param) => {
    const body = functionBody(src, 'save');
    const hits = [...body.matchAll(new RegExp('(?<![\\w.$])' + param + '\\.([\\w]+)', 'g'))]
      .map((m) => m[1])
      .filter((member) => member !== 'state' && !profile.methods.has(member));
    return hits.some((h) => profile.fields.has(h)) || hits.length > 0;
  };
  const okBad = check(badSrc, 'chat');
  const okGood = !check(goodSrc, 'chat');
  const okUnknown = check(unknownSrc, 'chat');
  // Правило 2 (позиции зависимостей) — на реальном дефекте 22.10.
  const badClosure = 'markPending(chatKey, msg) { return F.markPending({ setPendingOutgoing: v => this.setPendingOutgoing(chatKey, v) }, chatKey, msg); }';
  const goodClosure = 'markPending(chatKey, msg) { return F.markPending({ setPendingOutgoing: (k, m) => this.setPendingOutgoing(k, m) }, chatKey, msg); }';
  const rebinding = 'loadChatCache(chat) { return F.loadChatCache({ saveChatCache: (k, l) => this.saveChatCache(k, l) }, chat); }';
  const okBoundaryBad = scanBoundary(badClosure).some((b) => b.depsName === 'setPendingOutgoing');
  const okBoundaryGood = scanBoundary(goodClosure).length === 0 && scanBoundary(rebinding).length === 0;
  // Правило 3 (арность) — на обоих концах отношения: недобор args (22.10) и
  // перебор (параметр, который никто никогда не передаёт, = тихий undefined).
  const fixture = new Map([['/tmp/fake-feature.js', 'export function markPending({ setPendingOutgoing }, chatKey, msg) { setPendingOutgoing(chatKey, msg); }']]);
  const scopes = new Map([['Feature', '/tmp/fake-feature.js']]);
  const tooFew = 'markPending(chatKey, msg) { return Feature.markPending({ setPendingOutgoing: v => this.setPendingOutgoing(chatKey, v) }, chatKey, msg); }';
  const exact = 'markPending(chatKey, msg) { return Feature.markPending({ setPendingOutgoing: (k, m) => this.setPendingOutgoing(k, m) }, chatKey, msg); }';
  const tooMany = 'markPending(chatKey, msg) { return Feature.markPending({ setPendingOutgoing: (k, m, extra) => this.setPendingOutgoing(k, m, extra) }, chatKey, msg); }';
  const forwarded = new Map([['/tmp/fake-feature.js', 'export function markPending(deps, chatKey, msg) { helper(deps, chatKey, msg); }\nfunction helper(deps, k, m) { deps.setPendingOutgoing(k, m); }']]);
  // Геттер deps-объекта вместо литерала в вызове (206 из 220 инъекций) и
  // «мёртвый» параметр, который живёт благодаря ДРУГОЙ функции фичи.
  const getterFeature = new Map([['/tmp/fake-feature.js', 'export function markPending(deps, k, m) { deps.setPendingOutgoing(k, m); }\nexport function later(deps, k, m) { deps.setPendingOutgoing(k, m, deps.extra); }']]);
  const gettersBad = new Map([['pendingDeps', [' setPendingOutgoing: (v) => this.setPendingOutgoing(chatKey, v)']]]);
  const gettersOk = new Map([['pendingDeps', [' setPendingOutgoing: (k, m, extra) => this.setPendingOutgoing(k, m, extra)']]]);
  const getterCall = 'markPending(k, m) { return Feature.markPending(this.pendingDeps, k, m); }';
  const okArityBad = checkArity(tooFew, scopes, fixture).some((a) => a.dep === 'setPendingOutgoing' && a.kind.startsWith('аргумент теряется'));
  const okArityGood = checkArity(exact, scopes, fixture).length === 0;
  const okArityOver = checkArity(tooMany, scopes, fixture).some((a) => a.kind.startsWith('параметр никогда'));
  const okArityForwarded = checkArity(exact, scopes, forwarded).length === 0;
  // Геттер-инъекция: ловит потерю и НЕ орёт на «мёртвый» параметр, который
  // передаёт другая функция той же фичи.
  const okArityGetter = checkArity(getterCall, scopes, getterFeature, gettersBad).some((a) => a.kind.startsWith('аргумент теряется'));
  const okArityGetterUnion = checkArity(getterCall, scopes, getterFeature, gettersOk).length === 0;
  if (!okBad || !okGood || !okUnknown || !okBoundaryBad || !okBoundaryGood
      || !okArityBad || !okArityGood || !okArityOver || !okArityForwarded
      || !okArityGetter || !okArityGetterUnion) {
    console.log(`✗ owner-contract-gate: САМОПРОВЕРКА ПРОВАЛА (ловит=${okBad}, не_ложно=${okGood}, ловит_несуществующее=${okUnknown}, границы_ловит=${okBoundaryBad}, границы_не_ложно=${okBoundaryGood}, арность_ловит=${okArityBad}, арность_не_ложно=${okArityGood}, арность_перебор=${okArityOver}, арность_через_deps=${okArityForwarded}, арность_геттер=${okArityGetter}, арность_объединение=${okArityGetterUnion})`);
    process.exit(1);
  }
}

const rel = (f) => path.relative(ROOT, f);
if (violations.length || boundary.length || arity.length) {
  console.log('═══ КОНТРАКТ ВЛАДЕЛЕЙ НА ГРАНИЦАХ ФИЧ: НАРУШЕНИЯ ═══');
  for (const v of violations) {
    console.log(`  ✗ ${rel(v.file)}: ${v.fn}(${v.param}) — ${v.member} — ${v.kind}`);
  }
  for (const b of boundary) {
    console.log(`  ✗ src/App.vue:${b.line}: зависимость \`${b.depsName}\` — параметр \`${b.param}\` №${b.from} уходит в аргумент №${b.to} вызова \`${b.call}\` (аргумент теряется)`);
  }
  for (const a of arity) {
    console.log(`  ✗ src/App.vue:${a.line}: зависимость \`${a.dep}\` (в \`Фича.${a.fn}\`) принимает ${a.arity} аргумент(а), фича передаёт ${a.passed} — ${a.kind}`);
  }
  console.log('\n  хелп: владельцу соответствует `param.state.<поле>` (или метод из');
  console.log('  фабрики). Прочитать `param.<поле>` — значит получить undefined и');
  console.log('  записать пустоту, ничего не сломав звонком (22.10: архив чатов был');
  console.log('  пустым ВЕЗДЕ, и смоуки этого не видели).');
  console.log('  Замыкание зависимости обязано принимать столько же аргументов,');
  console.log('  сколько ему передают, и в том же порядке: (k, m) => this.f(k, m).');
  process.exit(1);
}
console.log(`✓ owner-contract-gate: владельцев ${aliases.size}, модулей фич ${nsToModule.size}, зависимостей с потерей аргумента ${boundary.length}, расхождений арности ${arity.length} — границ «фича ↔ владелец» не расходится`);
