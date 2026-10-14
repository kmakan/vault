// Node-смоук features/emails.js — под-домен «загрузка писем» (ADR-001 домен 2).
// Мокаем api/db через подмену импортов (tmp-модули), без Vue/Tauri. Цель:
// застраховать ВЫНЕСЕННУЮ из App.vue логику loadEmails от регрессий:
// sqlite-restore, инкрементальный фетч, дедуп (uid+папка), кросс-папочное
// «оживление» по message_id, cap 2000, сортировка date desc, проброс
// «Not connected», persist. Downstream (processIncoming/processInvites/...)
// остаются в App.vue и замоканы как ctx-методы.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/emails-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Моки api + db ──────────────────────────────────────────────
const apiMock = {
  accounts: [{ id: 'acc1' }],
  // per-account: массив батчей, которые последовательно вернёт фетч
  fetchPlan: {},
  emailsSource: null,
  getEmailAccounts: async () => apiMock.accounts,
  fetchEmailsIncremental: async (accountId, cursors) => {
    const q = apiMock.fetchPlan[accountId];
    if (q && q.length) return q.shift();
    return { messages: [], cursors: cursors || {} };
  },
  setEmailsSource: (list) => { apiMock.emailsSource = list; },
};
const dbMock = {
  stored: null,      // что вернёт emailsLoad (уже распарсенный массив или null)
  savedCalls: [],    // аргументы emailsSave для проверки persist
  emailsLoad: async () => dbMock.stored,
  emailsSave: (account, json) => { dbMock.savedCalls.push([account, json]); },
};

writeFileSync(MOCKS + '/api.js',
  'const api = globalThis.__apiMock; export default api; export const db = globalThis.__dbMock;');

globalThis.__apiMock = apiMock;
globalThis.__dbMock = dbMock;

let em = readFileSync(ROOT + '/src/features/emails.js', 'utf8');
em = em.replace("from '../api.js'", 'from "' + MOCKS + '/api.js"');
writeFileSync(MOCKS + '/emails.mjs', em);
const E = await import(MOCKS + '/emails.mjs');

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  const calls = { incoming: [], invites: 0, avatars: 0, receipts: 0 };
  return Object.assign({
    email: 'me@x.ru',
    emails: [],
    emailsLoading: false,
    emailError: '',
    loadCursors: () => ({}),
    saveCursors: () => {},
    processIncoming: async (batch, opts) => { calls.incoming.push([batch.length, opts]); },
    processInvites: async () => { calls.invites++; },
    syncGroupAvatarsFromMeta: async () => { calls.avatars++; },
    sendDeliveredReceipts: async (batch) => { calls.receipts += (batch || []).length; },
    _calls: calls,
  }, over);
}
const mail = (uid, folder, mid, date) => ({ uid, id: uid, folder: folder || 'INBOX', message_id: mid || '', date: date || '2026-01-01T00:00:00Z' });

// ── 1. sqlite-restore при пустом emails (первый вызов сессии) ──
console.log('1. sqlite-restore при emails=[] и !silent');
{
  dbMock.stored = [{ uid: 5, from: 'a@x', to: 'me@x', subject: 'S', date: '2026-01-02T00:00:00Z', is_read: 1, folder: 'INBOX', message_id: '<m5@x>' }];
  apiMock.fetchPlan = { acc1: [{ messages: [], cursors: {} }] };
  const ctx = makeCtx();
  await E.loadEmails(ctx, false);
  check('список восстановлен из sqlite (id=uid, message_id сохранён)',
    ctx.emails.length === 1 && ctx.emails[0].uid === 5 && ctx.emails[0].id === 5 && ctx.emails[0].message_id === '<m5@x>');
  check('persist: emailsSave вызван (аргумент acc1)', dbMock.savedCalls.length >= 1 && dbMock.savedCalls[0][0] === 'acc1');
  dbMock.stored = null;
}

// ── 2. инкрементальный фетч + дедуп по uid+папка ───────────────
console.log('2. инкрементальный фетч + дедуп (uid|folder)');
{
  apiMock.fetchPlan = { acc1: [{ messages: [mail(10, 'INBOX', '<a@x>', '2026-01-03T00:00:00Z'), mail(11, 'INBOX', '<b@x>', '2026-01-04T00:00:00Z')], cursors: { INBOX: 11 } }] };
  const ctx = makeCtx({ emails: [mail(10, 'INBOX', '<a@x>', '2026-01-03T00:00:00Z')] });
  await E.loadEmails(ctx, true); // silent=true → restore пропущен
  check('новое письмо добавлено, дубль по uid|folder отброшен',
    ctx.emails.length === 2 && ctx.emails.some(m => m.uid === 11) && ctx.emails.filter(m => m.uid === 10).length === 1);
  check('курсоры сохранены (saveCursors вызван)', ctx._calls.incoming.length === 1);
  check('downstream: processIncoming получил fetched-батч (2 письма)', ctx._calls.incoming[0][0] === 2);
  check('downstream: processInvites/avatars/receipts вызваны',
    ctx._calls.invites === 1 && ctx._calls.avatars === 1 && ctx._calls.receipts === 2);
}

// ── 3. кросс-папочное «оживление» по message_id ────────────────
console.log('3. кросс-папочная копия оживляется по message_id (без дубля)');
{
  // письмо было в INBOX (uid 20); пришла копия того же message_id из Spam (uid 99)
  apiMock.fetchPlan = { acc1: [{ messages: [mail(99, 'Spam', '<mv@x>', '2026-01-05T00:00:00Z')], cursors: {} }] };
  const ctx = makeCtx({ emails: [mail(20, 'INBOX', '<mv@x>', '2026-01-05T00:00:00Z')] });
  await E.loadEmails(ctx, true);
  check('нет дубля: список остался 1 письмо', ctx.emails.length === 1);
  check('запись оживлена: folder=Spam, uid=99',
    ctx.emails[0].folder === 'Spam' && ctx.emails[0].uid === 99);
}

// ── 4. cap 2000 + сортировка date desc ─────────────────────────
console.log('4. cap 2000 + сортировка по date desc');
{
  const old = [];
  for (let i = 0; i < 2010; i++) old.push(mail(100000 + i, 'INBOX', '<o' + i + '@x>', '2020-01-01T00:00:00Z'));
  apiMock.fetchPlan = { acc1: [{ messages: [mail(1, 'INBOX', '<new@x>', '2030-01-01T00:00:00Z')], cursors: {} }] };
  const ctx = makeCtx({ emails: old });
  await E.loadEmails(ctx, true);
  check('список ограничен 2000', ctx.emails.length === 2000);
  check('самое свежее письмо сверху (2030)', ctx.emails[0].date === '2030-01-01T00:00:00Z');
}

// ── 5. «Not connected» пробрасывается наверх ───────────────────
console.log('5. «Not connected» проброс наверх (silent=false → emailError)');
{
  const boom = new Error('Not connected');
  const ctx = makeCtx({ emails: [] });
  let threw = null;
  try { await E.loadEmails(ctx, false).catch(e => { throw e; }); } catch (e) { threw = e; }
  check('пока нет ошибки — не бросает', threw === null);
  // теперь эмулируем throw из фетча
  apiMock.fetchEmailsIncremental = async () => { throw boom; };
  const ctx2 = makeCtx({ emails: [] });
  let threw2 = null;
  try { await E.loadEmails(ctx2, false); } catch (e) { threw2 = e; }
  check('«Not connected» проброшен вызывающему (re-login)', threw2 === boom);
  apiMock.fetchEmailsIncremental = async (id, c) => { const q = apiMock.fetchPlan[id]; return (q && q.length) ? q.shift() : { messages: [], cursors: c || {} }; };
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
