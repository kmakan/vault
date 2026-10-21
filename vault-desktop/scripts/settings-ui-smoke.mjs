// Node-смоук features/settings-ui.js — ручки настроек.
//
// Что ловится: «Другой (вручную)» в селекте провайдера должен ОЧИСТИТЬ поля
// серверов — иначе в форме остались бы серверы предыдущего провайдера, и
// пользователь вводил бы ручные настройки, а подключался к чужому серверу.
// Выбор иконки обязан пережить перезапуск (localStorage) и дойти до нативного
// окна. Эксперимент «звонки» — сохраняется в kv.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/settings-ui-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// Мок api: setAppIcon и kv.
globalThis.__apiMock = {
  iconCalls: [],
  kv: {},
  setAppIcon: async (id) => { globalThis.__apiMock.iconCalls.push(id); },
};
writeFileSync(MOCKS + '/api.js', `
const m = globalThis.__apiMock;
export const db = { kvSet: async (ns, k, v) => { m.kv[k] = v; } };
export const api = { setAppIcon: m.setAppIcon };
export default { ...api, db };
`);

prepareModuleCopy(
  ROOT + '/src/features/settings-ui.js',
  MOCKS + '/settings-ui.mjs',
  { '../api.js': 'api.js' },
  MOCKS,
);
const S = await import(MOCKS + '/settings-ui.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const s = {
    provider: 'gmail', imap: '', imapPort: '', smtp: '', smtpPort: '',
    iconId: '', expCalls: false,
    storageItems: {},
    favicon: { href: '' },
  };
  const deps = {
    s,
    mailProvider: () => s.provider,
    setMailProvider: (v) => { s.provider = v; },
    setImapServer: (v) => { s.imap = v; },
    setImapPort: (v) => { s.imapPort = v; },
    setSmtpServer: (v) => { s.smtp = v; },
    setSmtpPort: (v) => { s.smtpPort = v; },
    setAppIconId: (v) => { s.iconId = v; },
    setExpCalls: (v) => { s.expCalls = v; },
    storage: () => ({
      setItem: (k, v) => { s.storageItems[k] = v; },
      getItem: (k) => s.storageItems[k] || null,
    }),
    document: () => ({ querySelector: () => s.favicon }),
    ...over,
  };
  return deps;
}

// ── Провайдер ──────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  S.applyMailProvider(deps, 'gmail');
  check('провайдер: выбран сохранён', deps.s.provider === 'gmail', deps.s.provider);
  check('провайдер: серверы подставлены', deps.s.imap !== '' && deps.s.smtp !== '', deps.s);
}
{
  const deps = makeDeps();
  S.applyMailProvider(deps, 'custom');
  check('провайдер: «вручную» — поля не затираются (пользователь вводит свои)',
    deps.s.imap === '' && deps.s.imapPort === '', deps.s);
}
{
  const deps = makeDeps();
  deps.s.provider = 'custom';
  deps.s.imap = 'старый';
  deps.s.imapPort = '993';
  deps.s.smtp = 'старый-smtp';
  deps.s.smtpPort = '465';
  S.onMailProviderChange(deps);
  check('провайдер: «вручную» очищает поля (иначе подключимся к чужому серверу)',
    deps.s.imap === '' && deps.s.imapPort === '' && deps.s.smtp === '' && deps.s.smtpPort === '', deps.s);
}
{
  const deps = makeDeps();
  deps.s.provider = 'gmail';
  S.onMailProviderChange(deps);
  check('провайдер: обычный выбор подставляет серверы', deps.s.imap !== '' && deps.s.smtp !== '', deps.s);
}

// ── Иконка ─────────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  S.onAppIconChanged(deps, 'blue');
  check('иконка: выбрана', deps.s.iconId === 'blue', deps.s.iconId);
  check('иконка: сохранена (переживает перезапуск)', deps.s.storageItems['vault-icon'] === 'blue', deps.s.storageItems);
  check('иконка: favicon обновлён', String(deps.s.favicon.href).includes('vault-blue'), deps.s.favicon);
  check('иконка: нативное окно обновлено',
    globalThis.__apiMock.iconCalls.includes('blue'), globalThis.__apiMock.iconCalls);
}
{
  const deps = makeDeps({ document: () => ({ querySelector: () => null }) });
  S.onAppIconChanged(deps, 'red');
  check('иконка: без favicon в DOM — не падаем', deps.s.iconId === 'red', deps.s.iconId);
}

// ── Эксперимент «звонки» ───────────────────────────────────────────────
{
  const deps = makeDeps();
  await S.onExperimentsCalls(deps, true);
  check('эксперимент: включён', deps.s.expCalls === true, deps.s);
  check('эксперимент: сохранён в kv', globalThis.__apiMock.kv['exp-calls'] === '1', globalThis.__apiMock.kv);
  await S.onExperimentsCalls(deps, false);
  check('эксперимент: выключен и сохранён',
    deps.s.expCalls === false && globalThis.__apiMock.kv['exp-calls'] === '0', globalThis.__apiMock.kv);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
