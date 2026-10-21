// Node-смоук features/recovery-ui.js — экран восстановления.
//
// Что ловится: три вещи, каждая со своим «тихим» отказом:
//   * выбор файла восстановления — без него кнопка «Восстановить» не знает,
//     что восстанавливать;
//   * разбор причины отказа — серверы и почта в форме должны показаться
//     пользователю (иначе он видит «ошибка входа» и не понимает, что чинить);
//   * эскроу-письмо — предупреждение «Gmail удалит спам через 30 дней»
//     показывается 10 секунд, и это САМОЕ важное предупреждение приложения
//     (ключ восстановления без эскроу не восстановить).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/recovery-ui-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/recovery-ui.js',
  MOCKS + '/recovery-ui.mjs',
  {},
  MOCKS,
);
const R = await import(MOCKS + '/recovery-ui.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const s = {
    email: 'me@x.ru', apiEmail: 'saved@x.ru',
    fileJson: '', fileName: '',
    loginError: '', imapServer: '', imapPort: '', smtpServer: '', smtpPort: '',
    showServerSettings: false, mailProvider: '',
    toasts: [], escrow: [], located: [],
    restoreState: { loginError: 'err', imapServer: 'i', imapPort: '1', smtpServer: 's', smtpPort: '2', showServerSettings: true, mailProvider: 'gmail' },
  };
  const deps = {
    s,
    email: () => s.email,
    apiEmail: () => s.apiEmail,
    tr: (key) => key,
    toast: (msg, ms) => { s.toasts.push([msg, ms]); },
    setEmail: (v) => { s.email = v; },
    setLoginError: (v) => { s.loginError = v; },
    setImapServer: (v) => { s.imapServer = v; },
    setImapPort: (v) => { s.imapPort = v; },
    setSmtpServer: (v) => { s.smtpServer = v; },
    setSmtpPort: (v) => { s.smtpPort = v; },
    setShowServerSettings: (v) => { s.showServerSettings = v; },
    setMailProvider: (v) => { s.mailProvider = v; },
    setRecoveryFileJson: (v) => { s.fileJson = v; },
    setRecoveryFileName: (v) => { s.fileName = v; },
    buildRestoreFailureState: () => s.restoreState,
    sendEscrowEmail: async (email, mnemonic, key) => {
      s.escrow.push([email, mnemonic, key]);
      if (s.escrowFail) throw new Error('SMTP недоступен');
      return { spamToastKey: 'recovery_spam_toast', wrappedJson: '{"salt":"s"}' };
    },
    locateEscrow: (json) => { s.located.push(json); },
    ...over,
  };
  return deps;
}

// ── Выбор файла ────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await R.onRecoveryFilePicked(deps, { target: { files: [] } });
  check('файл: без файла — ничего не читаем', deps.s.fileJson === '' && deps.s.fileName === '', deps.s);
}
{
  const deps = makeDeps();
  await R.onRecoveryFilePicked(deps, { target: { files: [{ name: 'backup.json', text: async () => '{"k":"v"}' }] } });
  check('файл: содержимое прочитано', deps.s.fileJson === '{"k":"v"}', deps.s.fileJson);
  check('файл: имя сохранено', deps.s.fileName === 'backup.json', deps.s.fileName);
}

// ── Разбор причины отказа ──────────────────────────────────────────────
{
  const deps = makeDeps();
  R.showRestoreFailure(deps);
  check('отказ: сохранённый адрес подхвачен', deps.s.email === 'saved@x.ru', deps.s.email);
  check('отказ: сообщение об ошибке показано', deps.s.loginError === 'err', deps.s.loginError);
  check('отказ: серверы показаны в форме',
    deps.s.imapServer === 'i' && deps.s.imapPort === '1' && deps.s.smtpServer === 's' && deps.s.smtpPort === '2', deps.s);
  check('отказ: секция настроек показана (есть что показывать)', deps.s.showServerSettings === true, deps.s);
  check('отказ: провайдер восстановлен', deps.s.mailProvider === 'gmail', deps.s.mailProvider);
}
{
  const deps = makeDeps({ apiEmail: () => '' });
  R.showRestoreFailure(deps);
  check('отказ: без сохранённого адреса — текущий не теряется', deps.s.email === 'me@x.ru', deps.s.email);
}

// ── Эскроу-письмо ──────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await R.onRecoveryCreated(deps, { mnemonic: 'слово1 слово2 слово3' });
  check('эскроу: отправлен на наш адрес', deps.s.escrow.length === 1 && deps.s.escrow[0][0] === 'me@x.ru', deps.s.escrow);
  check('эскроу: слова переданы', deps.s.escrow[0][1] === 'слово1 слово2 слово3', deps.s.escrow[0][1]);
  check('эскроу: предупреждение о спаме показано', deps.s.toasts.length === 1, deps.s.toasts);
  check('эскроу: предупреждение держится 10 секунд', deps.s.toasts[0][1] === 10000, deps.s.toasts[0]);
  check('эскроу: папка письма ищется в фоне', deps.s.located.length === 1, deps.s.located);
}
{
  const deps = makeDeps();
  deps.s.escrowFail = true;
  await R.onRecoveryCreated(deps, { mnemonic: 'слово' });
  check('эскроу: сбой отправки — сообщение пользователю', deps.s.toasts.length === 1, deps.s.toasts);
  check('эскроу: при сбое папка не ищется', deps.s.located.length === 0, deps.s.located);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
