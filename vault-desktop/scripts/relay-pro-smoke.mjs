// Node-смоук платных токенов на клиенте (relay-client.js: checkout → verify →
// activate → состояние Pro).
//
// ЧТО ЛОВИТСЯ. Покупка — самое «денежное» место приложения, и ошибки в ней
// тихие: клиент показал «оплачено», а токен не выпущен (или выпущен для чужого
// fingerprint). Проверяем цепочку целиком и отдельно — офлайн-грейс: релей
// недоступен, но сообщения должны ходить ещё 7 дней по ПОСЛЕДНЕМУ
// подтверждённому состоянию, и грейс не должен продлеваться переводом системных
// часов назад.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = import.meta.dirname;
const MOCKS = '/tmp/relay-pro-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Мок моста: kv-хранилище + отпечаток ─────────────────────────────────
const kv = new Map();
const bridge = { calls: [] };
globalThis.__invoke = async (cmd, args) => {
  bridge.calls.push([cmd, args]);
  if (cmd === 'db_kv_get') return kv.has(args.key) ? kv.get(args.key) : null;
  if (cmd === 'db_kv_set') { kv.set(args.key, args.value); return null; }
  if (cmd === 'get_fingerprint') return 'fp-alice';
  return null;
};
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);\n');
writeFileSync(MOCKS + '/crypto.js', `
export default {
  fingerprint: async () => 'fp-alice',
};
`);

// ── Мок сети: эндпоинты платёжных роутов ────────────────────────────────
const net = [];
let failVerify = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  net.push([u, opts.method || 'GET', opts.body || '']);
  const json = async (o) => o;
  if (u.includes('/purchase/checkout')) {
    return { ok: true, status: 200, json: async () => ({
      checkout_id: 'co_test_1', provider: 'test',
      payment_url: 'vault-relay://pay/test/fp', expires_in: 1800,
    }) };
  }
  if (u.includes('/purchase/verify')) {
    if (failVerify) return { ok: false, status: 402, json: async () => ({ error: 'not_paid_yet' }) };
    return { ok: true, status: 200, json: async () => ({
      token: 'v2token', topic: 'topic-hash', plan: 'pro', paid_until: 4102444800, sub: 1,
    }) };
  }
  if (u.includes('/tokens/activate')) {
    return { ok: true, status: 200, json: async () => ({ bound: true, devices: 1, max_devices: 3 }) };
  }
  if (u.includes('/tokens/info')) {
    if (globalThis.__infoExpired) {
      return { ok: false, status: 402, json: async () => ({ error: 'subscription expired' }) };
    }
    return { ok: true, status: 200, json: async () => ({
      plan: 'pro', paid_until: 4102444800, daily_used: 12, daily_limit: 0,
      devices: 1, max_devices: 3, grace_until: 4102444800,
    }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

prepareModuleCopy(
  path.resolve(ROOT, '../src/relay-client.js'),
  MOCKS + '/relay-client.mjs',
  { '@tauri-apps/api/core': 'core.js', './crypto.js': 'crypto.js' },
  MOCKS,
);
const R = await import(MOCKS + '/relay-client.mjs');

// ── 1. Чекаут ───────────────────────────────────────────────────────────
console.log('1. purchaseCheckout');
{
  net.length = 0;
  const co = await R.purchaseCheckout('me@x.ru', 'pro', 12);
  check('вернулся checkout_id', !!(co && co.checkout_id), co);
  check('в теле ушёл fingerprint', net.some(([, , b]) => b.includes('fp-alice')), net);
  check('в теле ушёл план и срок',
    net.some(([, , b]) => b.includes('"plan":"pro"') && b.includes('"months":12')), net);
}

// ── 2. Верификация: токен + активация + запись в relay-list ─────────────
console.log('2. purchaseVerify');
{
  net.length = 0;
  const vr = await R.purchaseVerify('me@x.ru', 'co_test_1');
  check('токен получен', !!(vr && vr.token === 'v2token'), vr);
  check('активация на устройстве выполнена', net.some(([u]) => u.includes('/tokens/activate')), net);
  const relays = await R.getRelays('me@x.ru');
  const ours = relays.find((x) => x.url.includes('vault-msg.ru'));
  check('наш токен записан в relay-list', !!(ours && ours.myToken === 'v2token'), relays);
  const st = await R.proState('me@x.ru');
  check('состояние Pro сохранено (plan=pro)', st && st.plan === 'pro', st);
}

// ── 3. Неоплаченный чекаут ──────────────────────────────────────────────
console.log('3. неоплаченный чекаут');
{
  net.length = 0;
  failVerify = true;
  const vr = await R.purchaseVerify('me@x.ru', 'co_test_1');
  check('ответ «не оплачено» не выдан как токен', !!(vr && vr.error), vr);
  failVerify = false;
}

// ── 4. Состояние по /tokens/info ───────────────────────────────────────
console.log('4. fetchTokenInfo');
{
  const info = await R.fetchTokenInfo('me@x.ru', 'https://vault-msg.ru/relay');
  check('план получен', !!(info && info.plan === 'pro'), info);
  check('суточный расход виден', !!(info && info.daily_used === 12), info);
  const st = await R.proState('me@x.ru');
  check('локальное состояние обновлено', !!(st && st.paid_until > 0), st);
}

// ── 5. Офлайн-грейс: состояние переживает недоступность релея ──────────
console.log('5. офлайн-грейс');
{
  const saved = await R.proState('me@x.ru');
  check('Pro активен по сохранённому состоянию', saved.plan === 'pro', saved);
  // Релей недоступен: fetch падает → состояние остаётся прежним.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('сеть недоступна'); };
  const info = await R.fetchTokenInfo('me@x.ru', 'https://vault-msg.ru/relay');
  check('при недоступном релее info = null (не выдуманный успех)', info === null, info);
  const st = await R.proState('me@x.ru');
  check('после недоступного релея Pro всё ещё активен (грейс)', st.plan === 'pro', st);
  globalThis.fetch = realFetch;
}

// ── 6. Грейс не продлевается переводом часов ───────────────────────────
console.log('6. защита от перевода часов');
{
  // Клиентское время считается по performance.timeOrigin + performance.now(),
  // а не по Date.now(): перевод системных часов не должен продлить грейс.
  //
  // Сдвигаем часы ЗА пределы оплаченного срока (2100 год) — иначе проверка
  // ничего не проверяет: +400 дней до 2100 года не пересекают грейс.
  const realNow = Date.now;
  const future = realNow() + 200 * 365 * 24 * 3600 * 1000; // «часы уехали за 2100»
  Date.now = () => future;
  const st = await R.proState('me@x.ru');
  Date.now = realNow;
  // Если бы сравнение шло по Date.now(), «будущее» время дало бы offline=true
  // и Pro считался бы вечным; по performance.now() — нет.
  check('перевод часов не ломает чтение состояния', !!(st && st.plan), st);
  check('план после перевода часов прежний (часы не влияют на грейс)', st.plan === 'pro', st);
}

console.log('7. сервер сообщил об истечении подписки');
{
  globalThis.__infoExpired = true;
  const info = await R.fetchTokenInfo('me@x.ru', 'https://vault-msg.ru/relay');
  check('истёкшая подписка: ответ помечен', !!(info && info.expired), info);
  const st = await R.proState('me@x.ru');
  check('истёкшая подписка: локально Pro сброшен в free', st.plan === 'free', st);
  globalThis.__infoExpired = false;
  // Вернуть активное состояние для следующих кейсов.
  await R.saveProState('me@x.ru', {
    plan: 'pro', paid_until: 4102444800, grace_until: 4102444800,
  });
}

console.log('8. истёкший Pro');
{
  // Оплаченный срок в прошлом → Pro больше не активен (грейс 7 дней после
  // paid_until, а не вечность).
  kv.set('relay-pro-state', JSON.stringify({
    plan: 'pro',
    paid_until: Math.floor(Date.now() / 1000) - 30 * 24 * 3600, // месяц назад
    grace_until: 0,
  }));
  const st = await R.proState('me@x.ru');
  check('истёкший Pro не активен', st.plan === 'free', st);
  check('истёкший Pro: offline = false', st.offline === false, st);
  // Возвращаем прежнее состояние для следующих проверок.
  kv.set('relay-pro-state', JSON.stringify({
    plan: 'pro', paid_until: 4102444800, grace_until: 4102444800,
  }));
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
