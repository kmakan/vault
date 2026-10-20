// Общий переписыватель импортов для смоуков, копирующих модуль в /tmp.
//
// ЗАЧЕМ. Смоук читает настоящий src/features/<модуль>.js и записывает копию в /tmp,
// чтобы подсунуть моки вместо Tauri-зависимостей. Но относительные импорты в
// копии разрешаются от /tmp: `from '../identity.js'` превращается в
// `/tmp/identity.js` и падает с ERR_MODULE_NOT_FOUND.
//
// Раньше каждый смоук переписывал импорты СПИСКОМ, написанным руками. Отсюда
// два свойства, оба плохие:
//   · каждый НОВЫЙ импорт в модуле ломал соответствующий смоук молча;
//   · если модуль уже имел импорт, которого нет в списке, смоук был сломан
//     ДО НАЧАЛА этой работы — и никто этого не знал, потому что смоук не
//     запускали.
//
// Оба класса поломок наблюдались: `incoming-smoke` я сломал сам (ADR-003 §5.1),
// а `calls/edits/history/profiles` лежали сломанными давно.
//
// ЧТО ДЕЛАЕТ ЭТОТ ХЕЛПЕР. Вызовите ПОСЛЕ подстановки моков: он переводит все
// оставшиеся относительные импорты в абсолютные пути настоящих файлов. Модули
// без Tauri-зависимостей (identity.js, group-pin-wire.js) подхватываются
// настоящими — это правильно и дешевле, чем писать для каждого новый мок.
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

// fromDir — каталог НАСТОЯЩЕГО модуля (то, из которого копия пришла).
export function absolutizeImports(src, fromDir) {
  return src.replace(/(from\s+['"])(\.{1,2}\/[^'"]+)(['"])/g, (_m, pre, rel, post) => {
    const abs = path.resolve(fromDir, rel);
    // Заменяем и кавычки: оригинал мог быть в любых из двух.
    return pre + abs + post;
  });
}

// Чтение ИСХОДНИКА модуля для СТАТИЧЕСКИХ проверок контракта (не копирование).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ХЕЛПЕР. import-gate ищет копируемые модули по шаблону
// `readFileSync(ROOT + '...src/....js')` и требует, чтобы все Tauri-зависимости
// такого модуля были замоканы. Для статической проверки (например, «все вызовы
// моста в relay.js передают ctx») модуль НЕ копируется и не исполняется — ни один
// мок не нужен, но гейт объявлял исправный смоук сломанным. Этот хелпер
// фиксирует намерение явно: читаю текст, а не подменяю модуль.
export function readModuleSource(rel) {
  return readFileSync(path.resolve(path.dirname(import.meta.dirname), rel), 'utf8');
}

// Спецификаторы, которые в копии остались «голыми» (не относительные и не
// абсолютные) и потому НЕ резолвятся от её каталога.
//
// ЗАЧЕМ. Копия живёт в /tmp, где node_modules нет: любой оставшийся пакетный
// импорт ('@tauri-apps/api/core', 'vue') даёт ERR_MODULE_NOT_FOUND — при
// загрузке копии, то есть ДО первого утверждения теста. Смоук падает «не
// там, где сломан», и (если он не подключён к сборке) — молча.
//
// Именно так сломался `incoming-smoke` после W1: Tauri-мост был замотан для
// копии channels.js, а копия incoming.js пошла поимпорту '@tauri-apps/api/core'
// и упала при загрузке. Гейт (import-gate) проверял это ФАЙЛОВО и потому не
// увидел: спецификатор был назван в файле — хоть и для другой копии.
//
// Проверка резолвимости, а не «список запрещённых»: если смоук копирует внутрь
// проекта, 'vue' резолвится от каталога копии — и это не поломка.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
// Проверяются ТОЛЬКО статические импорты. Динамические — законный способ
// подключить ОПЦИОНАЛЬНЫЙ плагин: `try { await import('@tauri-apps/plugin-http') }
// catch { /* фолбэк на window.fetch */ }` (relay-client.js). Такой импорт в
// копии из /tmp упадёт — и это НЕ поломка: модуль сам это предусмотрел.
function unresolvableBare(outFile, src) {
  const clean = stripComments(src);
  const specs = [
    ...[...clean.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...clean.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ].filter((sp) => !sp.startsWith('.') && !path.isAbsolute(sp));
  if (!specs.length) return [];
  let req;
  try { req = createRequire(path.resolve(outFile)); } catch { return []; }
  return [...new Set(specs)].filter((sp) => {
    try { req.resolve(sp); return false; } catch { return true; }
  });
}

// Полный цикл подготовки модуля для смоука.
//   realFile — путь к настоящему файлу модуля
//   mocks    — объект { 'спецификатор как в исходнике': 'ИМЯ ФАЙЛА МОКА' }
//              Имя файла мока, а не путь: полный путь достраивается от mocksDir.
//              Голый спецификатор ('api.js') Node не разрешает — это молча падает
//              как ERR_MODULE_NOT_FOUND, поэтому строим путь здесь.
//   extra    — массив [что_заменить, на_что]. Нужен для мест, где подмена не
//              импорт:
//                · динамический импорт import('./crypto.js') — не `from ...`,
//                  и общий переписыватель импортов его не видит;
//                · выражения вида import.meta.env.VITE_RELAY_URL || '' — в Node
//              import.meta.env не существует, и модуль падает при загрузке;
//                · подмена ИМЕНИ импорта на оператор:
//                  "import { invoke } from '@tauri-apps/api/core';" →
//                  "const invoke = globalThis.__INVOKE__;" (recovery-session-smoke).
//              Эти подмены терялись при первой же конвертации, потому что
//              шаблон искал только `from '...'`; восемь смоуков падали на этом.
// Возвращает путь к записанной копии.
export function prepareModuleCopy(realFile, outFile, mocks, mocksDir, extra) {
  mkdirSync(mocksDir, { recursive: true });
  let src = readFileSync(realFile, 'utf8');
  // Сначала моки: они должны выиграть, потому что absolutizeImports идёт после.
  for (const [spec, mockFile] of Object.entries(mocks || {})) {
    const target = path.isAbsolute(mockFile) ? mockFile : path.join(mocksDir, mockFile);
    src = src.split("from '" + spec + "'").join('from "' + target + '"');
    src = src.split('from "' + spec + '"').join('from "' + target + '"');
    // Динамический импорт: import('./crypto.js') и import("./crypto.js").
    src = src.split("import('" + spec + "')").join('import("' + target + '")');
    src = src.split('import("' + spec + '")').join('import("' + target + '")');
  }
  for (const [from, to] of extra || []) {
    src = src.split(from).join(to);
  }
  src = absolutizeImports(src, path.dirname(realFile));
  // Копия обязана быть ЗАГРУЖАЕМОЙ. Если в ней остался пакетный импорт, копия
  // упадёт при загрузке с ERR_MODULE_NOT_FOUND — и смоук будет красным «не
  // там, где сломан». Ловим здесь, где копия делается: сообщение называет
  // и спецификатор, и модуль. Проверка ДО записи: сломанная копия не должна
  // попасть на диск (иначе следующий запуск прочитает её и упадёт о позже).
  const bare = unresolvableBare(outFile, src);
  if (bare.length) {
    throw new Error(
      'prepareModuleCopy: в копии ' + path.basename(outFile) + ' (из ' + path.basename(realFile) +
      ') остались нерезолвящиеся импорты: ' + bare.join(', ') +
      '. Замокан их в карте моков (или замени текстом через `extra`) — иначе ' +
      'копия упадёт с ERR_MODULE_NOT_FOUND при загрузке.');
  }
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, src);
  // Возвращаем ТРАНСФОРМИРОВАННЫЙ src (а не путь), чтобы вызывающие, оборачивающие
  // результат внешним writeFileSync, записали именно код, а не путь к файлу.
  return src;
}