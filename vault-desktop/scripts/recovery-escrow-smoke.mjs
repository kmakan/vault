// Эскроу ключа восстановления (ADR-003 Этап 3, партия 15).
//
// Здесь проверяется одно и оно критично: СООБЩАТЬ ОБ УСПЕХЕ МОЖНО ТОЛЬКО
// УБЕДИВШИСЬ. Ошибка на этом пути означает, что человек останется без ключа
// восстановления и, возможно, без переписки — безвозвратно.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/recovery-escrow-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { sent: [], failSend: false, sendResult: { ok: true } };
globalThis.__st = state;
writeFileSync(MOCKS + '/api.js', `
const st = globalThis.__st;
const api = {
  sendEmail: async (accountId, data) => {
    st.sent.push({ accountId, data });
    if (st.failSend) throw new Error('SMTP send failed: refused');
    return st.sendResult;
  },
};
export { api };
export default api;
`);
writeFileSync(MOCKS + '/crypto.js', `
const st = globalThis.__st;
export default {
  recoveryWrapBackup: async (mnemonic) => 'WRAPPED[' + mnemonic + ']',
  recoveryBuildEscrowEmail: async (wrapped) => 'BODY<' + wrapped + '>',
};
`);

let src = readFileSync(path.join(ROOT, 'src', 'features', 'recovery-escrow.js'), 'utf8');
src = src.replace("from '../api.js'", `from "${MOCKS}/api.js"`);
src = src.replace("from '../crypto.js'", `from "${MOCKS}/crypto.js"`);
writeFileSync(MOCKS + '/re.mjs', src, 'utf8');
const R = await import(MOCKS + '/re.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => {
  state.sent = []; state.failSend = false;
  state.sendResult = { ok: true };
};

console.log('\nADR-003 Этап 3, партия 15 · эскроу ключа восстановления');

// ── Успешный путь ──────────────────────────────────────────────────────
reset();
let r = await R.sendEscrowEmail('me@bk.ru', 'слово1 слово2 слово3', 'recovery_spam_toast');
ok('письмо отправлено себе', state.sent[0].accountId === 'me@bk.ru' && state.sent[0].data.to === 'me@bk.ru');
ok('тема пустая — сигнальное письмо, не похожее на обычное', state.sent[0].data.subject === '');
ok('тело собрано из обёрнутого ключа',
  state.sent[0].data.body === 'BODY<WRAPPED[слово1 слово2 слово3]>');
ok('ключ тоста возвращается, а не текст — переводчик живёт в компоненте',
  r.spamToastKey === 'recovery_spam_toast');
ok('обёрнутый ключ возвращён для последующего locateEscrow',
  r.wrappedJson === 'WRAPPED[слово1 слово2 слово3]');

// ── ОТКАЗ SMTP ─────────────────────────────────────────────────────────
reset();
state.failSend = true;
let threw = false, msg = '';
try { await R.sendEscrowEmail('me@bk.ru', 'мнемоника', 'k'); } catch (e) { threw = true; msg = String(e.message || e); }
ok('отказ SMTP → исключение, не «успех»', threw === true);
ok('причина не потеряна', msg.includes('SMTP'));

// ── РЕЗУЛЬТАТ, КОТОРЫЙ НЕ ok:true ──────────────────────────────────────
// ГЛАВНОЕ. Проверка раньше была `if (res && res.ok === false)`. При Result<bool,
// String> из Rust отказ приходит как бросок, а Ok бывает только true — то есть
// условие было НЕДОСТИЖИМЫМ. Сейчас успех требует ok === true, и всё остальное
// считается отказом.
for (const [label, result] of [
  ['ok: false', { ok: false }],
  ['пустой объект', {}],
  ['ok: undefined', { ok: undefined }],
  ['ok: 1 (не boolean)', { ok: 1 }],
  ['null', null],
  ['undefined', undefined],
]) {
  reset();
  state.sendResult = result;
  threw = false;
  try { await R.sendEscrowEmail('me@bk.ru', 'мнемоника', 'k'); } catch (e) { threw = true; }
  ok('результат «' + label + '» → НЕ объявляется успехом', threw === true);
}

// Ложное срабатывание: настоящий успех не должен быть отказом.
reset();
state.sendResult = { ok: true };
threw = false;
try { await R.sendEscrowEmail('me@bk.ru', 'мнемоника', 'k'); } catch (e) { threw = true; }
ok('а настоящий ok:true проходит, проверка не пережата', threw === false);

// ── Ключ тоста существует во всех локалях ───────────────────────────────
// Ключ recovery_spam_toast был заведён в ru/en/zh и НЕ читался ни разу — вместо
// него в коде лежал русский текст. Проверка не даст этому вернуться.
console.log('── гейт: ключ тоста эскроу существует во всех локалях ──');
for (const loc of ['ru', 'en', 'zh']) {
  const body = readFileSync(path.join(ROOT, 'src', 'locales', loc + '.js'), 'utf8');
  ok(loc + '.js определяет recovery_spam_toast', /recovery_spam_toast:\s*'[^']+'/.test(body));
  ok(loc + '.js определяет recovery_escrow_failed', /recovery_escrow_failed:\s*'[^']+'/.test(body));
}

// ── Поток поиска эскроу-письма (ADR-005 W3, партия 12) ─────────────────
// Ключевое: эскроу лежит в спаме, и провайдер его удаляет. Поэтому поиск
// повторяется, а найденное письмо копируется во «Входящие».
console.log('\nПоток поиска эскроу-письма (locateEscrowFlow)');
{
  const LOCAL = JSON.stringify({ salt: 'S', nonce: 'N', wrapped: 'W' });
  const MINE = JSON.stringify({ salt: 'S', nonce: 'N', wrapped: 'W' });
  const OTHER = JSON.stringify({ salt: 'S2', nonce: 'N2', wrapped: 'W2' });
  const calls = [];
  const deps = (over = {}) => ({
    email: () => 'me@bk.ru',
    fetchEmails: async () => ([
      { uid: 'u1', folder: 'INBOX', subject: '' },
      { uid: 'u2', folder: 'Spam', subject: '' },
      { uid: 'u3', folder: 'INBOX', subject: 'обычное письмо' },
    ]),
    fetchBodies: async (uids, folder) => {
      calls.push(['fetchBodies', folder, uids.join(',')]);
      if (folder === 'Spam') return [['u2', 'ESCROW:' + MINE]];
      return [['u1', 'ESCROW:' + OTHER]];
    },
    parseEscrowEmail: async (body) => {
      const m = /^ESCROW:(.*)$/.exec(body || '');
      return m ? m[1] : null;
    },
    copyToInbox: async (uid, folder) => { calls.push(['copyToInbox', uid, folder]); },
    toast: (msg, ms) => calls.push(['toast', msg, ms]),
    t: (k) => 'T:' + k,
    warn: (...a) => calls.push(['warn', String(a[0])]),
    sleep: async () => {},
    attempts: 4,
    delayMs: 0,
    ...over,
  });
  // 1. Найдено в INBOX → предупреждение «не удаляйте», копирования нет.
  calls.length = 0;
  let found = await R.locateEscrowFlow(deps({
    fetchBodies: async (uids, folder) => (folder === 'INBOX'
      ? [['u1', 'ESCROW:' + MINE]] : []),
  }), LOCAL);
  ok('поток: найдено в INBOX', found === true);
  ok('поток: в INBOX копирования нет', !calls.some((c) => c[0] === 'copyToInbox'), calls);
  ok('поток: в INBOX — предупреждение «не удаляйте»',
    calls.some((c) => c[0] === 'toast' && c[1] === 'T:recovery_keep'), calls);

  // 2. Найдено в спаме → копируем в INBOX (иначе провайдер удалит).
  calls.length = 0;
  found = await R.locateEscrowFlow(deps(), LOCAL);
  ok('поток: найдено в спаме', found === true);
  ok('поток: письмо скопировано во INBOX', calls.some((c) => c[0] === 'copyToInbox'), calls);
  ok('поток: копируется ИМЕННО найденное письмо (uid из пары тела)',
    calls.some((c) => c[0] === 'copyToInbox' && c[1] === 'u2'), calls);
  ok('поток: после копирования — предупреждение «переложено»',
    calls.some((c) => c[0] === 'toast' && c[1] === 'T:recovery_moved_toast'), calls);

  // 3. Не найдено → поиск ПОВТОРЯЕТСЯ (письмо могло прийти позже).
  calls.length = 0;
  let attemptsSeen = 0;
  found = await R.locateEscrowFlow(deps({
    fetchBodies: async () => [],
    fetchEmails: async () => { attemptsSeen++; return []; },
  }), LOCAL);
  ok('поток: не найдено → поиск повторён', attemptsSeen > 1, attemptsSeen);
  ok('поток: попыток не больше лимита', attemptsSeen <= 4, attemptsSeen);
  ok('поток: не найдено — false', found === false);

  // 4. Битый wrappedJson → тихо, без повторов.
  calls.length = 0;
  attemptsSeen = 0;
  found = await R.locateEscrowFlow(deps({
    fetchEmails: async () => { attemptsSeen++; return []; },
  }), '{битый json');
  ok('поток: битый wrapped → выход без обращения к ящику', attemptsSeen === 0, attemptsSeen);

  // 5. Совпадение только по salt — НЕ наше письмо: сверка идёт по всем трём
  // полям (salt+nonce+wrapped), иначе обрезанное письмо сошлось бы за наше.
  calls.length = 0;
  found = await R.locateEscrowFlow(deps({
    fetchBodies: async () => [['u1', 'ESCROW:' + JSON.stringify({ salt: 'S', nonce: 'ДРУГОЙ', wrapped: 'W' })]],
  }), LOCAL);
  ok('поток: совпадение только по salt — не наше письмо', found === false, calls);

  // 6. Копирование не вышло → просим переложить вручную.
  calls.length = 0;
  found = await R.locateEscrowFlow(deps({
    copyToInbox: async () => { throw new Error('нет команды'); },
  }), LOCAL);
  ok('поток: при отказе копирования — просьба переложить вручную',
    calls.some((c) => c[0] === 'toast' && String(c[1]).includes('T:recovery_spam_folder')), calls);
}

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);