// Node-смоук src/call-state-rule.js — адаптер над Rust-правилом звонка.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Адаптер тонкий, но в нём уже был баг: Tauri
// сопоставляет аргументы команды ПО ИМЕНИ, и JS слал `{ state, question }`
// тогда как команда в Rust объявлена как `(current, question)` — мост молча
// падал, а JS уходил в запасной путь («не начинать звонок»). Такие ошибки не
// видны в смоуках фичи: там мок отвечает на любую команду.
//
// ПРОВЕРЯЕМ: имена аргументов совпадают с объявлением команды; при отказе
// моста включается БЕЗОПАСНЫЙ запасной путь (звонок не начинаем, запрос
// игнорируем, отбой — call_cancel, поздний таймаут — игнорируем).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/call-state-rule-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const state = { calls: [], fail: false, answers: {} };
globalThis.__st = state;

writeFileSync(MOCKS + '/core.js', `
const st = globalThis.__st;
export const invoke = async (cmd, args) => {
  st.calls.push([cmd, args]);
  if (st.fail) throw new Error('мост недоступен');
  if (cmd in st.answers) return st.answers[cmd];
  return null;
};
`);

let src = readFileSync(path.join(ROOT, 'src', 'call-state-rule.js'), 'utf8');
src = src.replace("from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`);
writeFileSync(MOCKS + '/call-state-rule.mjs', src, 'utf8');

const R = await import(MOCKS + '/call-state-rule.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() { state.calls = []; state.fail = false; state.answers = {}; }
const lastArgs = () => (state.calls[state.calls.length - 1] || [])[1] || {};

// ── Имена аргументов совпадают с объявлением команды в Rust ──────────────
// Tauri сопоставляет по имени: `current` ≠ `state`. Расхождение не падает —
// команда получает пустые аргументы и падает ВНУТРИ, а JS уходит в запасной
// путь («звонок не начинаем»). Поэтому сверяем текст объявления.
{
  const bridge = readFileSync(path.join(ROOT, 'src-tauri', 'src', 'vault_bridge.rs'), 'utf8');
  const decl = (fn) => {
    const m = bridge.match(new RegExp('pub fn ' + fn + '\\(([^)]*)\\)'));
    return m ? m[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean) : [];
  };
  const expected = {
    vault_call_next_state: ['current', 'event'],
    vault_call_incoming_action: ['current', 'same_call', 'has_current'],
    vault_call_hangup_signal_kind: ['state'],
    vault_call_can: ['current', 'question'],
    vault_call_can_apply: ['current', 'event'],
  };
  for (const [fn, args] of Object.entries(expected)) {
    const got = decl(fn);
    ok('команда ' + fn + ' объявлена с теми же именами аргументов',
      JSON.stringify(got) === JSON.stringify(args), { got, args });
  }
}

// ── Адаптер зовёт мост с правильными именами ───────────────────────────
{
  reset();
  await R.callNextState('idle', 'accepted');
  ok('callNextState: current и event по именам',
    lastArgs().current === 'idle' && lastArgs().event === 'accepted', lastArgs());
}
{
  reset();
  await R.can('active', 'ignore_stale_timeout');
  ok('can: current и question по именам',
    lastArgs().current === 'active' && lastArgs().question === 'ignore_stale_timeout', lastArgs());
}
{
  reset();
  await R.incomingRequestAction('active', false, true);
  ok('incomingRequestAction: same_call и has_current по именам',
    lastArgs().same_call === false && lastArgs().has_current === true, lastArgs());
}

// ── Ответ моста доезжает до вызывающего ──────────────────────────────────
{
  reset();
  state.answers.vault_call_next_state = 'active';
  ok('callNextState отдаёт ответ моста', (await R.callNextState('outgoing_ringing', 'accepted')) === 'active');
  state.answers.vault_call_incoming_action = 'busy';
  ok('incomingRequestAction отдаёт ответ моста', (await R.incomingRequestAction('active', false, true)) === 'busy');
  state.answers.vault_call_hangup_signal_kind = 'call_end';
  ok('hangupSignalKind отдаёт ответ моста', (await R.hangupSignalKind('active')) === 'call_end');
  state.answers.vault_call_can = true;
  ok('can отдаёт ответ моста', (await R.can('active', 'apply_sdp')) === true);
}

// ── Отказ моста → БЕЗОПАСНЫЙ запасной путь ──────────────────────────────
{
  reset();
  state.fail = true;
  ok('can при отказе моста → false (не начинаем то, о чём не знаем)',
    (await R.can('idle', 'start_outgoing')) === false);
  ok('canApply при отказе моста → false',
    (await R.canApply('outgoing_ringing', 'accepted')) === false);
  ok('incomingRequestAction при отказе моста → ignore (не отвечаем «занято» вслепую)',
    (await R.incomingRequestAction('active', false, true)) === 'ignore');
  ok('hangupSignalKind при отказе моста → call_cancel (мягче, чем «разговор был»)',
    (await R.hangupSignalKind('active')) === 'call_cancel');
  ok('canStartOutgoing при отказе моста → false', (await R.canStartOutgoing('idle')) === false);
  ok('ignoreStaleRingTimeout при отказе моста → true (не рвём живой разговор)',
    (await R.ignoreStaleRingTimeout('active')) === true);
  // Состояние, отличное от 'active': иначе проверка совпала бы с мутацией
  // («состояние не меняется» и «стало active» дали бы один и тот же ответ).
  ok('callNextState при отказе моста → состояние не меняется',
    (await R.callNextState('outgoing_ringing', 'accepted')) === 'outgoing_ringing');
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
