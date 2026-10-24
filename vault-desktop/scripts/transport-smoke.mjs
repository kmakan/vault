// Node-смоук features/transport.js — чип выбора транспорта в composer'е.
//
// Что меряется: ПРОВОДКА фронта. Правило «каким транспортом уходит» и порядок
// переключения живут в Rust (vault-core::transport) и измеряются его же
// юнит-тестами и мутационным набором rust-transport; здесь проверяется, что
// фронт (1) слушает ответ моста, а не догадывается, (2) не переписывает
// состояние при сбое чтения и (3) показывает оформление того выбора, который
// вернулся.
//
// Мок api играет Rust-сторону: kv-ключ и цикл `auto → relay → mail` зашиты
// сюда как заглушка ядра — ровно так же, как settings-ui-smoke зашивает
// дефолт тумблеров.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/transport-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

globalThis.__apiMock = { kv: {}, account: 'kmakan@example.com', nextStub: null, prefStub: null };
writeFileSync(MOCKS + '/api.js', `
const m = globalThis.__apiMock;
const KEY = 'transport-preference';
const CYCLE = ['auto', 'relay', 'mail'];
const norm = (v) => (CYCLE.includes(v) ? v : 'auto');
export const api = {
  transportPreference: async (account) => {
    m.readAccount = account;
    if (m.prefStub) return m.prefStub();
    return norm(m.kv[KEY] || 'auto');
  },
  transportPreferenceNext: async (account) => {
    m.writeAccount = account;
    if (m.nextStub) return m.nextStub();
    const here = norm(m.kv[KEY] || 'auto');
    const next = CYCLE[(CYCLE.indexOf(here) + 1) % CYCLE.length];
    m.kv[KEY] = next;
    return next;
  },
};
export default api;
`);
writeFileSync(MOCKS + '/session-store.js', `
export const sessionStore = { getCurrentEmail: () => globalThis.__apiMock.account };
`);

prepareModuleCopy(
  ROOT + '/src/features/transport.js',
  MOCKS + '/transport.mjs',
  { '../api.js': 'api.js', './session-store.js': 'session-store.js' },
  MOCKS,
);
const T = await import(MOCKS + '/transport.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const s = { preference: 'auto', toasts: [] };
  return {
    s,
    setTransportPreference: (v) => { s.preference = v; },
    showToast: (m, ms) => { s.toasts.push([m, ms]); },
    t: (key) => 'L:' + key,
    ...over,
  };
}

// ── Оформление возврата (чистая таблица, ветвления по протоколу нет) ────
{
  check('вид: auto — иконка отправки',
    T.transportView('auto').icon === 'send' && T.transportView('auto').titleKey === 'transport_auto');
  check('вид: relay — глобус (релей)',
    T.transportView('relay').icon === 'globe' && T.transportView('relay').titleKey === 'transport_relay');
  check('вид: mail — письмо',
    T.transportView('mail').icon === 'mail' && T.transportView('mail').titleKey === 'transport_mail');
  // Неизвестное значение показывается как «авто»: ядро для него и план
  // считает авто, подпись не должна расходиться с поведением.
  check('вид: постороннее значение → авто',
    T.transportView('что-то').icon === 'send' && T.transportView(undefined).titleKey === 'transport_auto',
    T.transportView('что-то'));
}

// ── Чтение при входе ────────────────────────────────────────────────────
{
  globalThis.__apiMock.kv = {};
  const deps = makeDeps();
  const got = await T.loadTransportPreference(deps);
  check('чтение: без записи — авто', deps.s.preference === 'auto' && got === 'auto', deps.s);

  globalThis.__apiMock.kv = { 'transport-preference': 'mail' };
  const d2 = makeDeps();
  await T.loadTransportPreference(d2);
  check('чтение: сохранённый выбор доходит до интерфейса', d2.s.preference === 'mail', d2.s);

  // Ошибка моста = null: состояние остаётся, иначе включённый «только почта»
  // молча превратился бы в «авто» и пользователь жёг бы лимит релея.
  globalThis.__apiMock.prefStub = () => null;
  const broken = makeDeps();
  broken.s.preference = 'relay';
  const before = broken.s.toasts.length;
  const gotBroken = await T.loadTransportPreference(broken);
  delete globalThis.__apiMock.prefStub;
  check('чтение: null-ответ не переписывает состояние',
    broken.s.preference === 'relay' && gotBroken === null, broken.s);
  check('чтение: null-ответ ничего не сообщает пользователю',
    broken.s.toasts.length === before, broken.s.toasts);
}

// ── Клик по чипу ────────────────────────────────────────────────────────
{
  globalThis.__apiMock.kv = {};
  const deps = makeDeps();
  const seen = [];
  const shown = [];
  for (let i = 0; i < 3; i++) {
    seen.push(await T.cycleTransportPreference(deps));
    shown.push(deps.s.preference);
  }
  check('клик: порядок переключения идёт из Rust (auto → relay → mail → auto)',
    seen.join(',') === 'relay,mail,auto', seen);
  check('клик: состояние интерфейса = вернувшееся имя (каждый шаг)',
    shown.join(',') === 'relay,mail,auto', shown);
  check('клик: kv записан мостом (фронт сам не пишет)',
    globalThis.__apiMock.kv['transport-preference'] === 'auto', globalThis.__apiMock.kv);
  check('клик: подпись показывает новый выбор',
    deps.s.toasts.map(([m]) => m).join(',') ===
      'L:transport_relay,L:transport_mail,L:transport_auto', deps.s.toasts);

  // Сбой моста: ничего не меняется и не сообщается. Ложная настройка хуже
  // молчания — пользователь решил бы, что переключил.
  globalThis.__apiMock.kv = { 'transport-preference': 'mail' };
  const d2 = makeDeps();
  d2.s.preference = 'mail';
  globalThis.__apiMock.nextStub = () => null;
  const got = await T.cycleTransportPreference(d2);
  delete globalThis.__apiMock.nextStub;
  check('клик: null-ответ моста не двигает выбор',
    got === null && d2.s.preference === 'mail' && d2.s.toasts.length === 0,
    { got, s: d2.s });
}

// ── Контракт вызова: адрес берётся у владельца сессии ───────────────────
{
  globalThis.__apiMock.kv = {};
  const deps = makeDeps();
  globalThis.__apiMock.account = 'другой@example.com';
  await T.loadTransportPreference(deps);
  await T.cycleTransportPreference(deps);
  check('адрес: настройка читается и пишется на текущий аккаунт',
    globalThis.__apiMock.readAccount === 'другой@example.com' &&
      globalThis.__apiMock.writeAccount === 'другой@example.com' &&
      globalThis.__apiMock.kv['transport-preference'] === 'relay',
    { read: globalThis.__apiMock.readAccount, write: globalThis.__apiMock.writeAccount, kv: globalThis.__apiMock.kv });
  globalThis.__apiMock.account = 'kmakan@example.com';
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
