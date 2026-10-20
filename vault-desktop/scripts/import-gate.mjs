// Гейт: смоук, копирующий модуль, обязан использовать общий хелпер.
//
// ЗАЧЕМ. Смоук читает настоящий src/features/<модуль>.js и пишет копию в /tmp,
// подменив зависимости моками. Относительные импорты в копии разрешаются от
// /tmp и падают с ERR_MODULE_NOT_FOUND — если их не переписали.
//
// Раньше каждый смоук переписывал импорты СПИСКОМ, написанным руками. Отсюда
// два класса поломок, оба наблюдались в этой ветке:
//   · новое добавление в модуль ломает смоук молча (incoming-smoke — моя
//     регрессия, ADR-003 §5.1);
//   · импорт, добавленный ДО сессии, уже ломал смоук, и никто об этом не знал
//     (calls/edits/history/profiles/recovery-session — 342 проверки мёртвыми).
//
// Правило здесь простое и проверяемое: смоук, копирующий модуль с относительными
// импортами, обязан звать prepareModuleCopy. Список импортов не пишется руками —
// значит новое добавление не может его сломать.
//
// Вторая проверка: каждый относительный импорт копируемого модуля обязан
// вести в существующий файл. Это ловит не «забыли переписать», а «переименовали
// или удалили модуль» — молчаливую поломку другого рода.
//
// Гейт дешёвый: секунды вместо двадцати минут полного прогона.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

// Модуль, который смоук копирует. Две формы:
//   readFileSync(ROOT + '/src/features/x.js')   — старый стиль
//   prepareModuleCopy(ROOT + '/src/features/x.js', …)  — общий хелпер
// Вторая форма обязана в списке: гейт, который ищет только первую, ПОСЛЕ
// конвертации всех смоуков начинает находить ноль копирований и радостно
// проходит, не проверяя ничего. Так и случилось — и это ровно та ловушка,
// которую гейт сам себе ставит.
const COPY_OLD = /readFileSync\(\s*(?:ROOT|process\.cwd\(\))\s*\+\s*'([^']*src\/[^']+\.js)'/g;
const COPY_NEW = /prepareModuleCopy\(\s*ROOT\s*\+\s*'([^']*src\/[^']+\.js)'/g;
// Относительный импорт в исходнике.
const REL_IMPORT = /(?:from|import)\s+['"](\.{1,2}\/[^'"]+)['"]/g;

// ── Разбор вызовов prepareModuleCopy: какая копия и с какими моками ──────
//
// ДЫРКА, КОТОРУЮ ЭТО ЗАКРЫВАЕТ. Проверка «спецификатор замотан» была
// ФАЙЛОВОЙ: `body.includes(spec)`. Смоук, который копирует ДВА модуля, мог
// замостить '@tauri-apps/api/core' для одного, а второй остался с
// настоящим импортом — и гейт был зелёный. Именно так сломался
// `incoming-smoke` после W1: Tauri-мост был замотан для копии channels.js,
// а копия incoming.js пошла поимпорту '@tauri-apps/api/core' и упала при
// загрузке с ERR_MODULE_NOT_FOUND. Проверка должна быть ПОКОПИЙНОЙ:
// у каждой копии — свой набор моков.
//
// Разбор делается по ТЕКСТУ смоука (без запуска): аргументы вызова режутся
// по верхнему уровню, третий аргумент — литерал карты моков, пятый (`extra`)
// — замены, которых в карте нет.
function findPrepareCalls(body) {
  const calls = [];
  const re = /prepareModuleCopy\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const open = body.indexOf('(', m.index);
    if (open < 0) break;
    let i = open + 1, depth = 1, quote = null;
    for (; i < body.length && depth > 0; i++) {
      const ch = body[i];
      if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    calls.push(body.slice(open + 1, i - 1));
  }
  return calls;
}

function splitArgs(text) {
  const args = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  args.push(text.slice(start));
  return args.map((a) => a.trim());
}

// Ключи верхнего уровня объектного литерала. null — аргумент не литерал
// (переменная) → набор моков этой копии неизвестен → проверку пропускаем,
// чтобы не стать врущим гейтом.
function mapKeys(arg) {
  if (!arg || !arg.startsWith('{')) return null;
  const keys = new Set();
  let depth = 0, quote = null;
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if ('([{'.includes(ch)) { depth++; continue; }
    if (')]}'.includes(ch)) { depth--; continue; }
    if (depth === 1) {
      const m = /^\s*(['"])((?:[^'"\\]|\\.)*)\1\s*:/.exec(arg.slice(i));
      if (m) { keys.add(m[2]); i += m[0].length - 1; }
    }
  }
  return keys;
}

// Путь к копируемому модулю из первого аргумента: `ROOT + '/src/…'`,
// идентификатор (`SRC`), либо константа с путём. null — неизвестно.
function sourcePath(arg, body) {
  if (!arg) return null;
  const lit = /(['"])((?:[^'"\\]|\\.)*)\1/.exec(arg);
  if (lit && /\+/.test(arg)) return lit[2];
  const id = /^[A-Za-z_$][\w$]*$/.test(arg);
  if (id) {
    const decl = new RegExp('const\\s+' + id + '\\s*=\\s*([^;]+);').exec(body);
    if (decl) {
      const p = /(['"])((?:[^'"\\]|\\.)*)\1/.exec(decl[1]);
      if (p) return p[2];
    }
  }
  return null;
}


const smokes = readdirSync(SCRIPTS)
  .filter((f) => /smoke.*\.mjs$/.test(f) && f !== 'smoke-imports.mjs' && f !== 'import-gate.mjs')
  .sort();

const problems = [];
let checked = 0, copies = 0;

for (const sm of smokes) {
  const body = readFileSync(path.join(SCRIPTS, sm), 'utf8');
  const targets = [
    ...[...body.matchAll(COPY_OLD)].map((m) => m[1]),
    ...[...body.matchAll(COPY_NEW)].map((m) => m[1]),
  ].map((x) => x.replace(/^\/+/, ''));
  if (!targets.length) continue;
  const usesHelper = body.includes('prepareModuleCopy');

  // Моки ПОКОПИЙНО: у каждой копии свой набор подменённых спецификаторов.
  // Ключ копии — путь модуля от 'src/' (корни у смоуков разные).
  const keyOf = (p) => {
    const i = String(p).indexOf('src/');
    return (i >= 0 ? String(p).slice(i) : String(p).replace(/^\/+/, ''));
  };
  const copiesByKey = new Map();
  for (const args of findPrepareCalls(body)) {
    const parsed = splitArgs(args);
    const src = sourcePath(parsed[0], body);
    const keys = mapKeys(parsed[2]);
    if (!src || !keys) continue;
    // `extra` — замены, которых нет в карте моков (например, подмена ИМЕНИ
    // импорта на оператор: recovery-session-smoke). Их спецификаторы тоже
    // считаются «замотанными» — но только для ЭТОЙ копии.
    const extra = new Set(
      [...(parsed[4] || '').matchAll(/(['"])((?:[^'"\\]|\\.)*)\1/g)].map((m) => m[2]),
    );
    copiesByKey.set(keyOf(src), { keys, extra });
  }

  for (const rel of targets) {
    // ROOT в смоуках разный: где-то это корень vault-desktop, где-то сам каталог
    // scripts (там пути вида ROOT + '/../src/...'). Первая версия гейта
    // предположила только первый вариант и объявила пять исправных смоуков
    // сломанными — то есть сам стал источником ложных срабатываний.
    // Принимаем файл, если он находится по любой из двух баз.
    const candidates = [path.join(ROOT, rel), path.join(SCRIPTS, rel)]
      .map((p) => path.resolve(p));
    const real = candidates.find((p) => existsSync(p));
    if (!real) {
      problems.push(sm + ' → копирует несуществующий ' + rel);
      continue;
    }
    const src = readFileSync(real, 'utf8');
    const relImports = [...src.matchAll(REL_IMPORT)].map((m) => m[1]);
    if (!relImports.length) continue;
    copies++; checked++;
    if (!usesHelper) {
      problems.push(
        sm + ' → копирует ' + rel + ' (' + relImports.length + ' относит. импортов) ' +
        'вручную: списком; перевести на prepareModuleCopy');
      continue;
    }
    // Относительные импорты обязаны вести в существующие файлы.
    for (const ri of relImports) {
      const target = path.resolve(path.dirname(real), ri);
      if (!existsSync(target)) {
        problems.push(sm + ' → ' + rel + ' импортирует несуществующий ' + ri);
      }
    }
    // Tauri-зависимые модули ОБЯЗАНЫ быть подменены моками.
    //
    // Если оставить такой импорт как есть, absolutizeImports подставит
    // НАСТОЯЩИЙ файл — и модуль заработает против настоящего api.js, который
    // трогает localStorage и зовёт invoke. Смоук при этом может остаться
    // зелёным, проверяя не код, а подделку: на send-smoke так и вышло, когда
    // построчный разбор увидел только первый .replace из четырёх в одной
    // строке, и три мока молча потерялись.
    const heavy = [...src.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1])
      .filter((sp) => sp.startsWith('@tauri-apps/') || /(^|\/)(api|crypto|relay-client)\.js$/.test(sp));
    // Спецификатор считается подменённым, если он назван ЛИБО в карте моков
    // ЭТОЙ копии, ЛИБО в её `extra`-заменах, ЛИБО в строковом литерале
    // какой-либо .replace в смоуке.
    //
    // Карта моков берётся ПОКОПИЙНО. Файловая проверка (body.includes) была
    // дырой: замотанный для ОДНОЙ копии спецификатор засчитывался и другой
    // копии — так и сломался incoming-smoke (W1): '@tauri-apps/api/core' был
    // замотан для копии channels.js, а копия incoming.js пошла поимпорту
    // и упала при загрузке с ERR_MODULE_NOT_FOUND. Если карту копии разобрать
    // не удалось (аргумент — переменная), откатываемся на файловую проверку:
    // гейт с ложными срабатываниями отключают, а врущий гейт хуже.
    const copy = copiesByKey.get(keyOf(rel));
    const textReplaced = (sp) => {
      const esc = sp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('\\.replace\\([\\s\\S]{0,400}?' + esc).test(body);
    };
    for (const sp of heavy) {
      const mocked = copy
        ? (copy.keys.has(sp) || copy.extra.has(sp) || textReplaced(sp))
        : (body.includes("'" + sp + "'") || body.includes('"' + sp + '"') || textReplaced(sp));
      if (!mocked) {
        problems.push(
          sm + ' → ' + rel + ' тянет ' + sp + ' БЕЗ МОКА: смоук пойдёт против '
          + 'настоящего модуля и, возможно, останется зелёным на подделке');
      }
    }
  }
}

// Ноль копирований — это не «чисто», это «проверять нечего».
if (!copies) {
  console.log('✗ import-gate: НИ ОДНОГО копирования модуля не найдено.');
  console.log('  Гейт ничего не проверил. Либо шаблон поиска устарел, либо смоуки');
  console.log('  перестали копировать модули — и это тоже надо знать.');
  process.exit(1);
}

if (problems.length) {
  console.log('✗ import-gate: ' + problems.length + ' проблем(ы)');
  for (const p of problems) console.log('  ' + p);
  console.log('\n  хелпер: scripts/smoke-imports.mjs::prepareModuleCopy');
  process.exit(1);
}
console.log('✓ import-gate: ' + copies + ' копирований модулей, все на общем хелпере, '
  + 'относительные импорты разрешаются');