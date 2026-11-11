// ПДн: согласие и контракт «Данные и ПДн» (RuStore §5.2/§3.5, партия 12).
//
// Проверяется не «красиво ли описано», а свойства, которые теряются тихо:
//   · согласие спрашивается один раз и НЕ пускает в вход без себя;
//   · снятая галочка стирает сохранённое решение (иначе вход навсегда без вопроса);
//   · реквизиты оператора и адреса документов — данные, а не перевод: их нельзя
//     «потерять» при смене локали;
//   · битое/недоступное хранилище не роняет вход, а ведёт себя как «согласия нет».
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/pdn-notice-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
writeFileSync(MOCKS + '/pdn.mjs', readFileSync(path.join(ROOT, 'src', 'features', 'pdn-notice.js'), 'utf8'));
const P = await import(MOCKS + '/pdn.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };

// Переводчик, у которого часть ключей неизвестна — как настоящий t().
const t = (k) => ({
  settings_privacy_policy: 'Политика конфиденциальности',
  settings_pdn_doc_personal: 'Сведения об обработке ПДн',
  settings_terms_of_use: 'Условия использования',
  settings_pdn_support: 'Поддержка и жалобы',
  pdn_support_contact: 'Поддержка и жалобы',
  pdn_operator_name: 'ФИО',
  pdn_operator_inn: 'ИНН',
  pdn_operator_email: 'E-mail',
  pdn_operator_registry: 'Реестровый номер',
  pdn_operator_registered_at: 'Дата постановки на учёт',
  pdn_operator_notice: 'Уведомление',
  pdn_data_email: 'почта',
  pdn_data_contacts: 'контакты',
  pdn_data_pseudo: 'идентификаторы',
  pdn_data_payment: 'оплата',
  pdn_data_geo: 'геолокация',
  pdn_data_support: 'поддержка',
  pdn_consent_required: 'Сначала примите согласие',
}[k]);

// Хранилище-двойник localStorage: помнит записи, умеет падать по требованию.
function makeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}
const brokenStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
  removeItem() { throw new Error('denied'); },
};

console.log('\nRuStore §5.2/§3.5 · ПДн: согласие и контракт');

// ── Адреса документов и поддержки ─────────────────────────────────────
ok('политика — https', /^https:\/\//.test(P.PDN_LINKS.policy));
ok('сведения о ПДн — https', /^https:\/\//.test(P.PDN_LINKS.personalData));
ok('условия — https', /^https:\/\//.test(P.PDN_LINKS.terms));
ok('адреса документов РАЗНЫЕ (не копия одного)',
  new Set([P.PDN_LINKS.policy, P.PDN_LINKS.personalData, P.PDN_LINKS.terms]).size === 3);
ok('почта поддержки — vault-msg@ya.ru, а не несуществующий домен',
  P.PDN_SUPPORT_EMAIL === 'vault-msg@ya.ru');
ok('mailto собран из адреса', P.PDN_SUPPORT_MAILTO === 'mailto:vault-msg@ya.ru');

// ── Реквизиты оператора: данные, а не перевод ─────────────────────────
const fields = P.operatorFields(t);
ok('оператор: шесть реквизитов', fields.length === 6);
ok('в реквизитах есть ИНН', fields.some((f) => f.key === 'inn' && f.value === P.PDN_OPERATOR.inn));
ok('в реквизитах есть реестровый номер', fields.some((f) => f.key === 'registry' && f.value === P.PDN_OPERATOR.registry));
ok('дата постановки на учёт не потеряна', fields.some((f) => f.key === 'registeredAt' && f.value === P.PDN_OPERATOR.registeredAt));
ok('подписи берутся из перевода (ФИО ≠ ключ)', fields[0].label === 'ФИО');
ok('значения НЕ переводятся (ФИО — кириллицей из констант)',
  fields[0].value === P.PDN_OPERATOR.name);

// ── Категории обрабатываемых данных ───────────────────────────────────
const items = P.processedItems(t);
ok('категорий шесть', items.length === 6);
ok('порядок категорий: почта первой', items[0] === 'почта');
ok('геолокация названа (её спрашивают в сторе отдельно)', items.includes('геолокация'));
ok('нет пустых строк (неизвестный ключ не превращается в «undefined»)',
  items.every((s) => typeof s === 'string' && s.length > 0 && s !== 'undefined'));

// ── Документы на экране согласия ──────────────────────────────────────
const docs = P.consentDocs(t);
ok('на экране согласия два документа', docs.length === 2);
ok('первый документ — политика', docs[0].key === 'policy' && docs[0].url === P.PDN_LINKS.policy);
ok('второй — сведения о ПДн', docs[1].key === 'personalData' && docs[1].url === P.PDN_LINKS.personalData);
ok('подписи документов переведены (не ключи)',
  docs[0].label === 'Политика конфиденциальности' && docs[1].label === 'Сведения об обработке ПДн');

// ── Ссылки блока в настройках ─────────────────────────────────────────
const links = P.settingsLinks(t);
ok('ссылок две: сведения о ПДн и условия', links.length === 2);
ok('политика в блоке НЕ дублируется (она выше в разделе)',
  !links.some((l) => l.url === P.PDN_LINKS.policy));
ok('сведения о ПДн ведут на свою страницу',
  links.some((l) => l.key === 'personalData' && l.url === P.PDN_LINKS.personalData));
ok('условия ведут на свою страницу', links.some((l) => l.key === 'terms' && l.url === P.PDN_LINKS.terms));

// ── Контакт поддержки (§3.5: жалобы и модерация) ──────────────────────
const sup = P.supportLink(t);
ok('поддержка: mailto, а не сайт', sup.url === P.PDN_SUPPORT_MAILTO);
ok('поддержка: адрес показан явно', sup.email === 'vault-msg@ya.ru');
ok('поддержка: подпись переведена', sup.label === 'Поддержка и жалобы');

// ── Согласие: чтение ──────────────────────────────────────────────────
ok('нет хранилища → согласия нет', P.consentAccepted(null) === false);
ok('пустое хранилище → согласия нет', P.consentAccepted(makeStorage()) === false);
ok('записано «1» → согласие есть', P.consentAccepted(makeStorage({ [P.CONSENT_STORAGE_KEY]: '1' })) === true);
ok('любое другое значение — не согласие',
  P.consentAccepted(makeStorage({ [P.CONSENT_STORAGE_KEY]: 'true' })) === false);
ok('сломанное хранилище → согласия нет (безопасная сторона)',
  P.consentAccepted(brokenStorage) === false);

// ── Согласие: запись и снятие ─────────────────────────────────────────
{
  const s = makeStorage();
  ok('rememberConsent пишет «1»', P.rememberConsent(s) === true && s.getItem(P.CONSENT_STORAGE_KEY) === '1');
  ok('после записи согласие читается', P.consentAccepted(s) === true);
  ok('forgetConsent стирает запись', P.forgetConsent(s) === true && s.getItem(P.CONSENT_STORAGE_KEY) === null);
  ok('после снятия согласия нет', P.consentAccepted(s) === false);
}
ok('rememberConsent без хранилища — false', P.rememberConsent(null) === false);
ok('rememberConsent на сломанном хранилище — false, без исключения',
  P.rememberConsent(brokenStorage) === false);
ok('forgetConsent на сломанном хранилище — false, без исключения',
  P.forgetConsent(brokenStorage) === false);

// ── Согласие: решение пользователя ────────────────────────────────────
{
  const s = makeStorage();
  const seen = [];
  const deps = { storage: s, setConsent: (v) => seen.push(v) };
  ok('acceptConsent(true) → true', P.acceptConsent(deps, true) === true);
  ok('acceptConsent(true) записал решение', s.getItem(P.CONSENT_STORAGE_KEY) === '1');
  ok('acceptConsent(true) обновил состояние формы', seen[seen.length - 1] === true);
  ok('acceptConsent(false) → false', P.acceptConsent(deps, false) === false);
  ok('acceptConsent(false) СТЁР решение (иначе вход навсегда без вопроса)',
    s.getItem(P.CONSENT_STORAGE_KEY) === null);
  ok('acceptConsent(false) обновил состояние формы', seen[seen.length - 1] === false);
  ok('acceptConsent(0) — это «не принято»', P.acceptConsent(deps, 0) === false);
}

// ── loadConsent: состояние формы из хранилища ─────────────────────────
{
  let state = null;
  const withConsent = makeStorage({ [P.CONSENT_STORAGE_KEY]: '1' });
  ok('loadConsent: согласие есть → true', P.loadConsent({ storage: withConsent, setConsent: (v) => { state = v; } }) === true);
  ok('loadConsent положил true в состояние', state === true);
  state = null;
  ok('loadConsent: согласия нет → false', P.loadConsent({ storage: makeStorage(), setConsent: (v) => { state = v; } }) === false);
  ok('loadConsent положил false в состояние', state === false);
}

// ── loginWithConsent: без согласия входа нет ──────────────────────────
{
  let loginCalls = 0;
  let error = '';
  const runLogin = async () => { loginCalls++; return 'logged-in'; };
  const deps = {
    consentAccepted: () => false,
    setLoginError: (m) => { error = m; },
    tr: t,
    runLogin,
  };
  const r = await P.loginWithConsent(deps);
  ok('без согласия вход не выполнен', r === false);
  ok('без согласия сам вход НЕ вызван', loginCalls === 0);
  ok('без согласия показана причина', error === 'Сначала примите согласие');
}
{
  let loginCalls = 0;
  let error = 'прежняя';
  const deps = {
    consentAccepted: () => true,
    setLoginError: (m) => { error = m; },
    tr: t,
    runLogin: async () => { loginCalls++; return 'ok'; },
  };
  const r = await P.loginWithConsent(deps);
  ok('с согласием вход выполнен', r === 'ok' && loginCalls === 1);
  ok('с согласием ошибка не выставляется', error === 'прежняя');
}

console.log(`\nПДн-согласие: ${pass} ✓ / ${fail} ✗`);
if (fail) process.exit(1);
