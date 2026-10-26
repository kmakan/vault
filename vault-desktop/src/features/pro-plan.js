// Фича: платный тариф Pro — правила экрана и покупка (ADR-005 W3).
//
// ЗДЕСЬ — ЧИСТЫЕ ПРАВИЛА: как по состоянию подписки выглядит экран (текст,
// кнопка, срок, устройства) и как ответ сервера превращается в состояние.
// Сетевые вызовы — в примитиве relay-client.js, компонент только вызывает.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ МЕТОДЫ КОМПОНЕНТА. Экран покупки — это
// ПРАВИЛО («что показывать, когда подписка истекла»), а не поведение
// компонента. Правило должно быть одно: разбор состояния в трёх местах
// (настройки, заголовок чата, офлайн-грейс) обязан сходиться, иначе
// пользователь увидит «Pro активен» в одном месте и «релей в режиме Free»
// в другом.
//
// ГЛАВНОЕ ПРАВИЛО ЧЕСТНОСТИ. Экран НИКОГДА не обещает оплаченного: он
// показывает то, что подтвердил сервер (плюс офлайн-грейс на 7 дней, когда
// сервер недоступен). Клиент не решает, что «покупка прошла» — это решает
// сервер, опросив платёжного провайдера.
//
// deps (ADR-001 R3): всё, что нужно снаружи, — явными параметрами:
//   account          — аккаунт (KV и fingerprint);
//   checkout(plan, months) — создать платёжную сессию;
//   verify(checkoutId)     — подтвердить оплату и получить токен;
//   refresh()        — перечитать состояние подписки;
//   toast(msg) / tr(key, params) — обратная связь;
//   now()            — unix-секунды (в тестах — фиксированные);
//   locale           — код языка для даты;
//   env              — окружение сборки (по умолчанию import.meta.env; в
//                      тестах подставляется руками, чтобы проверить
//                      сборку без покупок).

export const PRO_KIND = {
  FREE: 'free',
  TRIAL: 'trial',
  ACTIVE: 'active',
  EXPIRED: 'expired',
};

export const PRO_PLAN = 'pro';
export const PRO_MONTHS = 12;
export const FREE_DAILY_LIMIT = 100;

// Три вида токена, которые различает СЕРВЕР (vault-relay tokens.rs: Kind), и
// экран обязан показывать их разными словами:
//   установочный (plan free)  — 100 конвертов/сутки, живёт 10 лет;
//   тестовый     (plan trial) — без суточного лимита; выдаётся промо-ключом
//                               или нами (gen_token --plan trial) тестировщикам
//                               и модераторам сторов;
//   платный      (plan pro/business) — квота тарифа (1000/10000), срок =
//                               оплаченный период.
// Слово «trial» в плане — историческое: это тестовый токен, а не пробный
// период подписки. Отсюда правило ниже: безлимит показывают словами про
// лимит, а не обратным отсчётом дней.

// ── Канал поставки: есть ли в сборке покупка ────────────────────────────
//
// Флаг сборки VITE_NO_PURCHASES=1. Play не платит разработчику с расчётным
// счётом в РФ и не позволяет покупать цифровые товары мимо своей биллинговой
// системы — в play-сборке не должно быть ни кнопки покупки, ни промо-ключа
// (ключ даёт безлимит бесплатно, то есть платную возможность мимо стора).
// Статус уже действующей подписки остаётся: показать то, что подтвердил
// сервер, — не предложение покупки.
//
// Почему правило в JS, а не в Rust (ADR-005): это упаковка фронта, а не
// протокол — значение знает только сборщик (vite подставляет import.meta.env
// на этапе сборки), и в мосте проверять нечего.
export function purchasesAllowed(env) {
  const e = env || (typeof import.meta !== 'undefined' ? import.meta.env : null) || {};
  return String(e.VITE_NO_PURCHASES || '').trim() !== '1';
}

// ── Состояние экрана ────────────────────────────────────────────────────
//
// pro: { plan, paid_until, offline, devices, max_devices, daily_used, daily_limit }
export function proView(pro, nowSec) {
  const st = pro || {};
  const plan = st.plan || 'free';
  const paidUntil = Number(st.paid_until) || 0;
  const now = Number(nowSec) || 0;
  const daysLeft = paidUntil > now ? Math.ceil((paidUntil - now) / 86400) : 0;
  let kind;
  if (plan === 'free') {
    kind = PRO_KIND.FREE;
  } else if (paidUntil > now) {
    kind = plan === 'trial' ? PRO_KIND.TRIAL : PRO_KIND.ACTIVE;
  } else {
    // План был, срок вышел — честно показываем «истёк», а не «active».
    kind = PRO_KIND.EXPIRED;
  }
  return {
    kind,
    plan,
    paidUntil,
    daysLeft,
    devices: Number(st.devices) || 0,
    maxDevices: Number(st.max_devices) || 0,
    dailyUsed: Number(st.daily_used) || 0,
    dailyLimit: Number(st.daily_limit) || 0,
    // Офлайн-грейс: сервер недоступен, но последнее подтверждение ещё в силе.
    offline: st.offline === true,
  };
}

// Дата подписки в читаемом виде. Локаль — из deps: правило даты не должно
// зависеть от языка, установленного где-то ещё.
export function proUntilText(view, locale) {
  if (!view || !view.paidUntil) return '';
  try {
    return new Date(view.paidUntil * 1000)
      .toLocaleDateString(locale || 'ru', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return new Date(view.paidUntil * 1000).toISOString().slice(0, 10);
  }
}

// ── Тексты экрана ───────────────────────────────────────────────────────
//
// Все ключи обязаны быть в ru/en/zh (гейт locale-keys-gate). Обратите
// внимание: приём `t('key') || 'запасной текст'` НЕ работает — t() возвращает
// сам ключ, а он непустая строка (см. комментарий гейта locale-keys-gate).
export function proStatusText(view, t) {
  if (!view) return '';
  switch (view.kind) {
    case PRO_KIND.TRIAL:
      // Тестовый токен безлимитен: сервер отдаёт daily_limit = 0. Его ценность
      // — «нет суточного лимита», а не обратный отсчёт: срок тестового токена
      // технический (10 лет), и «осталось 3650 дн.» читалось бы как тариф.
      // Отсчёт дней остаётся для пробного периода с реальной квотой — если
      // сервер когда-нибудь выдаст trial с лимитом, экран скажет правду.
      return view.dailyLimit === 0
        ? t('pro_status_test')
        : t('pro_status_trial', { days: view.daysLeft });
    case PRO_KIND.ACTIVE:
      // Дату выносим в отдельную строку (proDetailsText): в строке статуса
      // она превращалась бы в многострочный текст.
      return t('pro_status_active');
    case PRO_KIND.EXPIRED:
      return t('pro_status_expired');
    default:
      return t('pro_status_free', { limit: view.dailyLimit || FREE_DAILY_LIMIT });
  }
}

// Текст кнопки: у истёкшего тарифа — «Продлить», у активного — тоже
// (продление на год), у свободного и пробного — «Купить Pro».
export function proActionLabel(view, t) {
  if (!view) return t('pro_action_buy');
  return (view.kind === PRO_KIND.ACTIVE || view.kind === PRO_KIND.EXPIRED)
    ? t('pro_action_extend')
    : t('pro_action_buy');
}

// Срок и устройства — отдельной строкой (в строку статуса они не влезают).
export function proDetailsText(view, t, locale) {
  if (!view) return '';
  // Детали — только для оплаченных тарифов. У бесплатного строка «до <дата>»
  // означала бы срок бесплатного ТОКЕНА, а читалась как «бесплатно до 2036»:
  // срок оплаченного тарифа и срок технического токена — разные вещи, и
  // путать их нельзя. Число устройств у бесплатного тоже бессмысленно
  // (лимит устройств — свойство платной подписки).
  if (view.kind === PRO_KIND.FREE) return '';
  // У тестового токена срок ТЕХНИЧЕСКИЙ (10 лет), а не оплаченный период:
  // «до 26.10.2036» читалось бы как обещание тарифа. Признак тестового —
  // daily_limit = 0, который сервер отдаёт именно как «лимита нет».
  const testUnlimited = view.kind === PRO_KIND.TRIAL && view.dailyLimit === 0;
  const parts = [];
  if (view.paidUntil && !testUnlimited) {
    parts.push(t('pro_until', { date: proUntilText(view, locale) }));
  }
  if (view.maxDevices) {
    parts.push(t('pro_devices', { used: view.devices, max: view.maxDevices }));
  }
  // Суточная квота — только у действующего тарифа и только с живым ответом
  // сервера. У истёкшего релей уже работает по лимиту Free, и «0 из 1000»
  // читалось бы как остаток оплаченного. Офлайн-грейс хранит последний
  // известный счётчик без даты: подписывать его «сегодня» нельзя.
  // Безлимитный тариф сервер отдаёт как daily_limit = 0 — строки нет.
  if ((view.kind === PRO_KIND.ACTIVE || view.kind === PRO_KIND.TRIAL)
      && view.dailyLimit > 0 && !view.offline) {
    parts.push(t('pro_daily', { used: view.dailyUsed, limit: view.dailyLimit }));
  }
  return parts.join(' · ');
}

// ── Бейдж в шапке чата ──────────────────────────────────────────────────
//
// Отдельная чистая функция, чтобы правило «показывать бейдж Pro» не
// расходилось с правилом «что показывать в настройках»: обе смотрят на
// одно и то же состояние и решают по нему одинаково.
export function isProActive(state, nowSec) {
  if (!state) return false;
  const plan = state.plan || 'free';
  if (plan === 'free') return false;
  const paidUntil = Number(state.paid_until) || 0;
  // Без явного времени — текущее (секунды). Ноль как «сейчас» был бы
  // неверным: срок 1970 года считался бы активным.
  const now = nowSec === undefined ? Math.floor(Date.now() / 1000) : Number(nowSec);
  return paidUntil > now;
}

// ── Загрузка состояния подписки ─────────────────────────────────────────
//
// deps:
//   localState() — локально сохранённое состояние (офлайн-грейс);
//   info()       — ответ сервера /relay/tokens/info (null, если недоступен);
//   setState(v)  — положить состояние владельцу (relay-store).
export async function loadProState(deps) {
  // ПОРЯДОК ВАЖЕН: сначала сервер, потом локальное состояние. Ответ сервера
  // не только источник правды, но и сбрасывает локальный кэш, если подписка
  // истекла (fetchTokenInfo при 402 пишет plan=free). Если читать локальное
  // состояние ДО сервера, вернётся устаревшее «Pro активен» — ровно то,
  // что сервер только что опроверг.
  let info = null;
  try { info = await deps.info(); } catch (e) { info = null; }
  let st = null;
  try { st = await deps.localState(); } catch (e) { st = null; }
  const state = (info && !info.expired) ? { ...(st || {}), ...info, offline: false } : st;
  deps.setState(state);
  return state;
}

// ── Покупка ─────────────────────────────────────────────────────────────
//
// Ошибки сервера — в человеческие тексты. Сырые коды («checkout disabled»)
// пользователю показывать нельзя: они ничего не объясняют.
const ERROR_TEXTS = {
  checkout_disabled: 'pro_err_disabled',
  purchases_disabled: 'pro_err_disabled',
  already_active: 'pro_err_active',
  rate_limited: 'pro_err_rate',
  bad_plan_months: 'pro_err_plan',
  fp_mismatch: 'pro_err_fp',
  device_limit: 'pro_err_devices',
  not_paid_yet: 'pro_err_notpaid',
  network: 'pro_err_network',
  no_fp: 'pro_err_nofp',
};

export function proErrorText(error, t) {
  const key = ERROR_TEXTS[error] || 'pro_err_generic';
  return t(key, { why: error || '' });
}

// Купить/продлить Pro: чекаут → подтверждение оплаты → (сервер сам
// активирует токен на устройстве). Возвращает { ok, error }.
export async function buyPro(deps) {
  // Покупка закрыта и здесь, не только на экране: сборка без покупок не
  // должна уметь создать чекаут, даже если вызов пришёл не с кнопки.
  if (!purchasesAllowed(deps.env)) {
    return { ok: false, error: 'purchases_disabled' };
  }
  const res = await deps.checkout(PRO_PLAN, PRO_MONTHS);
  if (!res || res.error) {
    const why = (res && res.error) || 'network';
    deps.toast(deps.tr('pro_buy_failed', { why: proErrorText(why, deps.tr) }));
    return { ok: false, error: why };
  }
  const v = await deps.verify(res.checkout_id);
  if (!v || v.error) {
    const why = (v && v.error) || 'network';
    deps.toast(deps.tr('pro_buy_failed', { why: proErrorText(why, deps.tr) }));
    return { ok: false, error: why };
  }
  deps.toast(deps.tr('pro_buy_ok'));
  if (deps.refresh) await deps.refresh();
  return { ok: true, plan: v.plan, paidUntil: v.paid_until };
}
