// ПДн: информирование пользователя и согласие на обработку
// (RuStore §5.1 «Правовые условия», §5.2 «Сбор и использование данных»,
// §3.5 «Пользовательский контент»).
//
// МОДУЛЬ ЧИСТЫЙ: ни ctx, ни Vue, ни localStorage, ни импортов — всё, что нужно
// снаружи, приходит аргументом (ADR-001 R3). Переводчик t и хранилище storage —
// тоже аргументы (как в features/recovery-session.js).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ПРАВИЛО В App.vue/SettingsPage.
//   · Согласие — это ЗАПИСАННОЕ РЕШЕНИЕ пользователя: его надо показать один
//     раз, запомнить и не спрашивать again. Правило «показать/запомнить»
//     принадлежит фиче, а не компоненту: компонент только рисует.
//   · Категории обрабатываемых данных и реквизиты оператора — это КОНТРАКТ
//     перед магазином (§5.2 требует раскрыть категории и цели обработки, §3.5 —
//     контакты службы поддержки/модерации). Контракт лежит в одном месте,
//     чтобы экран входа и экран настроек не разошлись.
//
// ЧТО ЗДЕСЬ, А ЧТО НЕ ЗДЕСЬ.
//   · ЗДЕСЬ: адреса документов, реквизиты оператора, список категорий данных,
//     правило согласия (показать/запомнить/не пускать в вход без согласия).
//   · НЕ ЗДЕСЬ: вёрстка, состояние формы и переводы — они в компонентах и
//     локалях; сам вход делает features/auth-flow.js.
//
// ССЫЛКИ. Адреса документов — константы: они не меняются от пользователя и
// не должны приходить из настроек (как адрес поддержки в features/report-content.js).
export const PDN_LINKS = {
  // Политика конфиденциальности (RuStore §5.1 — доступна ВНУТРИ приложения).
  policy: 'https://vault-msg.ru/privacy.html',
  // Сведения об обработке персональных данных (§5.2).
  personalData: 'https://vault-msg.ru/pd.html',
  // Условия использования (§5.1).
  terms: 'https://vault-msg.ru/terms.html',
};

// Оператор персональных данных (ФЗ-152: кто обрабатывает данные и как с ним
// связаться). Реквизиты — ДАННЫЕ, а не текст интерфейса: они не переводятся
// и не меняются от пользователя, поэтому живут здесь, а не в локалях.
export const PDN_OPERATOR = {
  name: 'Козлов Максим Анатольевич',
  inn: '774338097699',
  email: 'vault-msg@ya.ru',
  registry: '168588/77',
  registeredAt: '10.11.2026',
  notice: '100494543',
};

// Служба поддержки и модерации (§3.5 требует контактов в приложении).
export const PDN_SUPPORT_EMAIL = 'vault-msg@ya.ru';
export const PDN_SUPPORT_MAILTO = 'mailto:' + PDN_SUPPORT_EMAIL;

// Ключ сохранённого согласия в localStorage. Версия в ключе: смена формулировки
// обязана спросить заново (старый текст согласия нельзя считать вечным).
export const CONSENT_STORAGE_KEY = 'vault-pdn-consent-v1';

// Категории обрабатываемых данных (RuStore §5.2: раскрыть категории и цели).
// Порядок здесь = порядок показа.
const PROCESSED_KEYS = [
  'pdn_data_email',
  'pdn_data_contacts',
  'pdn_data_pseudo',
  'pdn_data_payment',
  'pdn_data_geo',
  'pdn_data_support',
];

// Категории данных для экрана согласия (переводчик t — аргумент).
export function processedItems(t) {
  return PROCESSED_KEYS.map((key) => t(key));
}

// Документы, на которые ссылается экран согласия: подпись (переводится) и
// адрес (константа).
export function consentDocs(t) {
  return [
    { key: 'policy', label: t('settings_privacy_policy'), url: PDN_LINKS.policy },
    { key: 'personalData', label: t('settings_pdn_doc_personal'), url: PDN_LINKS.personalData },
  ];
}

// Ссылки блока «Данные и ПДн» в настройках. Политика конфиденциальности
// здесь НЕ повторяется — ссылка на неё уже есть в разделе «Приватность»
// (дубль — это шум, а не видимость).
export function settingsLinks(t) {
  return [
    { key: 'personalData', label: t('settings_pdn_doc_personal'), url: PDN_LINKS.personalData },
    { key: 'terms', label: t('settings_terms_of_use'), url: PDN_LINKS.terms },
  ];
}

// Контакт службы поддержки и модерации (§3.5): подпись, адрес и ссылка.
export function supportLink(t) {
  return {
    key: 'support',
    label: t('pdn_support_contact'),
    email: PDN_SUPPORT_EMAIL,
    url: PDN_SUPPORT_MAILTO,
  };
}

// Реквизиты оператора персональных данных: подпись (переводится) и значение
// (данные оператора).
export function operatorFields(t) {
  return [
    { key: 'name', label: t('pdn_operator_name'), value: PDN_OPERATOR.name },
    { key: 'inn', label: t('pdn_operator_inn'), value: PDN_OPERATOR.inn },
    { key: 'email', label: t('pdn_operator_email'), value: PDN_OPERATOR.email },
    { key: 'registry', label: t('pdn_operator_registry'), value: PDN_OPERATOR.registry },
    { key: 'registeredAt', label: t('pdn_operator_registered_at'), value: PDN_OPERATOR.registeredAt },
    { key: 'notice', label: t('pdn_operator_notice'), value: PDN_OPERATOR.notice },
  ];
}

// Принято ли согласие (localStorage). Нет хранилища — согласия нет: безопасная
// сторона (спросить лишний раз лучше, чем спросить и не спросить).
export function consentAccepted(storage) {
  if (!storage) return false;
  try {
    return storage.getItem(CONSENT_STORAGE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

// Запомнить согласие. Ошибка записи (приватный режим) — не повод ронять вход:
// согласие принято пользователем, просто не переживёт перезапуск.
export function rememberConsent(storage) {
  if (!storage) return false;
  try {
    storage.setItem(CONSENT_STORAGE_KEY, '1');
    return true;
  } catch (e) {
    return false;
  }
}

// Прочитать сохранённое согласие и положить его в состояние формы
// (deps.setConsent — владелец состояния).
export function loadConsent(deps) {
  const accepted = consentAccepted(deps.storage);
  deps.setConsent(accepted);
  return accepted;
}

// Снять согласие (пользователь убрал галочку): сохранённое решение обязано
// исчезнуть, иначе следующий запуск пустит в вход без вопроса — то есть
// отзыв согласия ничего не отзовёт.
export function forgetConsent(storage) {
  if (!storage) return false;
  try {
    storage.removeItem(CONSENT_STORAGE_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

// Пользователь поставил галочку: сохранить решение и обновить состояние формы.
// Снял галочку — решение отзывается, и следующая попытка входа снова спросит.
export function acceptConsent(deps, accepted) {
  const ok = !!accepted;
  if (ok) rememberConsent(deps.storage);
  else forgetConsent(deps.storage);
  deps.setConsent(ok);
  return ok;
}

// Вход без согласия не выполняется: экран входа показывает блок согласия, и
// пока пользователь его не принял, кнопка входа неактивна. Согласие спрашивают
// ОДИН раз, дальше решение помнит localStorage — поэтому ручной вход на уже
// согласившемся устройстве идёт без повторного вопроса.
//
// deps.runLogin — вызывающий (App.vue): сам вход делает features/auth-flow.js.
// Здесь только решение «пускать или нет».
export async function loginWithConsent(deps) {
  if (!deps.consentAccepted()) {
    deps.setLoginError(deps.tr('pdn_consent_required'));
    return false;
  }
  return deps.runLogin();
}
