// Смоук чистых функций формата/разбора сообщений (ADR-003 Этап 3).
//
// Зачем. Эти 7 функций годами жили методами App.vue и НЕ имели тестов: их
// некому было тестировать отдельно, пока они были методами компонента. После
// переноса они стали обычными функциями — и покрылись за минуту. Это отдельный
// довод за перенос: тестируемость была недостижима не из-за сложности кода, а
// из-за того, где он лежал.
//
// Проверяем не «вызывается», а СОДЕРЖАНИЕ: разбор конверта, отсечение цитаты,
// автолинковка с приоритетом телефонов, экранирование HTML. Именно здесь
// опечатка в регулярке выглядит как обычный код и проходит ревью глазом.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/message-format-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// message-format.js не имеет импортов — копия идёт как есть, подменять нечего.
writeFileSync(MOCKS + '/message-format.mjs', readFileSync(ROOT + '/src/message-format.js', 'utf8'));
const M = await import(MOCKS + '/message-format.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };

console.log('\nADR-003 Этап 3 · чистые функции формата сообщений');

// ── parseEnvelope ─────────────────────────────────────────────────────
const env = M.parseEnvelope(JSON.stringify({
  vault: 1, id: 'm1', text: 'привет', name: 'Аня', ts: 1700000000, ttl: 60,
  poll: { id: 'p1', question: '?', options: ['a', 'b'] },
}));
ok('конверт разобран', env && env.id === 'm1' && env.text === 'привет');
ok('ttl приведён к числу', env.ttl === 60);
ok('poll-подконверт поднят', !!(env.poll && env.poll.options.length === 2));
ok('не-конверт → null', M.parseEnvelope('просто текст') === null);
ok('мусор → null (без исключения)', M.parseEnvelope('{не json') === null);
ok('null → null', M.parseEnvelope(null) === null);
ok('vault без text → null', M.parseEnvelope(JSON.stringify({ vault: 1, id: 'x' })) === null);

// ── splitReply ────────────────────────────────────────────────────────
const r1 = M.splitReply('> цитата\n> вторая\nновый текст');
ok('цитата отделена от тела', r1.quote === 'цитата\nвторая' && r1.body === 'новый текст');
const r2 = M.splitReply('без цитаты');
ok('без цитаты body = весь текст', r2.quote === '' && r2.body === 'без цитаты');
const r3 = M.splitReply('> только цитата');
ok('цитата без тела', r3.quote === 'только цитата' && r3.body === '');
const r4 = M.splitReply('> q\n\n\nтело');
ok('пустые строки-разделители пропущены', r4.quote === 'q' && r4.body === 'тело');
ok('пустая строка → {quote:""}', M.splitReply('').quote === '');

// ── linkify ───────────────────────────────────────────────────────────
const l1 = M.linkify('пиши на +7 (999) 123 45 67');
ok('телефон стал tel:-ссылкой', l1.includes('href="tel:+7 (999) 123 45 67"'));
// Смысл проверки: во входе есть только телефон, поэтому ни одной http-ссылки
// появляться не должно — если бы телефон съела URL-регулярка, вышел бы
// мусорный href. Двойных отрицаний здесь намеренно нет: они проверяют
// ничего и выглядят как осмысленная проверка.
ok('телефон не превращён в http-ссылку', l1.includes('href="tel:') && !l1.includes('href="http'));
const l2 = M.linkify('вот https://example.com/a?b=1 конец');
ok('URL стал ссылкой', l2.includes('href="https://example.com/a?b=1"'));
const l3 = M.linkify('<script>alert(1)</script>');
ok('HTML экранирован', l3.includes('&lt;script&gt;') && !l3.includes('<script>'));
ok('экранирование не ломает одинарные кавычки', M.linkify("a'b").includes('&#39;'));
// Регрессия, ради которой порядок замен важен: телефон содержит цифры и
// пробелы, и без плейсхолдера его съела бы URL-регулярка.
ok('телефон рядом с URL не смешивается',
  M.linkify('+7 999 123 45 67 и https://ex.com').includes('tel:+7 999 123 45 67')
  && M.linkify('+7 999 123 45 67 и https://ex.com').includes('https://ex.com'));

// ── senderEmail ───────────────────────────────────────────────────────
ok('<a@b.c> → адрес', M.senderEmail('Аня <A@B.C>') === 'a@b.c');
ok('без скобок → как есть, в нижний регистр', M.senderEmail('A@B.C') === 'a@b.c');
ok('пусто → пусто', M.senderEmail(null) === '');

// ── isTextMime ────────────────────────────────────────────────────────
ok('text/plain → текст', M.isTextMime('text/plain', 'a.bin') === true);
ok('application/json → текст', M.isTextMime('application/json', 'a.bin') === true);
ok('по расширению .rs → текст', M.isTextMime('', 'main.rs') === true);
ok('по расширению .png → не текст', M.isTextMime('image/png', 'a.png') === false);
ok('application/octet-stream → не текст', M.isTextMime('application/octet-stream', 'x') === false);

// ── прочее ────────────────────────────────────────────────────────────
ok('imapCursorsKey собирает ключ', M.imapCursorsKey('fp:aa') === 'vault-imap-cursors-fp:aa');
const id1 = M.newMessageId();
ok('newMessageId непустой и строковый', typeof id1 === 'string' && id1.length > 0);
ok('newMessageId даёт разные значения', M.newMessageId() !== M.newMessageId());

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);