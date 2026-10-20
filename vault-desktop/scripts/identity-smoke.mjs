// Node-смоук src/identity.js — namespace хранилища и fingerprint.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Резолвер namespace решает, ГДЕ лежат черновики,
// флаги чатов, body-cache и история: `fp:<fingerprint>` (стабилен при смене
// почты) либо legacy-емейл. Ошибка здесь стоит ПОТЕРИ ДАННЫХ: если адрес
// хранилища «поедет», письма останутся в старом namespace и будут выглядеть
// исчезнувшими.
//
// ДВА ПРАВИЛА, КОТОРЫЕ НЕЛЬЗЯ НАРУШАТЬ:
//   * кэш привязан к ЗНАЧЕНИЮ public_key, а не к факту вызова: ключ может
//     появиться позже (вход по recovery-мнемонике грузит пару после первого
//     резолвера) — и тогда namespace пересчитывается сам;
//   * резолвер FAIL-OPEN: если команда недоступна (нет команды, нет БД),
//     берётся емейл и вход НЕ блокируется.
//
// Плюс одноразовый перенос legacy-строк: команда db_account_migrate идемпотентна,
// но вызываем мы её РОВНО ОДИН раз на пару (адрес → fp).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/identity-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = {
  pk: 'PUBKEY1',
  fp: 'aa:bb:cc:dd:ee:ff',
  fpFails: false,
  ns: 'fp:aa:bb:cc:dd:ee:ff',
  nsFails: false,
  nsCalls: [],
  migrateCalls: [],
  migrateFails: false,
};
globalThis.__state = state;

writeFileSync(MOCKS + '/core.js', `export const invoke = (...a) => globalThis.__invoke(...a);`);
writeFileSync(MOCKS + '/crypto.js', `
const st = globalThis.__state;
export default {
  get publicKey() { return st.pk; },
  fingerprint: async () => {
    if (st.fpFails) throw new Error('fingerprint недоступен');
    return st.fp;
  },
};
`);

let src = readFileSync(path.join(ROOT, 'src', 'identity.js'), 'utf8');
src = src.replace("from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`)
         .replace("from './crypto.js'", `from "${MOCKS}/crypto.js"`);
writeFileSync(MOCKS + '/identity.mjs', src, 'utf8');

globalThis.__invoke = async (cmd, args) => {
  if (cmd === 'db_account_namespace') {
    state.nsCalls.push(args);
    if (state.nsFails) throw new Error('команда недоступна');
    return state.ns;
  }
  if (cmd === 'db_account_migrate') {
    state.migrateCalls.push(args);
    if (state.migrateFails) throw new Error('миграция отказала');
    return { total: 3 };
  }
  return null;
};

const I = await import(MOCKS + '/identity.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() {
  state.pk = 'PUBKEY1';
  state.fp = 'aa:bb:cc:dd:ee:ff';
  state.fpFails = false;
  state.ns = 'fp:aa:bb:cc:dd:ee:ff';
  state.nsFails = false;
  state.nsCalls = [];
  state.migrateCalls = [];
  state.migrateFails = false;
  I.resetAccountNamespaceCache();
}

// ── Базовый резолв ───────────────────────────────────────────────────────
{
  reset();
  const ns = await I.accountNamespace('me@bk.ru');
  ok('namespace = fp:<fingerprint>', ns === 'fp:aa:bb:cc:dd:ee:ff', ns);
  ok('в команду ушли и fp, и email', state.nsCalls.length === 1
    && state.nsCalls[0].fp === 'aa:bb:cc:dd:ee:ff' && state.nsCalls[0].email === 'me@bk.ru', state.nsCalls);
  ok('email нормализован (регистр и пробелы)', state.nsCalls[0].email === 'me@bk.ru');
}

// ── Нормализация адреса ─────────────────────────────────────────────────
{
  reset();
  await I.accountNamespace('  Me@BK.RU  ');
  ok('адрес нормализован: регистр снят, пробелы обрезаны (иначе кэш раздваивается)',
    state.nsCalls.length === 1 && state.nsCalls[0].email === 'me@bk.ru', state.nsCalls);
}

// ── FAIL-OPEN: команда недоступна ───────────────────────────────────────
{
  reset();
  state.nsFails = true;
  const ns = await I.accountNamespace('me@bk.ru');
  ok('команда недоступна → fallback на email (вход не блокируется)', ns === 'me@bk.ru', ns);
}
{
  reset();
  state.fpFails = true;
  const ns = await I.accountNamespace('me@bk.ru');
  // Команда namespace всё равно зовётся, но с ПУСТЫМ fp: сбой fingerprint не
  // блокирует вход (fail-open) — резолвер решает по адресу.
  ok('fingerprint недоступен → резолвер всё равно зовётся, с пустым fp',
    state.nsCalls.length === 1 && state.nsCalls[0].fp === '', state.nsCalls);
  ok('fingerprint недоступен → вход не заблокирован (ответ есть)', typeof ns === 'string' && ns.length > 0, ns);
}
{
  reset();
  state.pk = '';
  await I.accountNamespace('me@bk.ru');
  ok('без публичного ключа → резолвер зовётся с пустым fp',
    state.nsCalls.length === 1 && state.nsCalls[0].fp === '', state.nsCalls);
}

// ── Кэш: привязан к (public_key, email) ─────────────────────────────────
{
  reset();
  await I.accountNamespace('me@bk.ru');
  await I.accountNamespace('me@bk.ru');
  ok('повторный резолв того же ключа берёт кэш (команда не зовётся)', state.nsCalls.length === 1, state.nsCalls.length);
}
{
  reset();
  await I.accountNamespace('me@bk.ru');
  state.pk = 'PUBKEY2';
  state.ns = 'fp:11:22:33:44:55:66';
  const ns = await I.accountNamespace('me@bk.ru');
  ok('появился ключ → namespace ПЕРЕСЧИТЫВАЕТСЯ (кэш привязан к значению ключа)',
    ns === 'fp:11:22:33:44:55:66' && state.nsCalls.length === 2, { ns, calls: state.nsCalls.length });
}
{
  reset();
  await I.accountNamespace('me@bk.ru');
  await I.accountNamespace('other@bk.ru');
  ok('смена почты → резолвер зовётся снова (кэш привязан к паре ключ+адрес)',
    state.nsCalls.length === 2, state.nsCalls.length);
}

// ── Одноразовый перенос legacy-строк ────────────────────────────────────
{
  reset();
  const ns = await I.ensureAccountNamespace('me@bk.ru');
  ok('перенос выполнен для legacy-адреса', state.migrateCalls.length === 1
    && state.migrateCalls[0].fromAccount === 'me@bk.ru' && state.migrateCalls[0].toAccount === ns, state.migrateCalls);
  await I.ensureAccountNamespace('me@bk.ru');
  ok('перенос НЕ повторяется (команда идемпотентна, но зовём один раз)', state.migrateCalls.length === 1, state.migrateCalls.length);
}
{
  reset();
  state.ns = 'me@bk.ru';   // резолвер вернул сам адрес → переносить нечего
  const ns = await I.ensureAccountNamespace('me@bk.ru');
  ok('namespace == email → перенос не нужен', state.migrateCalls.length === 0 && ns === 'me@bk.ru', { ns, calls: state.migrateCalls.length });
}
{
  reset();
  state.ns = 'fp:aa:bb:cc:dd:ee:ff';
  const ns = await I.ensureAccountNamespace('me@bk.ru');
  ok('fp-namespace → перенос выполнен', state.migrateCalls.length === 1, state.migrateCalls.length);
}
{
  reset();
  state.migrateFails = true;
  let threw = false;
  try { await I.ensureAccountNamespace('me@bk.ru'); } catch (e) { threw = true; }
  ok('отказ переноса не ломает вход (fail-open)', threw === false);
}
{
  reset();
  const ns = await I.ensureAccountNamespace('');
  ok('пустой адрес → перенос не выполняется', state.migrateCalls.length === 0 && typeof ns === 'string');
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
