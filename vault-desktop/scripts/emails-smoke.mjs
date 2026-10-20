// Node-смоук features/emails.js — под-домен «загрузка писем» (ADR-001 домен 2).
// Мокаем api/db через подмену импортов (tmp-модули), без Vue/Tauri. Цель:
// застраховать ВЫНЕСЕННУЮ из App.vue логику loadEmails от регрессий:
// sqlite-restore, инкрементальный фетч, дедуп (uid+папка), кросс-папочное
// «оживление» по message_id, cap 2000, сортировка date desc, проброс
// «Not connected», persist. Downstream (processIncoming/processInvites/...)
// остаются в App.vue и замоканы как ctx-методы.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
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

prepareModuleCopy(
  ROOT + '/src/features/emails.js',
  MOCKS + '/emails.mjs',
  {
    '../api.js': 'api.js',
  },
  MOCKS,
);
const E = await import(MOCKS + '/emails.mjs');

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
// ADR-005 W2 (партия 10): список писем/флаги — у владельца mailbox-store
// (модуль берёт их сам), курсоры и downstream — эффекты в deps. Смоук берёт
// ТЕ ЖЕ синглтоны, что импортирует копия модуля, — иначе проверял бы не тот
// объект.
const { mailboxState } = await import(ROOT + '/src/features/mailbox-store.js');
const { sessionStore } = await import(ROOT + '/src/features/session-store.js');

function makeWorld(over = {}) {
  const calls = { incoming: [], invites: 0, avatars: 0, receipts: 0, saved: [], fetchedWith: [] };
  const w = Object.assign({
    email: 'me@x.ru',
    emails: [],
    emailsLoading: false,
    emailError: '',
    cursors: {},
  }, over);
  mailboxState.state.emails = w.emails;
  mailboxState.state.emailsLoading = false;
  mailboxState.state.emailError = '';
  sessionStore.setCurrentEmail(w.email);
  const deps = {
    // Курсоры — наблюдаемые: инкрементальный фетч обязан идти ПО ним.
    loadCursors: (id) => (w.cursors && w.cursors[id]) || {},
    saveCursors: (id, cursors) => { w.cursors = w.cursors || {}; w.cursors[id] = cursors; calls.saved.push([id, cursors]); },
    processIncoming: async (batch, opts) => { calls.incoming.push([batch.length, opts]); },
    processInvites: async () => { calls.invites++; },
    syncGroupAvatarsFromMeta: async () => { calls.avatars++; },
    sendDeliveredReceipts: async (batch) => { calls.receipts += (batch || []).length; },
  };
  return { w, deps, calls };
}
const mail = (uid, folder, mid, date) => ({ uid, id: uid, folder: folder || 'INBOX', message_id: mid || '', date: date || '2026-01-01T00:00:00Z' });

// ── 1. sqlite-restore при пустом emails (первый вызов сессии) ──
console.log('1. sqlite-restore при emails=[] и !silent');
{
  dbMock.stored = [{ uid: 5, from: 'a@x', to: 'me@x', subject: 'S', date: '2026-01-02T00:00:00Z', is_read: 1, folder: 'INBOX', message_id: '<m5@x>' }];
  apiMock.fetchPlan = { acc1: [{ messages: [], cursors: {} }] };
  const { w: ctx, deps, calls: _calls } = makeWorld();
  await E.loadEmails(deps, false);
  check('список восстановлен из sqlite (id=uid, message_id сохранён)',
    mailboxState.state.emails.length === 1 && mailboxState.state.emails[0].uid === 5 && mailboxState.state.emails[0].id === 5 && mailboxState.state.emails[0].message_id === '<m5@x>');
  check('persist: emailsSave вызван (аргумент acc1)', dbMock.savedCalls.length >= 1 && dbMock.savedCalls[0][0] === 'acc1');
  dbMock.stored = null;
}

// ── 2. инкрементальный фетч + дедуп по uid+папка ───────────────
console.log('2. инкрементальный фетч + дедуп (uid|folder)');
{
  // Третье письмо — ТОТ ЖЕ uid|folder, но ДРУГОЙ message_id: дедуп по
  // uid+папка обязан его отбросить. (Дубль с тем же message_id отбрасывался бы
  // и «оживлением» копии — дедуп по uid|folder не был бы виден.)
  apiMock.fetchPlan = { acc1: [{ messages: [mail(10, 'INBOX', '<a@x>', '2026-01-03T00:00:00Z'), mail(11, 'INBOX', '<b@x>', '2026-01-04T00:00:00Z'), mail(10, 'INBOX', '<other@x>', '2026-01-03T00:00:00Z')], cursors: { INBOX: 11 } }] };
  const { w: ctx, deps, calls: _calls } = makeWorld({ emails: [mail(10, 'INBOX', '<a@x>', '2026-01-03T00:00:00Z')] });
  await E.loadEmails(deps, true); // silent=true → restore пропущен
  check('новое письмо добавлено, дубль по uid|folder отброшен',
    mailboxState.state.emails.length === 2 && mailboxState.state.emails.some(m => m.uid === 11) && mailboxState.state.emails.filter(m => m.uid === 10).length === 1);
  check('курсоры сохранены (saveCursors с новыми курсорами)',
    _calls.saved.length === 1 && _calls.saved[0][1] && _calls.saved[0][1].INBOX === 11, _calls.saved);
  check('downstream: processIncoming получил fetched-батч (3 письма)', _calls.incoming[0][0] === 3, _calls.incoming);
  check('downstream: processInvites/avatars/receipts вызваны',
    _calls.invites === 1 && _calls.avatars === 1 && _calls.receipts === 3, _calls);
}

// ── 2b. Инкрементальность: фетч идёт ПО сохранённым курсорам ────────
console.log('2b. инкрементальный фетч идёт по сохранённым курсорам');
{
  let seenCursors = null;
  apiMock.fetchEmailsIncremental = async (id, cursors) => {
    seenCursors = cursors;
    return { messages: [], cursors: cursors || {} };
  };
  const { deps } = makeWorld({ emails: [], cursors: { acc1: { INBOX: 42 } } });
  await E.loadEmails(deps, true);
  check('фетч получил сохранённые курсоры (не сканирует всё подряд)',
    seenCursors && seenCursors.INBOX === 42, seenCursors);
  apiMock.fetchEmailsIncremental = async (id, c) => { const q = apiMock.fetchPlan[id]; return (q && q.length) ? q.shift() : { messages: [], cursors: c || {} }; };
}

// ── 3. кросс-папочное «оживление» по message_id ────────────────
console.log('3. кросс-папочная копия оживляется по message_id (без дубля)');
{
  // письмо было в INBOX (uid 20); пришла копия того же message_id из Spam (uid 99)
  apiMock.fetchPlan = { acc1: [{ messages: [mail(99, 'Spam', '<mv@x>', '2026-01-05T00:00:00Z')], cursors: {} }] };
  const { w: ctx, deps, calls: _calls } = makeWorld({ emails: [mail(20, 'INBOX', '<mv@x>', '2026-01-05T00:00:00Z')] });
  await E.loadEmails(deps, true);
  check('нет дубля: список остался 1 письмо', mailboxState.state.emails.length === 1);
  check('запись оживлена: folder=Spam, uid=99',
    mailboxState.state.emails[0].folder === 'Spam' && mailboxState.state.emails[0].uid === 99);
}

// ── 4. cap 2000 + сортировка date desc ─────────────────────────
console.log('4. cap 2000 + сортировка по date desc');
{
  const old = [];
  for (let i = 0; i < 2010; i++) old.push(mail(100000 + i, 'INBOX', '<o' + i + '@x>', '2020-01-01T00:00:00Z'));
  apiMock.fetchPlan = { acc1: [{ messages: [mail(1, 'INBOX', '<new@x>', '2030-01-01T00:00:00Z')], cursors: {} }] };
  const { w: ctx, deps, calls: _calls } = makeWorld({ emails: old });
  await E.loadEmails(deps, true);
  check('список ограничен 2000', mailboxState.state.emails.length === 2000);
  check('самое свежее письмо сверху (2030)', mailboxState.state.emails[0].date === '2030-01-01T00:00:00Z');
}

// ── 5. «Not connected» пробрасывается наверх ───────────────────
console.log('5. «Not connected» проброс наверх (silent=false → emailError)');
{
  const boom = new Error('Not connected');
  const { w: ctx, deps, calls: _calls } = makeWorld({ emails: [] });
  let threw = null;
  try { await E.loadEmails(deps, false).catch(e => { throw e; }); } catch (e) { threw = e; }
  check('пока нет ошибки — не бросает', threw === null);
  // теперь эмулируем throw из фетча
  apiMock.fetchEmailsIncremental = async () => { throw boom; };
  const { w: ctx2, deps: deps2, calls: _calls2 } = makeWorld({ emails: [] });
  let threw2 = null;
  try { await E.loadEmails(deps2, false); } catch (e) { threw2 = e; }
  check('«Not connected» проброшен вызывающему (re-login)', threw2 === boom);
  apiMock.fetchEmailsIncremental = async (id, c) => { const q = apiMock.fetchPlan[id]; return (q && q.length) ? q.shift() : { messages: [], cursors: c || {} }; };
}

// ── 6. Ошибка фетча (не «Not connected») → видима в UI ─────────────
console.log('6. ошибка фетча: emailError виден, индикатор загрузки снят');
{
  const orig = apiMock.fetchEmailsIncremental;
  apiMock.fetchEmailsIncremental = async () => { throw new Error('IMAP down'); };
  const { deps } = makeWorld({ emails: [] });
  let threw = null;
  try { await E.loadEmails(deps, false); } catch (e) { threw = e; }
  check('ошибка не пробрасывается (кроме «Not connected»)', threw === null, threw && String(threw));
  check('emailError показан в UI', /IMAP down/.test(mailboxState.state.emailError || ''), mailboxState.state.emailError);
  check('индикатор загрузки снят', mailboxState.state.emailsLoading === false, mailboxState.state.emailsLoading);
  apiMock.fetchEmailsIncremental = orig;
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
