// Жалоба на контент: сборка письма (ADR-003 Этап 3, партия 12).
//
// Письмо уходит с устройства, поэтому проверяется не «красиво ли», а три
// свойства, которые при переносе теряются тихо: тройной фолбэк времени,
// пропуск пустого типа жалобы и подстановка прочерка вместо 'undefined'.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/report-content-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
writeFileSync(MOCKS + '/rc.mjs', readFileSync(path.join(ROOT, 'src', 'features', 'report-content.js'), 'utf8'));
const R = await import(MOCKS + '/rc.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };

// Переводчик, у которого часть ключей неизвестна — как настоящий t().
const t = (k) => ({ report_content_type: 'Тип жалобы', report_content_time: 'Время' }[k]);

console.log('\nADR-003 Этап 3, партия 12 · жалоба на контент');

// ── Время: три поля подряд, эволюция хранилища ─────────────────────────
ok('msg.time — приоритет первое', R.messageTimeOf({ time: '10:00' }) === '10:00');
ok('нет time → created_at', R.messageTimeOf({ created_at: '11:00' }) === '11:00');
ok('нет первых двух → date', R.messageTimeOf({ date: '12:00' }) === '12:00');
ok('все три: побеждает ПЕРВОЕ, не последнее',
  R.messageTimeOf({ time: 'A', created_at: 'B', date: 'C' }) === 'A');
ok('ничего нет → прочерк', R.messageTimeOf({}) === '-');
ok('пустая строка — это пусто, идём дальше',
  R.messageTimeOf({ time: '', created_at: 'B' }) === 'B');
// Проверка, которая сначала у меня была неверной: я написал «нулевое время 0
// не пустое» и упал. Код тут прав, а требование было выдумано. `0` ложно, и
// цепочка || уходит дальше — а для сообщения с нулевым временем прочерк
// ЧЕСТНЕЕ, чем 01.01.1970 в жалобе в поддержку. Приоритет здесь не в том, что
// 0 передаётся как есть, а в том, что «время неизвестно» не выглядит как
// настоящее время. Поведение оригинала сохранено.
ok('time = 0 ложно → прочерк (не 01.01.1970 в жалобе)',
  R.messageTimeOf({ time: 0 }) === '-');
ok('и 0 в created_at тоже', R.messageTimeOf({ created_at: 0 }) === '-');

// ── Строки жалобы ──────────────────────────────────────────────────────
let lines = R.buildReportLines(
  { type: 'спам', msg: { time: '10:00', id: 'm-7' }, sender: 'a@b.ru' }, t);
ok('четыре строки в фиксированном порядке', lines.length === 4);
ok('известный ключ берётся', lines[0] === 'Тип жалобы: спам');
ok('неизвестный ключ падает на русский запасной',
  lines[1] === 'Email отправителя: a@b.ru');
ok('время подставлено', lines[2] === 'Время: 10:00');
ok('идентификатор подставлен', lines[3] === 'ID сообщения: m-7');

// Пустой тип: пользователь нажал Enter, не введя ничего.
lines = R.buildReportLines({ type: '  ', msg: {}, sender: '-' }, t);
ok('пустой тип жалобы → прочерк, а не хвост пробелов', lines[0].endsWith(': -'));
ok('отсутствующий id → прочерк, а не "undefined"',
  lines[3] === 'ID сообщения: -' && !lines[3].includes('undefined'));
ok('время при отсутствии полей → прочерк', lines[2] === 'Время: -');

// Переводчик, вернувший пустую строку, — не то же самое, что вернувший ключ.
lines = R.buildReportLines({ type: 'x', msg: {}, sender: '-' }, () => '');
ok('переводчик вернул пустое → запасной текст, а не пустая строка',
  lines[0] === 'Тип: x');

// ── mailto ─────────────────────────────────────────────────────────────
const url = R.buildReportMailto('Жалоба на контент', lines);
ok('адрес поддержки зашит и не подменён', url.startsWith('mailto:support@vault-msg.ru?'));
ok('тема в subject', url.includes('subject=' + encodeURIComponent('Жалоба на контент')));
ok('текст в body, переносы строк закодированы',
  url.includes('body=' + encodeURIComponent(lines.join('\n'))));
ok('тема отделена от тела знаком &', url.includes('&body='));

// Кириллица и спецсимволы в теме не должны развалить ссылку.
const tricky = R.buildReportMailto('Жалоба: 100% & more #1', ['строка']);
ok('спецсимволы в теме экранированы',
  tricky.includes(encodeURIComponent('Жалоба: 100% & more #1')));
ok('и в сырой ссылке нет неэкранированных & из темы',
  (tricky.match(/&/g) || []).length === 1);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);