// Smoke-тест mergeEmails — владелец почтового ящика (ADR-004, Этап J.2b).
// mergeEmails сливает входящие письма по ключу uid|folder: дубль заменяет,
// сортировка — по date desc. owner zero-import (без Vue/Tauri/ctx).
// Импорт из session-store.js, где createMailboxStore (J.2b) содержит
// state.emails + mergeEmails + body-cache.
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const { createMailboxStore } = await import(path.join(ROOT, 'src', 'features', 'session-store.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  \u2713', name); } else { fail++; console.log('  \u2717 ПРОВАЛ:', name); } };

console.log('\nADR-004 Этап J.2b · mergeEmails в mailbox-store\n');

// ── Изоляция сторов ────────────────────────────────────────────────
const a = createMailboxStore(), b = createMailboxStore();
ok('store независим — второй не видит первый',
  (a.setEmails([{ uid: 1 }]), b.state.emails.length === 0 && a.state.emails.length === 1));
ok('mergeEmails второго не видит первый', (b.mergeEmails([{ uid: 9 }]), a.state.emails.length === 1 && b.state.emails.length === 1));

// ── Ключ uid|folder, сортировка desc ──────────────────────────────
const m = createMailboxStore();
m.setEmails([
  { uid: 1, folder: 'INBOX', date: '2024-01-01T00:00:00Z' },
  { uid: 2, folder: 'Sent',  date: '2024-01-02T00:00:00Z' },
  { uid: 3, folder: 'INBOX', date: '2024-01-03T00:00:00Z' },
]);
ok('setEmails кладёт 3 письма', m.state.emails.length === 3);

// Дубль (uid 1|INBOX) — заменяется, а не удваивается:
m.mergeEmails([{ uid: 1, folder: 'INBOX', date: '2024-01-05T00:00:00Z', flags: ['\\Answered'] }]);
ok('mergeEmails: дубль (uid|folder) → не удваивается (осталось 3)', m.state.emails.length === 3);
ok('mergeEmails: дубль заменяет запись (uid 1 → Answered)',
  m.state.emails.find((e) => e.uid === 1 && e.folder === 'INBOX').flags?.includes('\\Answered'));

// Тот же uid, другой folder — отдельная запись:
m.mergeEmails([{ uid: 1, folder: 'Sent', date: '2024-01-04T00:00:00Z' }]);
ok('mergeEmails: uid 1 + Sent → отдельная запись (4)', m.state.emails.length === 4);

// folder по умолчанию INBOX:
m.mergeEmails([{ uid: 7, date: '2024-01-06T00:00:00Z' }]);
ok('mergeEmails: без folder → ключ INBOX (5 записей)', m.state.emails.length === 5);
ok('mergeEmails: без folder → uid 7 в списке', m.state.emails.some((e) => e.uid === 7));

// Сортировка по date desc (самое новое первым):
const order = m.state.emails.map((e) => e.uid);
ok('mergeEmails сортирует по date desc (самое новое первым)', order[0] === 7);

// Повторный merge того же uid|folder не дублирует:
m.mergeEmails([{ uid: 7, date: '2024-01-06T12:00:00Z' }]);
ok('mergeEmails: повторный uid 7|INBOX → не дублируется', m.state.emails.length === 5);

// ── Immutability / no-copy ─────────────────────────────────────────
const merged = m.mergeEmails([{ uid: 8, date: '2024-01-07T00:00:00Z' }]);
ok('mergeEmails возвращает state.emails (тот же массив)', merged === m.state.emails);
ok('mergeEmails не возвращает копию (=== state.emails)', merged !== [...merged]);

// ── Безопасность на пустом/плохих данных ─────────────────────────
const e = createMailboxStore();
ok('mergeEmails([]) — без изменений', (e.mergeEmails([]), e.state.emails.length === 0));
ok('mergeEmails(null) не падает', (e.mergeEmails(null), e.state.emails.length === 0));
ok('mergeEmails(undefined) не падает', (e.mergeEmails(undefined), e.state.emails.length === 0));
ok('mergeEmails([null, undefined, {}]) — не падает, пропускает null/undefined (1 запись)',
  (e.mergeEmails([null, undefined, {}]), e.state.emails.length === 1));

// ── clearEmails ─────────────────────────────────────────────────────
const ce = createMailboxStore();
ce.setEmails([{ uid: 1 }, { uid: 2 }]);
ce.clearEmails();
ok('clearEmails опустошает', ce.state.emails.length === 0);
ok('clearEmails возвращает пустой массив', ce.clearEmails().length === 0);

// ── cacheBody/getEmailBody/clearBodyCache ──────────────────────────
const c = createMailboxStore();
ok('getEmailBody absent → null', c.getEmailBody('k') === null);
c.cacheBody('k', { html: '<p>hi</p>' });
ok('cacheBody → getEmailBody вернул тело', c.getEmailBody('k').html === '<p>hi</p>');
c.clearBodyCache();
ok('clearBodyCache — кэш пуст', c.getEmailBody('k') === null);

console.log('\nИтого: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
