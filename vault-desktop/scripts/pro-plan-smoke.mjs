// Node-смоук features/pro-plan.js — правила экрана платного тарифа Pro.
//
// ЧТО ЛОВИТСЯ. Экран покупки — самое «денежное» место приложения, и ошибки в
// нём двусторонние: можно показать «оплачено» без оплаты (пользователь
// платит и не получает Pro) или показать «Free» при оплаченном Pro (пользователь
// требует возврата). Правила проверяем в чистом виде: вид экрана по состоянию,
// срок, устройства, человеческие тексты ошибок и сам сценарий покупки.
//
// ПРО МОНОТОННОСТЬ. Счёт дней и сравнение сроков — в unix-СЕКУНДАХ (так их
// отдаёт сервер). Проверка с секундами ловит смешение единиц, из-за которого
// «7 дней грейса» превращались в 7000 дней, а срок в 2100 году считался
// вечным.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/pro-plan-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/pro-plan.js',
  MOCKS + '/pro-plan.mjs',
  {},
  MOCKS,
);
const P = await import(MOCKS + '/pro-plan.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Подставка перевода. Два варианта:
//   t  — возвращает сам ключ: так проверяется, ЧТО за ключ выбран (текст
//        экрана должен брать именно 'pro_status_free', а не что-то другое);
//   tl — возвращает «локализованную» строку с подстановкой параметров: так
//        проверяется, что причина ошибки ДОШЛА до пользователя (в реальном
//        i18n.js подстановка идёт в значение локали, а не в ключ).
const t = (key, params) => {
  let s = key;
  for (const [k, v] of Object.entries(params || {})) s = s.replace('{' + k + '}', String(v));
  return s;
};
const LOCALES = {
  pro_buy_failed: 'Не удалось оформить покупку: {why}',
  pro_buy_ok: 'Pro активирован',
  pro_err_generic: 'Не удалось оформить покупку ({why})',
  pro_daily: 'действий релея сегодня {used}/{limit}',
};
const tl = (key, params) => {
  let s = LOCALES[key] || key;
  for (const [k, v] of Object.entries(params || {})) s = s.replace('{' + k + '}', String(v));
  return s;
};

const NOW = 1_800_000_000; // фиксированный момент (секунды)
const DAY = 86400;

// ── 1. Вид экрана по состоянию ──────────────────────────────────────────
console.log('1. proView');
{
  check('free: без состояния', P.proView(null, NOW).kind === P.PRO_KIND.FREE);
  check('free: план free', P.proView({ plan: 'free' }, NOW).kind === P.PRO_KIND.FREE);

  const active = P.proView({ plan: 'pro', paid_until: NOW + 30 * DAY }, NOW);
  check('active: оплаченный план в силе', active.kind === P.PRO_KIND.ACTIVE, active);
  check('active: дней осталось 30', active.daysLeft === 30, active);

  const trial = P.proView({ plan: 'trial', paid_until: NOW + 12 * DAY }, NOW);
  check('trial: пробный период', trial.kind === P.PRO_KIND.TRIAL, trial);
  check('trial: дней осталось 12', trial.daysLeft === 12, trial);

  const expired = P.proView({ plan: 'pro', paid_until: NOW - DAY }, NOW);
  check('expired: срок вышел — не active', expired.kind === P.PRO_KIND.EXPIRED, expired);
  check('expired: дней не осталось', expired.daysLeft === 0, expired);

  // Край: срок истёк ровно сейчас → уже не активен.
  const edge = P.proView({ plan: 'pro', paid_until: NOW }, NOW);
  check('edge: срок == сейчас → expired', edge.kind === P.PRO_KIND.EXPIRED, edge);

  // Остаток суток округляется вверх: «осталось 12 дней» должно означать
  // «меньше суток не значит ноль».
  const hour = P.proView({ plan: 'pro', paid_until: NOW + 3600 }, NOW);
  check('дробные сутки округляются вверх', hour.daysLeft === 1, hour);
}

// ── 2. Тексты экрана ────────────────────────────────────────────────────
console.log('2. тексты');
{
  const free = P.proView({ plan: 'free', daily_limit: 100 }, NOW);
  check('free: статус', P.proStatusText(free, t) === 'pro_status_free', P.proStatusText(free, t));
  check('free: кнопка «купить»', P.proActionLabel(free, t) === 'pro_action_buy');
  // У бесплатного тарифа деталей нет: «до <дата>» означала бы срок технического
  // токена, а читалась как «бесплатно до 2036».
  check('free: деталей нет (срок токена ≠ срок оплаченного тарифа)',
    P.proDetailsText(free, t, 'ru') === '', P.proDetailsText(free, t, 'ru'));
  check('free: даже со сроком деталей нет',
    P.proDetailsText(P.proView({ plan: 'free', paid_until: NOW + 30 * DAY }, NOW), t, 'ru') === '');

  const active = P.proView({ plan: 'pro', paid_until: NOW + 30 * DAY, devices: 2, max_devices: 3 }, NOW);
  check('active: статус', P.proStatusText(active, t) === 'pro_status_active', P.proStatusText(active, t));
  check('active: кнопка «продлить»', P.proActionLabel(active, t) === 'pro_action_extend');
  const details = P.proDetailsText(active, t, 'ru');
  check('active: в деталях есть срок', details.includes('pro_until'), details);
  check('active: в деталях есть устройства', details.includes('pro_devices'), details);
  // Без квоты от сервера строку не рисуем: «0/0» выглядело бы как нулевой лимит.
  check('active без квоты: строки pro_daily нет', !details.includes('pro_daily'), details);

  // Действующий тариф с серверной квотой: расход и предел доходят до текста.
  const activeQ = P.proView({ plan: 'pro', paid_until: NOW + 30 * DAY, daily_used: 12, daily_limit: 1000 }, NOW);
  const qDetails = P.proDetailsText(activeQ, t, 'ru');
  check('active с квотой: в деталях есть pro_daily', qDetails.includes('pro_daily'), qDetails);
  check('active с квотой: видны расход и предел',
    P.proDetailsText(activeQ, tl, 'ru').includes('12/1000'), P.proDetailsText(activeQ, tl, 'ru'));

  // У истёкшего тарифа релей уже работает по лимиту Free: остаток оплаченной
  // квоты показывать нельзя.
  const expiredQ = P.proView({ plan: 'pro', paid_until: NOW - DAY, daily_used: 5, daily_limit: 1000 }, NOW);
  check('expired: строки pro_daily нет',
    !P.proDetailsText(expiredQ, t, 'ru').includes('pro_daily'), P.proDetailsText(expiredQ, t, 'ru'));

  // Офлайн-грейс хранит последний известный счётчик без даты: подписывать его
  // «сегодня» нельзя.
  const offlineQ = P.proView({ plan: 'pro', paid_until: NOW + 30 * DAY, daily_used: 5, daily_limit: 1000, offline: true }, NOW);
  check('offline: строки pro_daily нет',
    !P.proDetailsText(offlineQ, t, 'ru').includes('pro_daily'), P.proDetailsText(offlineQ, t, 'ru'));

  const expired = P.proView({ plan: 'pro', paid_until: NOW - DAY }, NOW);
  check('expired: кнопка «продлить»', P.proActionLabel(expired, t) === 'pro_action_extend');
  check('expired: статус с предупреждением', P.proStatusText(expired, t) === 'pro_status_expired');

  const trial = P.proView({ plan: 'trial', paid_until: NOW + 12 * DAY }, NOW);
  check('trial: кнопка «купить»', P.proActionLabel(trial, t) === 'pro_action_buy');
  // Пробный период безлимитен: сервер отдаёт daily_limit = 0 — строки нет.
  check('trial безлимитный: строки pro_daily нет',
    !P.proDetailsText(trial, t, 'ru').includes('pro_daily'), P.proDetailsText(trial, t, 'ru'));

  // ТЕСТОВЫЙ токен (plan=trial в смысле «выдан тестировщику», 10 лет, без
  // лимита) обязан называться тестовым токеном, а не обратным отсчётом:
  // «осталось 3650 дн.» читалось бы как тариф, а «до 2036» — как обещание.
  const test = P.proView({ plan: 'trial', paid_until: NOW + 3650 * DAY, daily_limit: 0 }, NOW);
  check('тестовый без лимита: статус — words про отсутствие лимита',
    P.proStatusText(test, t) === 'pro_status_test', P.proStatusText(test, t));
  check('тестовый без лимита: срок токена не печатается',
    !P.proDetailsText(test, t, 'ru').includes('pro_until'), P.proDetailsText(test, t, 'ru'));
  // Если сервер когда-нибудь отдаст пробному периоду реальную квоту, экран
  // должен вернуться к отсчёту дней, а не врать про безлимит.
  const trialQuota = P.proView({ plan: 'trial', paid_until: NOW + 12 * DAY, daily_limit: 100 }, NOW);
  check('пробный период с квотой: статус — отсчёт дней',
    P.proStatusText(trialQuota, t) === 'pro_status_trial', P.proStatusText(trialQuota, t));
  check('пробный период с квотой: срок печатается',
    P.proDetailsText(trialQuota, t, 'ru').includes('pro_until'), P.proDetailsText(trialQuota, t, 'ru'));
  // Установочный токен (free) от тестового отличается словами и квотой —
  // три вида токена сервера (install/test/paid) обязаны сходиться с экраном.
  const install = P.proView({ plan: 'free', paid_until: NOW + 3650 * DAY, daily_limit: 100 }, NOW);
  check('установочный: статус — бесплатный тариф, не тестовый',
    P.proStatusText(install, t) === 'pro_status_free', P.proStatusText(install, t));
  check('установочный: деталей нет', P.proDetailsText(install, t, 'ru') === '');
}

// ── 3. Человеческие тексты ошибок ───────────────────────────────────────
console.log('3. ошибки');
{
  check('checkout_disabled → pro_err_disabled',
    P.proErrorText('checkout_disabled', t) === 'pro_err_disabled', P.proErrorText('checkout_disabled', t));
  check('device_limit → pro_err_devices',
    P.proErrorText('device_limit', t) === 'pro_err_devices', P.proErrorText('device_limit', t));
  check('неизвестная ошибка → общий текст с причиной',
    P.proErrorText('что-то странное', t) === 'pro_err_generic', P.proErrorText('что-то странное', t));
  check('в тексте есть исходная причина',
    P.proErrorText('что-то странное', tl).includes('что-то странное'),
    P.proErrorText('что-то странное', tl));
}

// ── 4. Сценарий покупки ─────────────────────────────────────────────────
console.log('4. buyPro');
{
  const calls = [];
  const toasts = [];
  const deps = (checkoutRes, verifyRes) => ({
    checkout: async (plan, months) => { calls.push(['checkout', plan, months]); return checkoutRes; },
    verify: async (id) => { calls.push(['verify', id]); return verifyRes; },
    refresh: async () => { calls.push(['refresh']); },
    toast: (m) => toasts.push(m),
    tr: tl,
  });

  // Успех: чекаут → верификация → обновление состояния → тост.
  let res = await P.buyPro(deps(
    { checkout_id: 'co_1' },
    { token: 'v2', plan: 'pro', paid_until: NOW + 365 * DAY },
  ));
  check('успех: ok=true', res.ok === true, res);
  check('успех: запрошен pro на 12 месяцев',
    calls[0][0] === 'checkout' && calls[0][1] === 'pro' && calls[0][2] === 12, calls);
  check('успех: верификация по checkout_id', calls[1][0] === 'verify' && calls[1][1] === 'co_1', calls);
  check('успех: состояние перечитано', calls.some((c) => c[0] === 'refresh'), calls);
  check('успех: тост об активации', toasts.length === 1 && toasts[0] === 'Pro активирован', toasts);

  // Ошибка чекаута: верификация не вызывается, пользователь видит причину.
  calls.length = 0; toasts.length = 0;
  res = await P.buyPro(deps({ error: 'checkout_disabled' }, { token: 'v2' }));
  check('ошибка чекаута: ok=false', res.ok === false, res);
  check('ошибка чекаута: верификация не вызвана', !calls.some((c) => c[0] === 'verify'), calls);
  check('ошибка чекаута: тост с причиной',
    toasts.length === 1 && toasts[0].includes('pro_err_disabled'), toasts);
  check('ошибка чекаута: тост объясняет, что делать',
    toasts.length === 1 && toasts[0].startsWith('Не удалось оформить покупку'), toasts);

  // Ошибка верификации («оплата ещё не подтверждена»).
  calls.length = 0; toasts.length = 0;
  res = await P.buyPro(deps({ checkout_id: 'co_1' }, { error: 'not_paid_yet' }));
  check('ошибка верификации: ok=false', res.ok === false, res);
  check('ошибка верификации: тост с причиной',
    toasts.length === 1 && toasts[0].includes('pro_err_notpaid'), toasts);
  check('ошибка верификации: состояние НЕ перечитывается',
    !calls.some((c) => c[0] === 'refresh'), calls);
}

// ── 5. Бейдж Pro в шапке чата ───────────────────────────────────────────
console.log('5. isProActive');
{
  check('нет состояния — бейджа нет', P.isProActive(null, NOW) === false);
  check('free — бейджа нет', P.isProActive({ plan: 'free' }, NOW) === false);
  // Free с будущим сроком — реальный случай: бесплатный токен тоже имеет
  // срок действия, и его paid_until сервер отдаёт в /tokens/info. Бейдж Pro
  // на бесплатном тарифе показываться не должен.
  check('free с будущим сроком — бейджа нет',
    P.isProActive({ plan: 'free', paid_until: NOW + DAY }, NOW) === false);
  check('оплаченный Pro — бейдж есть',
    P.isProActive({ plan: 'pro', paid_until: NOW + DAY }, NOW) === true);
  check('истёкший Pro — бейджа нет',
    P.isProActive({ plan: 'pro', paid_until: NOW - DAY }, NOW) === false);
  check('пробный период — бейдж есть (тариф оплаченного уровня)',
    P.isProActive({ plan: 'trial', paid_until: NOW + DAY }, NOW) === true);
  // Без явного времени — текущее: срок 1970 года не должен считаться активным.
  check('срок 1970 года не активен', P.isProActive({ plan: 'pro', paid_until: 1 }) === false);
}

// ── 6. Загрузка состояния подписки ──────────────────────────────────────
console.log('6. loadProState');
{
  const mk = (local, info) => {
    const put = [];
    return {
      put,
      deps: {
        localState: async () => local,
        info: async () => info,
        setState: (v) => put.push(v),
      },
    };
  };

  // Сервер ответил — его данные побеждают локальный кэш.
  let t = mk({ plan: 'free', paid_until: 0 }, { plan: 'pro', paid_until: NOW + DAY, devices: 2 });
  let st = await P.loadProState(t.deps);
  check('ответ сервера побеждает локальный кэш', st.plan === 'pro', st);
  check('состояние положено владельцу', t.put.length === 1 && t.put[0].plan === 'pro', t.put);
  check('при ответе сервера offline = false', st.offline === false, st);

  // Сервер недоступен — держим локальное состояние (офлайн-грейс).
  t = mk({ plan: 'pro', paid_until: NOW + DAY, offline: true }, null);
  st = await P.loadProState(t.deps);
  check('при недоступном сервере остаётся локальное состояние', st.plan === 'pro', st);
  check('локальное состояние сохраняется как есть', st.offline === true, st);

  // Сервер сказал «подписка истекла»: клиент обязан отбросить локальный
  // кэш, который ещё утверждает «Pro активен». Порядок вызовов важен —
  // ответ сервера приходит ПЕРВЫМ и сбрасывает кэш, поэтому после него
  // локальное состояние уже «free».
  const order = [];
  const put = [];
  st = await P.loadProState({
    localState: async () => { order.push('local'); return { plan: 'free', paid_until: 0 }; },
    info: async () => { order.push('info'); return { expired: true, plan: 'free' }; },
    setState: (v) => put.push(v),
  });
  check('сервер опрашивается первым', order[0] === 'info', order);
  check('истёкшая подписка сбрасывает локальный кэш', st.plan === 'free', st);

  // Ни локального состояния, ни сервера — пусто, но без падения.
  t = mk(null, null);
  st = await P.loadProState(t.deps);
  check('пустое состояние не ломает экран', st === null || st === undefined, st);
}

// ── 7. Канал поставки: сборка без покупок ───────────────────────────────
console.log('7. purchasesAllowed');
{
  // Play не платит разработчику с расчётного счёта в РФ и не терпит покупку
  // цифрового товара мимо своего биллинга, поэтому в play-сборке покупки нет.
  check('флаг VITE_NO_PURCHASES=1 закрывает покупку',
    P.purchasesAllowed({ VITE_NO_PURCHASES: '1' }) === false);
  check('без флага покупка открыта', P.purchasesAllowed({}) === true);
  check('пустое окружение — покупка открыта (дефолт не должен молча калечить релиз)',
    P.purchasesAllowed(undefined) === true);
  // «0» и пробелы — не «закрыто»: иначе опечатка в конфиге сборки убрала бы
  // монетизацию из сторовой сборки, а гейт бы об этом промолчал.
  check('VITE_NO_PURCHASES=0 — покупка открыта',
    P.purchasesAllowed({ VITE_NO_PURCHASES: '0' }) === true);
  check('VITE_NO_PURCHASES с пробелами вокруг 1 — покупка закрыта',
    P.purchasesAllowed({ VITE_NO_PURCHASES: ' 1 ' }) === false);

  // Страж — не только экран: вызов, пришедший не с кнопки, тоже обязан
  // отказать и НЕ создать платёжную сессию (реальный чекаут = деньги).
  const calls = [];
  const res = await P.buyPro({
    env: { VITE_NO_PURCHASES: '1' },
    checkout: async () => { calls.push('checkout'); return { checkout_id: 'co_x' }; },
    verify: async () => { calls.push('verify'); return { token: 'v2' }; },
    refresh: async () => { calls.push('refresh'); },
    toast: () => {},
    tr: tl,
  });
  check('сборка без покупок: ok=false', res.ok === false, res);
  check('сборка без покупок: причина — покупки отключены',
    res.error === 'purchases_disabled', res);
  check('сборка без покупок: ошибка имеет человеческий текст',
    P.proErrorText(res.error, t) === 'pro_err_disabled', P.proErrorText(res.error, t));
  check('сборка без покупок: платёжная сессия НЕ создана', calls.length === 0, calls);
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
