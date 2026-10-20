// Smoke-тест для mailbox-store.js (ADR-004, Этап J.3c).
// owner emails-loading state: emailsLoading/emailError. zero-import, no-ctx.
import { readFileSync } from 'node:fs';
import path from 'node:path';
const MODULE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'features', 'mailbox-store.js');
const src = readFileSync(MODULE_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  \u2713 ' + name); } else { fail++; console.log('  \u2717 ' + name); } }

console.log('\nADR-004 J.3c · модуль-владелец emails-loading state');

// 1. Zero-import gate
check('нет импортов — модуль не зависит ни от чего',
  !/^\s*import\s/m.test(src) && !/^\s*require\s*\(/m.test(src));

// 2. No-ctx gate
const body = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('нет доступа к ctx', !/\bctx\b/.test(body));

// 3. State starts clean
const { createMailboxStore } = await import('file://' + MODULE_PATH);
const ms = createMailboxStore();
check('emailsLoading стартует false', ms.state.emailsLoading === false);
check('emailError стартует пустой', ms.state.emailError === '');

// 4. setters
ms.setEmailsLoading(true);
check('setEmailsLoading пишет', ms.state.emailsLoading === true);
ms.setEmailError('fetch: nope');
check('setEmailError пишет', ms.state.emailError === 'fetch: nope');
check('setEmailsLoading(true) возвращает', ms.setEmailsLoading(true));

// 5. reset
ms.reset();
check('reset чистит', ms.state.emailsLoading === false && ms.state.emailError === '');

// 6. Письма: setEmails / emailCount / clearEmails
const ms2 = createMailboxStore();
check('старт: писем нет', ms2.state.emails.length === 0 && ms2.emailCount() === 0);
ms2.setEmails([{ uid: 'a', folder: 'INBOX' }, { uid: 'b', folder: 'INBOX' }]);
check('setEmails пишет список', ms2.state.emails.length === 2);
check('emailCount считает письма', ms2.emailCount() === 2, ms2.emailCount());
check('setEmails ЗАМЕНЯЕТ список (а не дописывает)', (ms2.setEmails([{ uid: 'c' }]), ms2.state.emails.length === 1));
check('setEmails(undefined) → пустой список', (ms2.setEmails(undefined), ms2.state.emails.length === 0));
ms2.setEmails([{ uid: 'x' }]);
check('clearEmails чистит', (ms2.clearEmails(), ms2.state.emails.length === 0 && ms2.emailCount() === 0));

// 7. mergeEmails: дедуп по uid+папка, новое перекрывает старое, сортировка по дате
const ms3 = createMailboxStore();
ms3.setEmails([
  { uid: '1', folder: 'INBOX', date: '2026-01-01T00:00:00Z', body: 'старое' },
  { uid: '2', folder: 'INBOX', date: '2026-02-01T00:00:00Z', body: 'среднее' },
]);
ms3.mergeEmails([
  { uid: '1', folder: 'INBOX', date: '2026-01-01T00:00:00Z', body: 'новое' },
  { uid: '1', folder: 'Sent', date: '2026-01-01T00:00:00Z', body: 'другая папка' },
]);
// Ключ дедупа — uid+папка: то же письмо в другой папке — ОТДЕЛЬНАЯ запись.
// Ключ дедупа — uid+папка: то же письмо в ДРУГОЙ папке — отдельная запись.
check('mergeEmails: то же uid в другой папке — отдельная запись (3)', ms3.state.emails.length === 3, ms3.state.emails.map((e) => e.folder + ':' + e.uid));
check('mergeEmails: новое перекрывает старое по ключу',
  ms3.state.emails.some((e) => e.folder === 'INBOX' && e.body === 'новое'), ms3.state.emails.map((e) => e.body));
check('mergeEmails: то же письмо в ДРУГОЙ папке — отдельное',
  ms3.state.emails.some((e) => e.folder === 'Sent'), ms3.state.emails.map((e) => e.folder));
check('mergeEmails: сортировка по дате (новые первыми)',
  ms3.state.emails[0].date >= ms3.state.emails[1].date, ms3.state.emails.map((e) => e.date));
check('mergeEmails: повтор того же uid+папка не размножает',
  (ms3.mergeEmails([{ uid: '1', folder: 'INBOX', date: '2026-01-01T00:00:00Z', body: 'ещё раз' }]), ms3.state.emails.length === 3), ms3.state.emails.map((e) => e.body));
check('mergeEmails: последнее значение по ключу выигрывает',
  ms3.state.emails.some((e) => e.folder === 'INBOX' && e.body === 'ещё раз'), ms3.state.emails.map((e) => e.body));
check('mergeEmails: null-элементы пропускаются', (ms3.mergeEmails([null, undefined]), ms3.state.emails.length === 3));

// 8. Кэш тел писем
const ms4 = createMailboxStore();
check('getEmailBody: неизвестный ключ → null', ms4.getEmailBody('k') === null);
ms4.cacheBody('k', 'тело');
check('cacheBody/getEmailBody: тело сохранено', ms4.getEmailBody('k') === 'тело');
ms4.cacheBody('k2', 'тело2');
check('cacheBody: два ключа независимы', ms4.getEmailBody('k') === 'тело' && ms4.getEmailBody('k2') === 'тело2');
ms4.clearBodyCache();
check('clearBodyCache: кэш пуст', ms4.getEmailBody('k') === null && Object.keys(ms4.state.emailBodyCache).length === 0);

// 9. Каналы (списки рассылки)
const ms5 = createMailboxStore();
check('setChannels пишет список', (ms5.setChannels([{ id: 'ch1' }]), ms5.state.channels.length === 1));
check('setChannels(undefined) → пусто', (ms5.setChannels(undefined), ms5.state.channels.length === 0));

// 10. hardReset: полная очистка (в отличие от reset — только индикаторы)
const ms6 = createMailboxStore();
ms6.setEmails([{ uid: 'a' }]);
ms6.cacheBody('k', 'b');
ms6.setChannels([{ id: 'ch' }]);
ms6.setEmailsLoading(true);
ms6.hardReset();
check('hardReset: письма очищены', ms6.state.emails.length === 0);
check('hardReset: кэш тел очищен', Object.keys(ms6.state.emailBodyCache).length === 0);
check('hardReset: каналы очищены', ms6.state.channels.length === 0);
check('hardReset: индикатор загрузки сброшен', ms6.state.emailsLoading === false);
check('reset НЕ трогает письма (только индикаторы)',
  (ms6.setEmails([{ uid: 'z' }]), ms6.reset(), ms6.state.emails.length === 1));

console.log('\nИтого: ' + pass + ' pass, ' + fail + ' fail');
if (fail) { console.error('FAIL'); process.exit(1); }
