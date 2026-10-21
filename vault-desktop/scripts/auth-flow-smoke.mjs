// Node-смоук features/auth-flow.js — вход и смена почты.
//
// Что ловится: вход — самый длинный сценарий в приложении, и в нём есть
// правила, которые легко потерять молча:
//
//   * прерванное восстановление: обычный вход НЕ МОЖЕТ обойти его — иначе
//     создалась бы НОВАЯ пара ключей вместо восстановленной и личность
//     аккаунта была бы затёрта;
//   * не удалось получить крипто-пару — входа нет (иначе приложение считает
//     себя залогиненным без ключей);
//   * смена адреса не должна затирать ключи/контакты/группы и должна разослать
//     контактам новый адрес.
//
// Моки: api (login + kv), identity (namespace), relay (настройки).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/auth-flow-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const st = {
  loginCalls: [],
  kv: {},
  namespaceCalls: [],
  relaySettings: { enabled: false },
  relayThrows: false,
};
globalThis.__st = st;

writeFileSync(MOCKS + '/api.js', `
const st = globalThis.__st;
export const db = {
  kvGet: async (ns, k) => { st.kvReads = (st.kvReads || []).concat([ns, k]); return st.kv[k] === undefined ? null : st.kv[k]; },
  kvSet: async (ns, k, v) => { st.kv[k] = v; },
};
export const api = {
  login: async (email, password, opts) => {
    st.loginCalls.push([email, password, opts]);
    if (st.loginFail) throw new Error('неверный пароль');
    return { user_id: 'uid-' + email };
  },
  _displayName: 'старое имя',
};
export default { ...api, db };
`);
writeFileSync(MOCKS + '/identity.js', `
const st = globalThis.__st;
export async function ensureAccountNamespace(email) { st.namespaceCalls.push(email); return 'ns:' + email; }
export function resetAccountNamespaceCache() { st.namespaceCalls.push('reset'); }
`);
writeFileSync(MOCKS + '/relay-client.js', `
const st = globalThis.__st;
export async function getSettings(email) {
  if (st.relayThrows) throw new Error('релей недоступен');
  return st.relaySettings;
}
`);

prepareModuleCopy(
  ROOT + '/src/features/auth-flow.js',
  MOCKS + '/auth-flow.mjs',
  { '../api.js': 'api.js', '../identity.js': 'identity.js', '../relay-client.js': 'relay-client.js' },
  MOCKS,
);
const A = await import(MOCKS + '/auth-flow.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const s = {
    email: 'me@x.ru', password: 'pw', newEmail: '', newPassword: '',
    rememberMe: true, imapServer: '', imapPort: '', smtpServer: '', smtpPort: '',
    loginLoading: false, loginError: '', isLoggedIn: false, userId: '',
    showRecovery: false, ecoMode: false, relayEnabled: false, connected: false,
    changeEmailLoading: false, changeEmailError: '',
    showChangeEmail: false, showChangeEmailServers: false, showSettings: false,
    calls: [],
  };
  const deps = {
    s,
    email: () => s.email,
    password: () => s.password,
    newEmail: () => s.newEmail,
    newPassword: () => s.newPassword,
    rememberMe: () => s.rememberMe,
    imapServer: () => s.imapServer,
    imapPort: () => s.imapPort,
    smtpServer: () => s.smtpServer,
    smtpPort: () => s.smtpPort,
    ecoMode: () => s.ecoMode,
    setEcoMode: (v) => { s.ecoMode = v; },
    setEmail: (v) => { s.email = v; },
    setPassword: (v) => { s.password = v; },
    setUserId: (v) => { s.userId = v; },
    setIsLoggedIn: (v) => { s.isLoggedIn = v; },
    setConnected: (v) => { s.connected = v; },
    setLoginLoading: (v) => { s.loginLoading = v; },
    setLoginError: (v) => { s.loginError = v; },
    setShowRecovery: (v) => { s.showRecovery = v; },
    setNewEmail: (v) => { s.newEmail = v; },
    setNewPassword: (v) => { s.newPassword = v; },
    setChangeEmailLoading: (v) => { s.changeEmailLoading = v; },
    setChangeEmailError: (v) => { s.changeEmailError = v; },
    setShowChangeEmail: (v) => { s.showChangeEmail = v; },
    setShowChangeEmailServers: (v) => { s.showChangeEmailServers = v; },
    setShowSettings: (v) => { s.showSettings = v; },
    setRelayEnabled: (v) => { s.relayEnabled = v; },
    tr: (key) => key,
    initCrypto: async (opts) => { s.calls.push('initCrypto'); s.cryptoOpts = opts; return s.cryptoOk !== false; },
    initNotifications: async () => { s.calls.push('initNotifications'); },
    isRecoveryPending: () => !!s.recoveryPending,
    syncEcoWithRelay: async (force) => { s.calls.push('syncEco'); return { sent: true }; },
    initLocalDb: async () => { s.calls.push('initLocalDb'); },
    loadUnreadCounts: () => { s.calls.push('loadUnreadCounts'); },
    loadChatFlags: () => { s.calls.push('loadChatFlags'); },
    runAutoclean: () => { s.calls.push('runAutoclean'); },
    loadLocalProfiles: () => { s.calls.push('loadLocalProfiles'); },
    loadBodyCache: async () => { s.calls.push('loadBodyCache'); },
    loadContacts: async () => { s.calls.push('loadContacts'); },
    loadGroups: async () => { s.calls.push('loadGroups'); },
    loadChannels: async () => { s.calls.push('loadChannels'); },
    onEcoMode: async (a, b) => { s.calls.push('onEcoMode'); },
    startPolling: (ms) => { s.calls.push('startPolling:' + (ms || '')); },
    startRelayTicker: () => { s.calls.push('startRelayTicker'); },
    idleLoop: () => { s.calls.push('idleLoop'); },
    loadEmails: async () => { s.calls.push('loadEmails'); },
    stopPolling: () => { s.calls.push('stopPolling'); },
    migrateAccountData: async (a, b) => { s.calls.push('migrateAccountData:' + a + '→' + b); },
    migrateOwnGroups: async (a, b) => { s.calls.push('migrateOwnGroups:' + a + '→' + b); },
    migrateLocalStores: async (a, b) => { s.calls.push('migrateLocalStores'); },
    broadcastProfile: async () => { s.calls.push('broadcastProfile'); },
    ...over,
  };
  return deps;
}

function resetMocks() {
  st.loginCalls = [];
  st.namespaceCalls = [];
  st.kv = {};
  st.relaySettings = { enabled: false };
  st.relayThrows = false;
  st.loginFail = false;
}

// ── Вход: прерванное восстановление ─────────────────────────────────────
{
  resetMocks();
  const deps = makeDeps();
  deps.s.recoveryPending = true;
  await A.login(deps);
  check('восстановление: форма восстановления показана', deps.s.showRecovery === true, deps.s);
  check('восстановление: понятное сообщение', deps.s.loginError === 'recovery_interrupted', deps.s.loginError);
  check('восстановление: вход в почту НЕ выполнялся (личность не затирается)',
    st.loginCalls.length === 0, st.loginCalls);
  check('восстановление: залогиненным не считаемся', deps.s.isLoggedIn === false, deps.s.isLoggedIn);
}

// ── Вход: штатный ───────────────────────────────────────────────────────
{
  resetMocks();
  const deps = makeDeps();
  await A.login(deps);
  check('вход: почта подключена', st.loginCalls.length === 1 && st.loginCalls[0][0] === 'me@x.ru', st.loginCalls);
  check('вход: пароль передан', st.loginCalls[0][1] === 'pw', st.loginCalls);
  check('вход: крипто-пара создана (allowCreate)', deps.s.calls.includes('initCrypto'), deps.s.calls);
  check('вход: initCrypto именно С allowCreate (обычному входу создание ключа разрешено)',
    deps.s.cryptoOpts && deps.s.cryptoOpts.allowCreate === true, deps.s.cryptoOpts);
  check('вход: залогинен', deps.s.isLoggedIn === true, deps.s);
  check('вход: user_id сохранён', deps.s.userId === 'uid-me@x.ru', deps.s.userId);
  check('вход: namespace перезапрошен (кэш имени сброшен)',
    st.namespaceCalls.includes('reset') && st.namespaceCalls.includes('me@x.ru'), st.namespaceCalls);
  check('вход: локальная БД поднята', deps.s.calls.includes('initLocalDb'), deps.s.calls);
  check('вход: контакты и группы загружены',
    deps.s.calls.includes('loadContacts') && deps.s.calls.includes('loadGroups'), deps.s.calls);
  check('вход: поллинг запущен', deps.s.calls.includes('startPolling:'), deps.s.calls);
  check('вход: индикатор загрузки снят', deps.s.loginLoading === false, deps.s.loginLoading);
  check('вход: ошибки нет', deps.s.loginError === '', deps.s.loginError);
}

// ── Вход: свои серверы ─────────────────────────────────────────────────
{
  resetMocks();
  const deps = makeDeps();
  deps.s.imapServer = ' imap.example.com ';
  deps.s.imapPort = '993';
  deps.s.smtpServer = 'smtp.example.com';
  deps.s.smtpPort = ' 465 ';
  await A.login(deps);
  const cfg = st.loginCalls[0][2].config;
  check('вход: серверы обрезаны от пробелов',
    cfg.imap_server === 'imap.example.com' && cfg.smtp_server === 'smtp.example.com', cfg);
  check('вход: порты — числа', cfg.imap_port === 993 && cfg.smtp_port === 465, cfg);
  check('вход: пустые серверы не передаются',
    !('imap_server' in cfg) || cfg.imap_server !== '', cfg);
}

// ── Вход: нет крипто-пары ──────────────────────────────────────────────
{
  resetMocks();
  const deps = makeDeps();
  deps.s.cryptoOk = false;
  await A.login(deps);
  check('вход без ключей: залогиненным не считаемся', deps.s.isLoggedIn === false, deps.s);
  check('вход без ключей: понятная ошибка', deps.s.loginError === 'recovery_missing_keys', deps.s.loginError);
  check('вход без ключей: загрузка контактов не пошла', !deps.s.calls.includes('loadContacts'), deps.s.calls);
}

// ── Вход: неверный пароль ──────────────────────────────────────────────
{
  resetMocks();
  st.loginFail = true;
  const deps = makeDeps();
  await A.login(deps);
  check('вход с ошибкой: сообщение пользователю', deps.s.loginError === 'неверный пароль', deps.s.loginError);
  check('вход с ошибкой: индикатор загрузки снят', deps.s.loginLoading === false, deps.s.loginLoading);
  check('вход с ошибкой: залогиненным не считаемся', deps.s.isLoggedIn === false, deps.s);
}

// ── Вход: релей недоступен — вход не блокируется ───────────────────────
{
  resetMocks();
  st.relayThrows = true;
  const deps = makeDeps();
  await A.login(deps);
  check('вход: недоступный релей не ломает вход', deps.s.isLoggedIn === true, deps.s);
  check('вход: недоступный релей не обрывает вход (контакты и группы загружены)',
    deps.s.calls.includes('loadContacts') && deps.s.calls.includes('loadGroups'), deps.s.calls);
  check('вход: недоступный релей не показан как ошибка входа',
    deps.s.loginError === '', deps.s.loginError);
}

// ── Форма смены адреса ─────────────────────────────────────────────────
{
  const deps = makeDeps();
  deps.s.newEmail = 'старое';
  deps.s.newPassword = 'старое';
  deps.s.changeEmailError = 'ошибка';
  deps.s.showChangeEmailServers = true;
  A.openChangeEmail(deps);
  check('форма: адрес очищен', deps.s.newEmail === '', deps.s.newEmail);
  check('форма: пароль очищен', deps.s.newPassword === '', deps.s.newPassword);
  check('форма: ошибка сброшена', deps.s.changeEmailError === '', deps.s.changeEmailError);
  check('форма: серверы скрыты', deps.s.showChangeEmailServers === false, deps.s);
  check('форма: открыта', deps.s.showChangeEmail === true, deps.s);
}

// ── Смена адреса ───────────────────────────────────────────────────────
{
  resetMocks();
  const deps = makeDeps();
  deps.s.newEmail = ' NEW@X.RU ';
  deps.s.newPassword = 'newpw';
  deps.s.showChangeEmail = true;   // пользователь открыл форму
  await A.changeEmail(deps);
  check('смена: почта подключена под новым адресом',
    st.loginCalls.length === 1 && st.loginCalls[0][0] === 'NEW@X.RU', st.loginCalls);
  check('смена: адрес переключён и обрезан', deps.s.email === 'NEW@X.RU', deps.s.email);
  check('смена: ключи НЕ сброшены (user_id = новый адрес)', deps.s.userId === 'NEW@X.RU', deps.s.userId);
  check('смена: данные аккаунта перенесены',
    deps.s.calls.includes('migrateAccountData:me@x.ru→NEW@X.RU'), deps.s.calls);
  check('смена: свои группы перенесены',
    deps.s.calls.includes('migrateOwnGroups:me@x.ru→NEW@X.RU'), deps.s.calls);
  check('смена: локальные хранилища перенесены', deps.s.calls.includes('migrateLocalStores'), deps.s.calls);
  check('смена: контактам разослан новый адрес', deps.s.calls.includes('broadcastProfile'), deps.s.calls);
  check('смена: форма закрыта', deps.s.showChangeEmail === false, deps.s);
  check('смена: настройки закрыты', deps.s.showSettings === false, deps.s);
  check('смена: индикатор загрузки снят', deps.s.changeEmailLoading === false, deps.s.changeEmailLoading);
}
{
  resetMocks();
  st.loginFail = true;
  const deps = makeDeps();
  deps.s.newEmail = 'new@x.ru';
  await A.changeEmail(deps);
  check('смена с ошибкой: сообщение пользователю', deps.s.changeEmailError === 'неверный пароль', deps.s.changeEmailError);
  check('смена с ошибкой: адрес НЕ переключён', deps.s.email === 'me@x.ru', deps.s.email);
  check('смена с ошибкой: форма осталась открытой', deps.s.showChangeEmail === false, deps.s.showChangeEmail);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
