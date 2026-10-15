// Геолокация и ссылка на карту (ADR-003 Этап 3, партия 13).
//
// Здесь тестируется не арифметика, а ТАЙМИНГ: navigator.geolocation —
// единственный API, который разрешается когда угодно, включая «никогда».
//
// ПЕРВАЯ ВЕРСИЯ ЭТОГО ФАЙЛА проверяла, что «поздний ответ после таймаута не
// переписывает результат». Проверка была пустой: значение промеса нельзя
// перезаписать, это гарантия языка, а вызывающий после тоста делает return.
// Такой тест проходил бы и при полностью сломанном коде.
//
// ЧТО НА САМОМ ДЕЛЕ ДАЁТ clearTimeout В finish: без него таймер на 8 секунд
// продолжал бы висеть ПОСЛЕ мгновенного успеха, удерживая событийный цикл. В
// приложении это незаметно, на узлах — задержка выхода. Это и проверяется ниже:
// таймер обязан сниматься при успехе, а не только по таймауту.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/geo-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
writeFileSync(MOCKS + '/geo.mjs', readFileSync(path.join(ROOT, 'src', 'geo.js'), 'utf8'));
const G = await import(MOCKS + '/geo.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\nADR-003 Этап 3, партия 13 · геолокация «я здесь»');

// ── Формат координат ───────────────────────────────────────────────────
ok('пять знаков после запятой', G.formatCoords(55.755826, 37.6173) === '55.75583, 37.61730');
ok('строка тоже принимается', G.formatCoords('55.755826', '37.6173') === '55.75583, 37.61730');
// Разница между 55.75583 и 55.755826 — около метра. Меньше знаков —
// «Геолокация недоступна» против квартала.
ok('точность 5 знаков — разница между округлениями мала',
  Math.abs(55.75583 - 55.755826) < 0.00001);

// ── Ссылка на карту ─────────────────────────────────────────────────────
const url = G.buildMapUrl('55.75583, 37.61730');
ok('mlat и mlon из координат',
  url.includes('mlat=55.75583') && url.includes('mlon=37.61730'));
ok('зум 17', url.includes('#map=17/'));
ok('метка OSM берётся из того же якоря, что и запрос',
  url.endsWith('#map=17/55.75583/37.61730'));
ok('пробелы вокруг запятой не попадают в ссылку',
  !url.includes('%20') && !url.includes(' '));

// ── Текст сообщения ─────────────────────────────────────────────────────
const text = G.buildGeoMessage('Я здесь:', '55.75583, 37.61730');
ok('подпись, координаты, ссылка — в этом порядке',
  text.startsWith('Я здесь: 55.75583, 37.61730 — https://'));
ok('ссылка внутри сообщения та же самая',
  text.includes(G.buildMapUrl('55.75583, 37.61730')));

// ── Промис: первый ответ побеждает ──────────────────────────────────────
let resolveCb = null, errorCb = null, opts = null;
const geo = {
  getCurrentPosition: (okCb, errCb, o) => { resolveCb = okCb; errorCb = errCb; opts = o; },
};
let got = await G.resolveCurrentCoords({ timeoutMs: 60, geo });
ok('без ответа за отведённое время → null', got === null);

// Таймаут сработал. Поздний ответ приходит — и обязан быть проигнорирован
// ПРОВЕРЯЕМО: он не должен дёргать clearTimeout повторно и не должен ничего
// портить. Считаем вызовы clearTimeout, а не «стало ли значение другим».
let cleared = 0;
const realClear = globalThis.clearTimeout;
globalThis.clearTimeout = (t) => { cleared++; return realClear(t); };
resolveCb({ coords: { latitude: 1, longitude: 2 } });
await wait(20);
globalThis.clearTimeout = realClear;
ok('поздний ответ не вызывает повторной очистки таймера', cleared === 0);

// А вот главное свойство, ради которого существует clearTimeout в finish:
// при МГНОВЕННОМ успехе таймер должен быть снят, иначе он будет висеть все
// 8 секунд, удерживая событийный цикл. Проверяем наблюдаемо, а не на словах.
cleared = 0;
globalThis.clearTimeout = (t) => { cleared++; return realClear(t); };
let resolveCb3 = null;
const pFast = G.resolveCurrentCoords({
  timeoutMs: 8000,
  geo: { getCurrentPosition: (okCb) => { resolveCb3 = okCb; } },
});
resolveCb3({ coords: { latitude: 1, longitude: 2 } });
await pFast;
globalThis.clearTimeout = realClear;
ok('при мгновенном успехе таймер СНЯТ — иначе он держит цикл 8 секунд', cleared === 1);

// Успех вовремя.
let resolveCb2 = null;
const geo2 = { getCurrentPosition: (okCb) => { resolveCb2 = okCb; } };
const p2 = G.resolveCurrentCoords({ timeoutMs: 500, geo: geo2 });
resolveCb2({ coords: { latitude: 10.5, longitude: 20.25 } });
ok('успех вовремя → координаты', (await p2) === '10.50000, 20.25000');

// Отказ геолокации (пользователь запретил) — то же null.
const p3 = G.resolveCurrentCoords({
  timeoutMs: 500,
  geo: { getCurrentPosition: (okCb, errCb) => setTimeout(() => errCb(new Error('denied')), 5) },
});
ok('запрет геолокации → null, без исключения', (await p3) === null);

// ── Окно устаревания и внутренний таймаут ───────────────────────────────
opts = null;
await G.resolveCurrentCoords({ timeoutMs: 9000, geo });
ok('внутренний таймаут на 1000 мс короче внешнего', opts.timeout === 8000);
ok('потолок устаревания 5 минут', opts.maximumAge === 300000);

// ─- Отсутствие API ──────────────────────────────────────────────────────
ok('нет navigator.geolocation → null, без ReferenceError',
  (await G.resolveCurrentCoords({ timeoutMs: 50, geo: null })) === null);
ok('геолокация есть, но без метода → null',
  (await G.resolveCurrentCoords({ timeoutMs: 50, geo: {} })) === null);

// Синхронный бросок — в некоторых сборках так ведёт себя navigator при
// запрете доступа. Промис обязан разрешиться, а не зависнуть.
const pThrow = G.resolveCurrentCoords({
  timeoutMs: 50,
  geo: { getCurrentPosition() { throw new Error('SecurityError'); } },
});
ok('синхронный бросок navigator → null, без зависания', (await pThrow) === null);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);