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
    // prepareModuleCopy, ЛИБО в строковом литерале какой-либо .replace в смоуке.
    // Второй способ применяет recovery-session-smoke: таури-зависимость там
    // подменяется оператором `const invoke = globalThis.__INVOKE__;`, а не файлом,
    // и в карту моков она не попадает. Если учитывать только карту, гейт
    // объявит исправный смоук сломанным — то есть станет врущим, а гейт с
    // ложными срабатываниями отключают.
    const mentions = (sp) =>
      body.includes("'" + sp + "'") || body.includes('"' + sp + '"');
    for (const sp of heavy) {
      if (!mentions(sp)) {
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