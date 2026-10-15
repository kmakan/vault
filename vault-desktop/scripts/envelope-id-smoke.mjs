// Идентификатор сообщения: настоящий из конверта и заглушка (ADR-003 Этап 3,
// партия 17).
//
// Тест на ДЕФЕКТ, а не на строки. Дефект был наблюдаемым: пользователь видел своё
// отправленное сообщение дважды.
//
// Как он возникал. При отправке id вытаскивается из конверта; если конверт не
// построен или не разобран, оптимистичная запись получает заглушку. Заглушек
// было три формулы, а mergePending сопоставлял оптимистичное сообщение с
// настоящим по ТОЧНОМУ равенству id — то есть заглушку не узнавал никогда. Она
// оставалась в списке до страховки в десять минут.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/envelope-id-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
writeFileSync(MOCKS + '/eid.mjs', readFileSync(path.join(ROOT, 'src', 'features', 'envelope-id.js'), 'utf8'));
const E = await import(MOCKS + '/eid.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };

console.log('\nADR-003 Этап 3, партия 17 · идентификатор сообщения');

// ── Настоящий id из конверта ───────────────────────────────────────────
ok('id вытаскивается из конверта', E.envelopeIdOf('{"id":"msg-42","x":1}') === 'msg-42');
ok('неразобранный конверт → пустая строка, не исключение',
  E.envelopeIdOf('не json {{{') === '');
ok('пустая строка → пустая строка', E.envelopeIdOf('') === '');
ok('null/undefined → пустая строка, без исключения',
  E.envelopeIdOf(null) === '' && E.envelopeIdOf(undefined) === '');
ok('конверт без поля id → пустая строка', E.envelopeIdOf('{"x":1}') === '');
ok('id = 0 НЕ пустой: нулевой идентификатор бывает валиден', E.envelopeIdOf('{"id":0}') === 0);

// ── Заглушка: одна формула на проект ───────────────────────────────────
const p1 = E.pendingIdOf(1700000000000, 0.5);
ok('заглушка помечена префиксом pending-', E.isPendingId(p1));
ok('настоящий id заглушкой не считается', !E.isPendingId('msg-42'));

// ГЛАВНОЕ ПРО ТЕПЕРЬ: коллизия. При чистом Date.now() две отправки в одну
// миллисекунду дали бы ОДИН id, и записи слились бы — то же самое, но наоборот:
// пропало бы сообщение.
let collisions = 0;
const seen = new Set();
for (let i = 0; i < 5000; i++) {
  const id = E.pendingIdOf(1700000000000, 0.5); // ОДНО и то же время, одна и та же случайность
  if (seen.has(id)) collisions++;
  seen.add(id);
}
ok('5000 заглушек с ОДНИМ временем и ОДНОЙ случайностью — все различны', collisions === 0);

// Разные запуски приложения (счётчик начинается заново) тоже не должны
// столкнуться — время и случайность это обеспечивают.
const a = E.pendingIdOf(1700000000000, 0.1);
const b = E.pendingIdOf(1700000000000, 0.9);
ok('разные запуски не дают одинаковых заглушек', a !== b);

// Счётник насыщается, но не ломает уникальность в пределах окна.
let c2 = 0;
const seen2 = new Set();
for (let i = 0; i < 70000; i++) {
  const id = E.pendingIdOf(1700000000000, 0.5);
  if (seen2.has(id)) c2++;
  seen2.add(id);
}
ok('через счётчик 0xffff уникальность не теряется (окно 65536 шире всего сюда)', c2 === 0);

// ── Сопоставление заглушки с настоящим письмом ─────────────────────────
const NOW = Date.now();
const pending = { id: p1, content: 'Привет, как дела', _pendingAt: NOW - 5000 };

ok('тот же текст рядом по времени → заглушка подтверждена',
  E.matchesPending(pending, { id: 'real-1', content: 'Привет, как дела' }, NOW) === true);
// Время в сообщении форматируется локально и может отличаться на секунду —
// поэтому сравнивается нормализованный текст.
ok('разница в пробелах и переносах не мешает подтверждению',
  E.matchesPending(pending, { id: 'real-1', content: 'Привет,   как\nдела' }, NOW) === true);
ok('другая минута → это другое сообщение, не подтверждение',
  E.matchesPending(pending, { id: 'real-1', content: 'Совсем другой текст' }, NOW) === false);
ok('слишком старое → не подтверждается (иначе подтверждалось бы что угодно)',
  E.matchesPending({ ...pending, _pendingAt: NOW - 3600000 },
    { id: 'real-1', content: 'Привет, как дела' }, NOW) === false);
// Будущее время — это не «только что отправлено».
ok('временная метка в будущем → не подтверждается',
  E.matchesPending({ ...pending, _pendingAt: NOW + 60000 },
    { id: 'real-1', content: 'Привет, как дела' }, NOW) === false);
// НАСТОЯЩЕЕ письмо никогда не «подтверждает» само себя.
ok('сообщение без заглушки не участвует в сопоставлении',
  E.matchesPending({ id: 'msg-42', content: 'Привет' },
    { id: 'real-1', content: 'Привет' }, NOW) === false);
ok('и пустые значения не проходят как совпадение',
  E.matchesPending(null, null, NOW) === false && E.matchesPending({}, {}, NOW) === false);

// ── Гейт: префикс не похож на настоящий ────────────────────────────────
console.log('── гейт: старая привычка не вернулась ──');
const { execFileSync } = await import('node:child_process');
let offenders = [];
for (const f of ['src/features/attachments.js', 'src/features/send.js', 'src/features/forward.js']) {
  const body = readFileSync(path.join(ROOT, f), 'utf8');
  if (/'local-'/.test(body)) offenders.push(f + ' → префикс local-');
  // Ловим ТОЛЬКО заглушку идентификатора СООБЩЕНИЯ. Идентификаторы заметок
  // ('note-' + Date.now()…) живут в другом пространстве и к слиянию оптимистичных
  // сообщений отношения не имеют; первая версия гейта ругалась и на них, то
  // была ложной.
  for (const ln of body.split('\n')) {
    if (/\bid:/.test(ln) && /Date\.now/.test(ln) && !/'note-'/.test(ln)) {
      offenders.push(f + ' → заглушка id сообщения из Date.now(): ' + ln.trim().slice(0, 60));
    }
  }
  if (!body.includes('EnvelopeId.pendingIdOf') && !body.includes('envelopeId ||')) {
    // файл может не порождать заглушку вовсе — это нормально
  }
  if (!body.includes('EnvelopeId.envelopeIdOf') && /JSON\.parse\(envelope\)\.id/.test(body)) {
    offenders.push(f + ' → разбор конверта в обход envelopeIdOf');
  }
}
ok('префикс local- и id из Date.now() не вернулись', offenders.length === 0);
for (const o of offenders) console.log('      ↳ ' + o);

// Ни одного прямого разбора конверта ради id вне модуля.
let raw = [];
for (const f of ['src/features/attachments.js', 'src/features/send.js', 'src/features/forward.js',
                 'src/features/messages.js', 'src/features/groups.js', 'src/features/edits.js']) {
  const body = readFileSync(path.join(ROOT, f), 'utf8');
  if (/JSON\.parse\((envelope|env)\)\.id/.test(body)) raw.push(f);
}
ok('конверт ради id парсится только через envelopeIdOf', raw.length === 0);
for (const f of raw) console.log('      ↳ ' + f);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);