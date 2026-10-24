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

// Мок api: setAppIcon и kv. settings_flag играет РUST-сторону: правило
// дефолта здесь ЗАШИТО как заглушка ядра (проверяется проводка фронта), само
// правило меряют юнит-тесты vault-core::settings и живая проба на устройстве.
globalThis.__apiMock = {
  iconCalls: [],
  kv: {},
  setAppIcon: async (id) => { globalThis.__apiMock.iconCalls.push(id); },
};
writeFileSync(MOCKS + '/api.js', `
const m = globalThis.__apiMock;
const DEFAULT_ON = { 'exp-calls': true };
export const db = { kvSet: async (ns, k, v) => { m.kv[k] = v; } };
export const api = {
  setAppIcon: m.setAppIcon,
  settingsFlag: (name) => (m.flagStub
    ? m.flagStub(name)
    : (name in m.kv ? m.kv[name] === '1' : !!DEFAULT_ON[name])),
  settingsFlagSet: async (name, on) => { m.kv[name] = on ? '1' : '0'; return null; },
};
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
    iconId: '', expCalls: false, expVideo: false,
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
    setExpVideo: (v) => { s.expVideo = v; },
    expCalls: () => s.expCalls,
    expVideo: () => s.expVideo,
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

// ── Эксперимент «видео» (отдельный тумблер, по умолчанию выключен) ─────
{
  globalThis.__apiMock.kv = {};
  const deps = makeDeps();
  await S.onExperimentsVideo(deps, true);
  check('видео: включён только тумблер видео, звонки не тронуты',
    deps.s.expVideo === true && deps.s.expCalls === false, deps.s);
  check('видео: записан свой ключ',
    globalThis.__apiMock.kv['exp-video'] === '1' && !('exp-calls' in globalThis.__apiMock.kv),
    globalThis.__apiMock.kv);
  await S.onExperimentsVideo(deps, false);
  check('видео: выключен и сохранён',
    deps.s.expVideo === false && globalThis.__apiMock.kv['exp-video'] === '0', globalThis.__apiMock.kv);
}

// ── Стартовое чтение: фронт обязан слушать ответ Rust, а не свою догадку ──
{
  globalThis.__apiMock.kv = {};
  const deps = makeDeps();
  const got = await S.loadExperimentFlags(deps);
  check('чтение: звонки включены, пока записи нет (правило в Rust)',
    deps.s.expCalls === true && got.calls === true, deps.s);
  check('чтение: видео выключено, пока записи нет',
    deps.s.expVideo === false && got.video === false, deps.s);

  globalThis.__apiMock.kv = { 'exp-calls': '0', 'exp-video': '1' };
  const d2 = makeDeps();
  await S.loadExperimentFlags(d2);
  check('чтение: явный выбор пользователя важнее дефолта',
    d2.s.expCalls === false && d2.s.expVideo === true, d2.s);

  // Ошибку чтения мост превращает в null (см. api.settingsFlag), и фронт
  // обязан на null ничего не менять: иначе включённые звонки «пропадали» бы
  // молча при любом сбое чтения БД.
  globalThis.__apiMock.kv = { 'exp-calls': '1' };
  const broken = makeDeps();
  broken.s.expCalls = true;
  globalThis.__apiMock.flagStub = () => null;
  await S.loadExperimentFlags(broken);
  delete globalThis.__apiMock.flagStub;
  check('чтение: null-ответ моста не переписывает состояние',
    broken.s.expCalls === true, broken.s);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
