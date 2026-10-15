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

// ── parseMessageContent: вложения и DoD ──────────────────────────────
// DoD (download-on-demand) — данные НЕ в конверте, а во втором письме. Карточка
// рисуется сразу, содержимое тянется по клику. Отсюда правило: для DoD НЕЛЬЗЯ
// ставить isImage/isAudio/isText и textContent — иначе UI нарисует заглушку
// («имя файла») вместо картинки, которая уже скачана. Это регрессия a6204d6,
// и до переноса она была НЕ покрыта тестом вовсе: attachments-smoke проверяет
// загрузку и кэш DoD, но не распознавание. Перенос закрыл дыру.
const att = (o) => JSON.stringify(Object.assign({ vault_attachment: 1 }, o));
const dec = (b64) => Buffer.from(b64, 'base64').toString('binary');

// Обычная картинка: данных в конверте нет, но она НЕ DoD.
let p = M.parseMessageContent(att({ name: 'a.png', type: 'image/png', size: 100, data: dec('X') }));
ok('обычная картинка помечена isImage', p.attachment.isImage === true);
ok('обычная картинка не DoD', p.attachment.isDod === false && p.attachment.dod === '');

// DoD-картинка: те же mime и данные, но dod задан — ключевой случай a6204d6.
p = M.parseMessageContent(att({ name: 'b.png', type: 'image/png', size: 2048, dod: '<dod@x>' }));
ok('DoD-картинка НЕ помечается isImage (иначе UI рисует имя файла)',
  p.attachment.isImage === false);
ok('DoD-картинка не isAudio и не isText', !p.attachment.isAudio && !p.attachment.isText);
ok('textContent у DoD пуст даже для текстового типа',
  M.parseMessageContent(att({ name: 'c.txt', type: 'text/plain', size: 10, dod: '<d@x>' }))
    .attachment.textContent === '');
ok('ссылка на письмо сохранена', p.attachment.dod === '<dod@x>');
ok('статус загрузки idle на старте', p.attachment.dodStatus === 'idle');

// Явный dod: '' — это НЕ DoD (проверка длины, а не наличия поля).
p = M.parseMessageContent(att({ name: 'd.png', type: 'image/png', size: 1, data: dec('Y'), dod: '' }));
ok('пустой dod не считается DoD', p.attachment.isDod === false && p.attachment.isImage === true);

// Текстовый файл: инлайн, с обрезкой по 8000 символов.
const long = 'A'.repeat(9000);
p = M.parseMessageContent(att({ name: 'e.txt', type: 'text/plain', size: 9000,
  data: Buffer.from(long, 'utf8').toString('base64') }));
ok('текстовый файл распознан как isText', p.attachment.isText === true);
// Обрезка: slice(0, 8000) + '\n…' — это ДВА добавленных символа, итого 8002.
// Первый вариант проверял 8001 и падал: арифметика была моя, не код.
ok('длинный текст обрезан по 8000 + перенос и многоточие',
  p.attachment.textContent.length === 8002 && p.attachment.textContent.endsWith('\n…'));

// Аудио и метка с размером.
p = M.parseMessageContent(att({ name: 'v.ogg', type: 'audio/ogg', size: 51200, data: dec('Z') }));
ok('аудио помечено isAudio', p.attachment.isAudio === true);
ok('метка аудио с эмодзи 🎙️', p.text.startsWith('🎙️'));
p = M.parseMessageContent(att({ name: 'big.bin', type: 'application/octet-stream', size: 2048, data: dec('Q') }));
ok('прочий файл — метка с размером в КБ', p.text.includes('2.0KB'));

// Не-вложение и мусор.
ok('обычный текст остаётся текстом', M.parseMessageContent('просто текст').attachment === null);
ok('не-строка проходит насквозь', M.parseMessageContent(null).text === null);
ok('битый JSON не роняет разбор', M.parseMessageContent('{не json').text === '{не json');

// ── прочее ────────────────────────────────────────────────────────────
ok('imapCursorsKey собирает ключ', M.imapCursorsKey('fp:aa') === 'vault-imap-cursors-fp:aa');
const id1 = M.newMessageId();
ok('newMessageId непустой и строковый', typeof id1 === 'string' && id1.length > 0);
ok('newMessageId даёт разные значения', M.newMessageId() !== M.newMessageId());

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);