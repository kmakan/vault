// Node-смоук features/recovery.js — устойчивость поиска эскроу (fix/
// recovery-resilience). Паттерн incoming-smoke/edits-smoke: без Vue/Tauri,
// зависимости модуля инъектируются явно { api, crypto, invoke }, поэтому
// импорт recovery.js делается НАПРЯМУЮ (не копия алгоритма). Все mnemonic/
// body/backup/UID — искусственные; файлов пользователя и сети нет.
//
// RED: до фикса App.vue в теле recoverFromEscrow лежит старый алгоритм
// (parse/unwrap БЕЗ try/catch). Загружаем его тело через AsyncFunction и
// доказываем, что чужое/битое эскроу ПЕРЕД правильным обрывает весь поиск.
// После фикса App.vue — тонкий делегат, RED детектит это и пропускается.
import { readFileSync } from 'node:fs';

const ROOT = import.meta.dirname;
const RECOVERY = await import(ROOT + '/../src/features/recovery.js');
const APP_SRC = readFileSync(ROOT + '/../src/App.vue', 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
async function rejects(fn) {
  try { await fn(); return false; } catch { return true; }
}
// Тишина логов шагов recovery во время прогонов (содержимого нет, только шум).
function mute() {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  return () => { console.log = l; console.warn = w; };
}

// ── Моки зависимостей (инъекция, не подмена импортов) ─────────────
// Маркеры тела письма определяют поведение parse/unwrap:
//   'GOOD'        → escrow, unwrap ок
//   'WRONG'       → escrow, unwrap бросает (чужой ключ)
//   'NON-ESCROW'  → parse возвращает null
//   'PARSE-THROW' → parse бросает
function makeDeps(cfg) {
  const state = {
    fetchCalls: 0, fetchThrew: false,
    fetchBodies: [],        // { uids, folder }
    parseCalls: 0,
    unwrapCalls: 0,         // сколько раз дошли до unwrap
    imports: [],            // jsonData каждого import_backup
    importThrew: false,
  };
  const deps = {
    api: {
      fetchEmails: async () => {
        state.fetchCalls++;
        if (cfg.msgs === 'THROW') { state.fetchThrew = true; throw new Error('fetch down'); }
        return cfg.msgs || [];
      },
    },
    crypto: {
      recoveryValidateMnemonic: async () => cfg.validMnemonic !== false,
      recoveryParseEscrowEmail: async (body) => {
        state.parseCalls++;
        if (body === 'PARSE-THROW') throw new Error('parse boom');
        if (body === 'NON-ESCROW') return null;
        if (body === 'WRONG') return 'WRAPPED-WRONG';
        if (body === 'GOOD') return 'WRAPPED-GOOD';
        return null;
      },
      recoveryUnwrapBackup: async (wrapped) => {
        state.unwrapCalls++;
        if (wrapped === 'WRAPPED-WRONG') throw new Error('wrong key');
        return '{"backup":"good-json"}';
      },
    },
    invoke: async (cmd, args) => {
      if (cmd === 'email_fetch_bodies') {
        state.fetchBodies.push({ uids: args.uids, folder: args.folder });
        if (cfg.bodies === 'THROW') throw new Error('bodies down');
        if (typeof cfg.bodiesByFolder === 'function') return cfg.bodiesByFolder(args.folder);
        return [];
      }
      if (cmd === 'import_backup') {
        state.imports.push(args.jsonData);
        if (cfg.importBackup === 'THROW') { state.importThrew = true; throw new Error('import boom'); }
        return true;
      }
      throw new Error('unexpected invoke ' + cmd);
    },
  };
  return { deps, state };
}
const GOOD_JSON = '{"backup":"good-json"}';
const msg = (folder, uid, subject) => ({ folder, uid, subject });

// ══════════════════════════════════════════════════════════════════
// RED — старый алгоритм из App.vue (только пока App.vue НЕ делегат)
// ══════════════════════════════════════════════════════════════════
function extractMethodBody(src, signature) {
  const s = src.indexOf(signature);
  if (s < 0) return null;
  const open = src.indexOf('{', s);
  let depth = 0, i = open, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

console.log('RED — старый recoverFromEscrow из App.vue (устойчивость)');
{
  const body = extractMethodBody(APP_SRC, 'async recoverFromEscrow(mnemonic)');
  const isOld = !!body && body.includes('email_fetch_bodies');
  const isDelegate = !!body && body.includes('RecoveryFeature.recoverFromEscrow');
  if (isDelegate) {
    check('RED: App.vue уже тонкий делегат — баг устранён (RED доказан на пре-фиксном методе)', true);
  } else if (isOld) {
    const oldRecover = new Function('return (async function(crypto, api, invoke, mnemonic){ ' + body + ' })')();
    // RED-1: wrong escrow ПЕРЕД good — старый метод должен споткнуться.
    {
      const { deps, state } = makeDeps({
        msgs: [msg('INBOX', 1, '')],
        bodiesByFolder: () => [['1', 'WRONG'], ['2', 'GOOD']],
      });
      const ctx = { email: 'me@x.ru' };
      const unmute = mute();
      const threw = await rejects(() => oldRecover.call(ctx, deps.crypto, deps.api, deps.invoke, 'MNEMONIC'));
      unmute();
      check('RED-1 wrong→good: старый метод бросает (обрыв поиска)', threw);
      check('RED-1 wrong→good: good backup НЕ импортирован (import=0)', state.imports.length === 0, state.imports.length);
    }
    // RED-2: parse бросает ПЕРЕД good.
    {
      const { deps, state } = makeDeps({
        msgs: [msg('INBOX', 1, '')],
        bodiesByFolder: () => [['1', 'PARSE-THROW'], ['2', 'GOOD']],
      });
      const ctx = { email: 'me@x.ru' };
      const unmute = mute();
      const threw = await rejects(() => oldRecover.call(ctx, deps.crypto, deps.api, deps.invoke, 'MNEMONIC'));
      unmute();
      check('RED-2 parse-throw→good: старый метод бросает', threw);
      check('RED-2 parse-throw→good: good backup НЕ импортирован (import=0)', state.imports.length === 0, state.imports.length);
    }
  } else {
    check('RED: не найдено тело recoverFromEscrow', false);
  }
}

// ══════════════════════════════════════════════════════════════════
// GREEN — живой модуль recovery.js (прямой импорт, не копия)
// ══════════════════════════════════════════════════════════════════
console.log('GREEN — живой модуль recovery.js');
const run = async (cfg) => {
  const { deps, state } = makeDeps(cfg);
  const ctx = { email: 'me@x.ru' };
  const unmute = mute();
  let threw = false, ret;
  try { ret = await RECOVERY.recoverFromEscrow(ctx, 'MNEMONIC', deps); }
  catch { threw = true; } finally { unmute(); }
  return { state, threw, ret };
};

// 1. wrong escrow, затем good → true, import ровно один раз правильного backup.
{
  const { state, threw, ret } = await run({
    msgs: [msg('INBOX', 1, '')],
    bodiesByFolder: () => [['1', 'WRONG'], ['2', 'GOOD']],
  });
  check('1 wrong→good: вернул true', ret === true && !threw);
  check('1 wrong→good: import ровно 1 раз правильного backup',
    state.imports.length === 1 && state.imports[0] === GOOD_JSON, state.imports);
}

// 2. parse throw, null/non-escrow, затем good → true.
{
  const { state, ret } = await run({
    msgs: [msg('INBOX', 1, '')],
    bodiesByFolder: () => [['1', 'PARSE-THROW'], ['2', 'NON-ESCROW'], ['3', 'GOOD']],
  });
  check('2 parse-throw/null→good: вернул true', ret === true);
  check('2 parse-throw/null→good: import ровно 1 раз', state.imports.length === 1, state.imports);
}

// 3. все wrong/null → false, import 0.
{
  const { state, ret } = await run({
    msgs: [msg('INBOX', 1, '')],
    bodiesByFolder: () => [['1', 'WRONG'], ['2', 'NON-ESCROW']],
  });
  check('3 все wrong/null: вернул false', ret === false);
  check('3 все wrong/null: import 0', state.imports.length === 0, state.imports);
}

// 4. invalid mnemonic → rejection, fetch/import 0.
{
  const { state, threw } = await run({ msgs: [msg('INBOX', 1, '')], validMnemonic: false });
  check('4 invalid mnemonic: reject', threw);
  check('4 invalid mnemonic: fetch 0 и import 0', state.fetchCalls === 0 && state.imports.length === 0, state.fetchCalls);
}

// 5. good первым → stop, поздний wrong не unwrap.
{
  const { state, ret } = await run({
    msgs: [msg('INBOX', 1, '')],
    bodiesByFolder: () => [['1', 'GOOD'], ['2', 'WRONG']],
  });
  check('5 good первым: вернул true', ret === true);
  check('5 good первым: import 1, unwrap 1 (поздний wrong не трогали)',
    state.imports.length === 1 && state.unwrapCalls === 1, { i: state.imports.length, u: state.unwrapCalls });
}

// 6. wrong в INBOX, good в Junk → true, UID-строки и правильные папки.
{
  const { state, ret } = await run({
    msgs: [msg('INBOX', 1, ''), msg('Junk', 2, '')],
    bodiesByFolder: (folder) => (folder === 'INBOX' ? [['1', 'WRONG']] : [['2', 'GOOD']]),
  });
  const inbox = state.fetchBodies.find((c) => c.folder === 'INBOX');
  const junk = state.fetchBodies.find((c) => c.folder === 'Junk');
  check('6 wrong INBOX + good Junk: вернул true', ret === true);
  check('6 вернул true и import 1', state.imports.length === 1, state.imports);
  check('6 INBOX fetch_bodies: UID — строки', !!inbox && inbox.uids.length === 1 && inbox.uids[0] === '1' && typeof inbox.uids[0] === 'string', inbox);
  check('6 Junk fetch_bodies: UID — строки, правильная папка', !!junk && junk.folder === 'Junk' && junk.uids[0] === '2' && typeof junk.uids[0] === 'string', junk);
}

// 7. ошибка import на good → reject, НЕ пробовать следующую good запись.
{
  const { state, threw } = await run({
    msgs: [msg('INBOX', 1, '')],
    bodiesByFolder: () => [['1', 'GOOD'], ['2', 'GOOD']],
    importBackup: 'THROW',
  });
  check('7 import error: reject', threw);
  check('7 import error: import пробован 1 раз (следующая good не тронута)', state.imports.length === 1, state.imports);
}

// 8. fetchEmails failure → reject.
{
  const { state, threw } = await run({ msgs: 'THROW' });
  check('8 fetchEmails failure: reject', threw);
  check('8 fetchEmails failure: import 0', state.imports.length === 0, state.imports);
}

// 9. empty-subject фильтр и лимит 80 сохраняются.
{
  const msgs = [];
  for (let i = 0; i < 5; i++) msgs.push(msg('INBOX', 1000 + i, 'непустая тема ' + i)); // должны отсечься
  for (let i = 0; i < 100; i++) msgs.push(msg('INBOX', i + 1, ''));                   // пустая тема
  const { state, threw, ret } = await run({
    msgs,
    bodiesByFolder: () => Array.from({ length: 80 }, (_, i) => [String(i + 1), 'NON-ESCROW']),
  });
  const inbox = state.fetchBodies.find((c) => c.folder === 'INBOX');
  const uids = inbox ? inbox.uids : [];
  check('9 лимит 80 кандидатов', uids.length === 80, uids.length);
  check('9 пустая тема: непустая тема отфильтрована (uid<=100)', uids.every((u) => Number(u) <= 100), uids.slice(0, 3));
  check('9 UID — строки', uids.length > 0 && uids.every((u) => typeof u === 'string'));
  check('9 все 80 тел действительно разобраны (не проглочена ошибка mock)',
    !threw && ret === false && state.parseCalls === 80 && state.imports.length === 0,
    { threw, ret, parsed: state.parseCalls });
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
