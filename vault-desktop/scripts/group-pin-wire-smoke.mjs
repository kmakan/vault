// Форма pin-письма: отправка и приём (ADR-003 Этап 3, партия 13).
//
// Тест на ЭТУ ФОРМУ, а не на её поля по отдельности, потому что поломка здесь
// не «пришло не то», а «пришло не то, и это выглядит как работающее».
//
// Сценарий, ради которого модуль и выделен. Приёмник спрашивает
// obj.action === 'unpin'. Если отправитель переименует action в op — проверка
// вернёт ложь, ветка unpin не выполнится, и ОТКРЕПЛЕНИЕ ПРЕВРАТИТСЯ В
// ЗАКРЕПЛЕНИЕ: человек нажал «открепить», сообщение осталось закреплённым, ни
// исключения, ни записи в журнал. Худший вид поломки.
//
// Проверка ниже делает ровно это расхождение и требует, чтобы parsePinWire его
// отверг: неизвестное действие обязано давать null, а не тихий pin.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/group-pin-wire-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
writeFileSync(MOCKS + '/pin.mjs', readFileSync(path.join(ROOT, 'src', 'features', 'group-pin-wire.js'), 'utf8'));
const P = await import(MOCKS + '/pin.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };

console.log('\nADR-003 Этап 3, партия 13 · форма pin-письма');

// ── Решение: закрепить или открепить ────────────────────────────────────
const msg = { id: 'm-1', content: '  Привет\n\n  мир  ' };
let d = P.buildPinDecision(msg, null, 100);
ok('не закреплено → pin', d.action === 'pin');
ok('закрепляется именно то сообщение', d.msg_id === 'm-1');

d = P.buildPinDecision(msg, { msg_id: 'm-2' }, 100);
ok('закреплено ДРУГОЕ → pin, а не unpin', d.action === 'pin');

d = P.buildPinDecision(msg, { msg_id: 'm-1' }, 100);
ok('уже закреплено ЭТО ЖЕ → unpin (переключатель)', d.action === 'unpin');

// Превью: пробелы схлопнуты, обрезано до 140.
ok('переносы строк схлопнуты в пробелы', d.preview === 'Привет мир');
ok('ts прокинут', d.ts === 100);
let big = P.buildPinDecision({ id: 'm-2', content: 'я'.repeat(400) }, null, 1);
ok('длинное превью обрезано до 140', big.preview.length === 140);
ok('и это единственное, что попало в превью', big.preview === 'я'.repeat(140));

// ── Сборка письма ───────────────────────────────────────────────────────
let wire = P.buildPinWirePayload({ msg_id: 'm-1', action: 'pin', preview: 'ПР', ts: 7 });
ok('версия формы на месте', wire.pin === 1);
ok('поля формы полные',
  JSON.stringify(Object.keys(wire).sort()) === '["action","msg_id","pin","preview","ts"]');

// ГЛАВНОЕ. Собрано и разобрано тем же модулем — по определению совпадёт.
// Ценность в следующем блоке, где совпадение ломается намеренно.

// ── Приём ───────────────────────────────────────────────────────────────
let got = P.parsePinWire({ pin: 1, msg_id: 'm-1', action: 'pin', preview: 'ПР', ts: 7 });
ok('приём pin: msg_id на месте', got.msg_id === 'm-1');
ok('приём pin: превью на месте', got.preview === 'ПР');
ok('приём pin: ts на месте', got.ts === 7);

got = P.parsePinWire({ pin: 1, msg_id: 'm-1', action: 'unpin', preview: '', ts: 7 });
ok('приём unpin → msg_id становится null (закрепление снимается)', got.msg_id === null);

got = P.parsePinWire({ pin: 1, msg_id: 'm-1', action: 'pin', preview: 'ПР' }, 555);
ok('письмо без ts → ts из даты письма', got.ts === 555);

got = P.parsePinWire({ pin: 1, msg_id: 'm-1', action: 'pin' }, 0);
ok('и без ts, и без даты → 0, не NaN', got.ts === 0);

ok('чужое письмо (нет pin) → null', P.parsePinWire({ read: 1, msg_ids: [] }) === null);
ok('не pin-версии → null', P.parsePinWire({ pin: 2, msg_id: 'm' }) === null);
ok('без msg_id → null (закреплять нечего)', P.parsePinWire({ pin: 1 }) === null);
ok('не объект → null', P.parsePinWire(null) === null);
ok('строка вместо объекта → null, без исключения', P.parsePinWire('pin') === null);

// ── ПОЧЕМУ ЗАЩИТЫ НА СТОРОНЕ ПРИЁМНИКА НЕ СУЩЕСТВУЕТ ────────────────────
// Первая версия этого места написала проверку «при расхождении форм не будет
// тихого pin» и она ПРОХОДИЛА, будучи чистой тавтологией: условие содержало
// got.msg_id === 'm-1', истинное при любом исходе. Она заявляла защиту от
// поломки, от которой не защищала.
//
// Что происходит на самом деле, если отправитель переименует action в op:
got = P.parsePinWire({ pin: 1, msg_id: 'm-1', op: 'unpin', preview: 'ПР', ts: 7 });
ok('расхождение action→op даёт ТИХИЙ PIN — это правда, а не страшилка',
  got.msg_id === 'm-1');
ok('то же самое даёт старый клиент, у которого action не было',
  P.parsePinWire({ pin: 1, msg_id: 'm-1', preview: 'ПР', ts: 7 }).msg_id === 'm-1');

// И ВОТ ПОЧЕМУ ЗАЩИТЫ НА ПРИЁМНИКЕ БЫТЬ НЕ МОЖЕТ: три разных письма дают
// ОДИН И ТОТ ЖЕ результат, и приёмник физически не может их различить.
//   1) законный pin нового клиента
//   2) unpin, у которого переименовали поле
//   3) pin старого клиента без поля action
const a = JSON.stringify(P.parsePinWire({ pin: 1, msg_id: 'm', action: 'pin', ts: 1 }));
const b = JSON.stringify(P.parsePinWire({ pin: 1, msg_id: 'm', op: 'unpin', ts: 1 }));
const c = JSON.stringify(P.parsePinWire({ pin: 1, msg_id: 'm', ts: 1 }));
ok('все три неразличимы на стороне приёмника', a === b && b === c);

ok('значит различать ДОЛЖЕН отправитель, а единственный способ — общая константа',
  P.PIN_ACTION.UNPIN === 'unpin' && P.PIN_ACTION.PIN === 'pin');

// Сквозной путь: собрали → распарсили → то же самое.
const decision = P.buildPinDecision({ id: 'm-9', content: 'текст  из\nстроки' }, null, 42);
const parsed = P.parsePinWire(P.buildPinWirePayload(decision));
ok('СБОРКА → РАЗБОР БЕЗ ПОТЕРЬ (сквозной путь отправки)',
  parsed.msg_id === decision.msg_id
  && parsed.preview === decision.preview
  && parsed.ts === decision.ts);

// Тот же сквозной путь для unpin.
const off = P.buildPinDecision({ id: 'm-9', content: 'x' }, { msg_id: 'm-9' }, 42);
const parsedOff = P.parsePinWire(P.buildPinWirePayload(off));
ok('и для открепления: сквозной путь снимает закрепление',
  off.action === 'unpin' && parsedOff.msg_id === null);

// ── ГЕЙТ: ЛИТЕРАЛЫ ФОРМЫ ЖИВУТ ТОЛЬКО В МОДУЛЕ ──────────────────────────
// Раз приёмник помочь не может, защита единственная одна: обе стороны обязаны
// импортировать имя поля, а не писать его строкой. Строка 'unpin' или 'pin: 1'
// где угодно ещё в коде — это ровно тот путь, которым расхождение и вернётся.
console.log('\n── гейт: литералы формы pin вне модуля ──');
const FORBIDDEN = [
  { re: /['"]unpin['"]/, what: "строка 'unpin'" },
  { re: /['"]pin['"]\s*:/, what: "поле pin: в литерале объекта" },
  { re: /action\s*:\s*['"]/, what: "поле action: в литерале объекта" },
  { re: /\.pin\s*===\s*1/, what: "сравнение obj.pin === 1" },
];
const files = [
  'src/App.vue',
  'src/features/groups.js',
  'src/features/groups-load.js',
  'src/features/groups-create.js',
  'src/features/groups-clone.js',
  'src/features/groups-migrate.js',
  'src/features/group-meta.js',
];

// Первая версия гейта ругалась на <Icon name="pin" /> в шаблоне и на
// комментарий, пересказывающий форму. Оба — ложные срабатывания, а гейт с
// ложными срабатываниями отключают целиком, и тогда перестаёт работать и
// настоящая проверка. Поэтому: из .vue сканируется только <script>, из кода
// вырезаются комментарии — пересказ формы в комментарии безопасен и даже
// полезен.
function scannable(file) {
  let body = readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.vue')) {
    const m = body.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    body = m ? m[1] : '';
  }
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')   // блочные комментарии
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // строковые (URL вида https:// не задевает)
}

let offenders = [];
for (const f of files) {
  const body = scannable(f);
  for (const { re, what } of FORBIDDEN) {
    if (re.test(body)) offenders.push(f + ' → ' + what);
  }
}
ok('форма pin нигде не собрана и не прочитана литералами', offenders.length === 0);
for (const o of offenders) console.log('      ↳ ' + o);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);