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

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);