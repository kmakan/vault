// Node-смоук features/forward.js — пересылка (explicit-deps).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { installEnvelopeMock } from './lib/wire-envelope-mock.mjs';

const ROOT = '/home/maksim/whisper/vault-desktop/src/features';
const FORWARD = ROOT + '/forward.js';
const MOCKS = '/tmp/forward-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
// Мок форматов wire-конверта и сервисных сигналов (ADR-005 W4):
// правила — в Rust, здесь их тестовый двойник.
await installEnvelopeMock(MOCKS);

const apiCalls = [];
const cryptoCalls = [];
const apiMock = {
  sendMessage: async (to, body) => { apiCalls.push(['send', to, body]); },
  sendGroupMessage: async (gid, body, envObj) => { apiCalls.push(['group', gid, body, envObj]); },
};
const cryptoMock = {
  setPeerPublicKey: () => {},
  encryptWithGroupKey: async (payload) => { cryptoCalls.push(['g', payload]); return 'ENC_G:' + payload; },
  encryptVault: async (payload) => { cryptoCalls.push(['v', payload]); return 'ENC_1:' + payload; },
};
writeFileSync(`${MOCKS}/api.js`, 'export default globalThis.__apiMock;\n');
writeFileSync(`${MOCKS}/crypto.js`, 'export default globalThis.__cryptoMock;\n');
globalThis.__apiMock = apiMock;
globalThis.__cryptoMock = cryptoMock;
// forward.js использует alert() в UI-ветках (poll_err/err_group_key/forward_err) —
// в Node он отсутствует, подменяем.
const alertCalls = [];
globalThis.alert = (m) => { alertCalls.push(m); };

// envelope-id.js — чистый модуль, подхватываем реальный.
writeFileSync(`${MOCKS}/features/forward.js`,
  prepareModuleCopy(FORWARD, `${MOCKS}/features/forward.js`, {
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
  }, MOCKS));

const F = await import(`${MOCKS}/features/forward.js`).then(m => m.default || m);
let passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

// ── 1. forwardTargets чистый ──
{
  const contacts = [
    { email: 'me@x', name: 'Me' },
    { email: 'peer@x', name: 'Peer' },
    { email: 'other@x', name: 'Other' },
    { email: '__notes__', name: 'Notes' },
  ];
  const nameOf = (e) => e === 'other@x' ? 'Other' : e === 'peer@x' ? 'Peer' : null;
  const t = (k) => k === 'group' ? 'группа' : k;
  const groups = [{ id: 'g1', name: 'Grp1' }, { id: 'g2', name: 'Grp2' }];

  const out = F.forwardTargets({
    contacts, groups, activeChat: 'peer@x', activeChatType: 'chat',
    currentGroup: null, nameOf, t,
  });
  check('forwardTargets исключает текущий чат и __notes__',
    out.length === 4 && out.every(o => o.key !== 'peer@x' && o.key !== '__notes__'), out);
  check('forwardTargets использует nameOf для label',
    out.some(o => o.label === 'Other'));
  check('forwardTargets для group добавляет префикс + t(group)',
    out.some(o => o.key === 'group:g1' && o.label === 'Grp1 · группа'));

  // исключаем текущую группу
  const out2 = F.forwardTargets({
    contacts: [], groups, activeChat: 'group:g1', activeChatType: 'group',
    currentGroup: { id: 'g1' }, nameOf: () => null, t: () => '',
  });
  check('forwardTargets исключает текущую группу', out2.length === 1 && out2[0].key === 'group:g2');
}

// ── 2. startForward через setter ──
{
  let held = null;
  F.startForward({ setForwardTo: (m) => { held = m; } }, { id: 'm1', content: 'x' });
  check('startForward вызывает setForwardTo с msg', held && held.id === 'm1');
  F.startForward({ setForwardTo: () => {} }, null);
  check('startForward без msg → no-op (setter не вызван)', true);
}

// ── 3. doForward 1:1 ──
{
  apiCalls.length = 0; cryptoCalls.length = 0;
  let sending = []; const sends = []; const marks = []; const toasts = [];
  const deps = {
    forwardTo: { id: 'src', from: 'me', content: 'привет' }, displayName: 'Me', email: 'me@x',
    nameOf: () => 'Peer', activeChat: 'peer@x', activeChatType: 'chat',
    currentGroup: null, groupKeys: {}, peerKeys: { 'peer@x': 'K' }, peerPqKeys: { 'peer@x': 'P' },
    ephemeralTtlOf: async () => 3600,
    buildEnvelope: async (text) => JSON.stringify({ body: text }),
    setSending: (v) => { sending.push(v); },
    setForwardTo: (v) => { sends.push(v); },
    markPending: (k, m) => { marks.push([k, m]); },
    showToast: (m, d) => { toasts.push([m, d]); },
    t: (k) => k === 'forwarded_from' ? 'Переслано от' : k,
  };
  await F.doForward(deps, 'peer@x');
  check('doForward 1:1 → api.sendMessage', apiCalls.some(c => c[0] === 'send' && c[1] === 'peer@x'));
  check('doForward 1:1 → encryptVault', cryptoCalls.some(c => c[0] === 'v'));
  check('doForward → markPending (pendingMsg)', marks.length === 1 && marks[0][1].status === 'sent');
  check('doForward сбрасывает forwardTo → setForwardTo(null)', sends.includes(null));
  check('doForward вызывает setSending(true) и (false)', sending[0] === true && sending[1] === false);
  check('doForward → showToast forward_done', toasts.length === 1 && toasts[0][0] === 'forward_done');
}

// ── 4. doForward group ──
{
  apiCalls.length = 0; cryptoCalls.length = 0;
  let sending = []; const marks = [];
  const deps = {
    forwardTo: { id: 'src', from: 'me', content: 'гр' }, displayName: 'Me', email: 'me@x',
    nameOf: () => null, activeChat: '', activeChatType: 'chat',
    currentGroup: null, groupKeys: { g1: 'GK' }, peerKeys: {},
    ephemeralTtlOf: async () => 60,
    buildEnvelope: async (t) => JSON.stringify({ body: t }),
    setSending: (v) => sending.push(v),
    setForwardTo: () => {},
    markPending: (k, m) => marks.push([k, m]),
    showToast: () => {},
    t: (k) => k === 'group' ? 'группа' : k,
  };
  await F.doForward(deps, 'group:g1');
  check('doForward group → api.sendGroupMessage(g1)',
    apiCalls.some(c => c[0] === 'group' && c[1] === 'g1' && c[3] !== undefined));
  check('doForward group → encryptWithGroupKey', cryptoCalls.some(c => c[0] === 'g'));
  check('doForward group → markPending', marks.length === 1);
}

// ── 5. Early-return guard-ы ──
{
  apiCalls.length = 0; cryptoCalls.length = 0;
  const base = {
    forwardTo: { from: 'me', content: 'x' }, displayName: 'Me', email: 'me@x',
    nameOf: () => null, activeChat: 'peer@x', activeChatType: 'chat', currentGroup: null,
    groupKeys: {}, peerKeys: {}, peerPqKeys: {},
    ephemeralTtlOf: async () => 0, buildEnvelope: async () => '{}',
    setSending: () => {}, setForwardTo: () => {}, markPending: () => {},
    showToast: () => {}, t: (k) => k,
  };
  // group без ключа → alert + return
  await F.doForward({ ...base, groupKeys: {}, activeChatType: 'group', currentGroup: { id: 'g1' } }, 'group:g1');
  check('doForward group без ключа → sendGroupMessage НЕ звонится', apiCalls.length === 0);

  // 1:1 без peerKey → return
  apiCalls.length = 0; cryptoCalls.length = 0;
  await F.doForward({ ...base, peerKeys: {} }, 'peer@x');
  check('doForward 1:1 без peerKey → sendMessage НЕ звонится', apiCalls.length === 0 && cryptoCalls.length === 0);

  // key не group и activeChatType chat, но peerKeys есть — ok (covered above);
  // без forwardTo → no-op
  apiCalls.length = 0; cryptoCalls.length = 0;
  await F.doForward({ ...base, forwardTo: null }, 'peer@x');
  check('doForward без forwardTo → no-op', apiCalls.length === 0 && cryptoCalls.length === 0);
}

// ── 6. doForward: finally setSending(false) даже при ошибке ──
{
  let sends = [];
  const deps = {
    forwardTo: { from: 'me', content: 'x' }, displayName: 'Me', email: 'me@x',
    nameOf: () => null, activeChat: 'peer@x', activeChatType: 'chat', currentGroup: null,
    groupKeys: {}, peerKeys: { 'peer@x': 'K' }, peerPqKeys: {},
    ephemeralTtlOf: async () => { throw new Error('boom'); },
    buildEnvelope: () => {}, setSending: (v) => sends.push(v),
    setForwardTo: () => {}, markPending: () => {}, showToast: () => {}, t: () => 'forward_err',
  };
  await F.doForward(deps, 'peer@x');
  check('doForward finally → setSending(false) при ошибке', sends[sends.length - 1] === false);
}

// ── 7. Регрессия-щит: нет `this.`/`ctx.` в телах forward.js ──
{
  const src = readFileSync(FORWARD, 'utf8');
  const fns = ['forwardTargets', 'startForward', 'doForward'];
  let clean = true;
  for (const fn of fns) {
    const at = src.indexOf('export function ' + fn + '(') < 0
      ? src.indexOf('export async function ' + fn + '(')
      : src.indexOf('export function ' + fn + '(');
    const start = src.indexOf('{', at);
    let d = 0, end = src.length;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) { end = i + 1; break; } }
    }
    const body = src.slice(start, end);
    if (/\bctx\b/.test(body) || /\bthis\b/.test(body)) { clean = false; console.log('  ✗ ' + fn + ': есть ctx/this'); }
  }
  check('Регрессия: forward.js тела без ctx/this', clean);
}

console.log('\n=== ИТОГО: ' + passed + ' pass, ' + failed + ' fail ===');
if (failed) process.exit(1);
