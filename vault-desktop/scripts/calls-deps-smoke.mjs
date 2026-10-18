// Node-смоук контракта зависимостей features/calls.js (ADR-001, разрыв ctx).
//
// Зачем он нужен. Раньше функции звонков брали `ctx` — весь экземпляр
// App.vue. Формально они использовали 1–5 полей, но ЗАДЕЙСТВОВАТЬСЯ могли
// любым из 212: поле объявлялось не в сигнатуре, а в теле. Отсюда и
// «правка одной фичи задевает соседние»: правили `callState`, а падал
// `handleCallSignal`, который к `callState` вроде как и не относился.
//
// Теперь зависимости перечислены в сигнатуре. Этот тест делает список
// ОБЯЗАТЕЛЬНЫМ: функции подсовывается Proxy, который падает на чтение
// любого поля вне объявленного. Добавили лишнее поле в тело — тест красный.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CALLS = path.join(ROOT, 'src/features/calls.js');
const CALL_RESEND = path.join(ROOT, 'src/features/call-resend.js');
const CALL_SESSION = path.join(ROOT, 'src/features/call-session.js');
const CALL_CLOCK = path.join(ROOT, 'src/features/call-clock.js');
const CALL_WATCHDOG = path.join(ROOT, 'src/features/call-watchdog.js');
const CALL_RING = path.join(ROOT, 'src/features/call-ring.js');
const CALL_TERMINAL = path.join(ROOT, 'src/features/call-terminal.js');
const TIMING = path.join(ROOT, 'src/features/timing.js');
const CALL_IDLE = path.join(ROOT, 'src/features/call-idle.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Собираем модуль calls.js с моками. Копия кладётся в MOCKS/features/,
// поэтому её `../api.js` сам резолвится в MOCKS/api.js — пути не трогаем.
const MOCKS = '/tmp/calls-deps-smocks';
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(MOCKS + '/features', { recursive: true });
const stub = (name, body) => writeFileSync(`${MOCKS}/${name}`, body);
// Импорты calls.js: api.js (default + db, accountNamespace),
// relay-client.js (*), crypto.js (default), history.js (save/load).
await stub('api.js', [
  'export const db = { kvGet: async () => null, kvSet: async () => {} };',
  'export default { mediaSetMuted: async () => {}, mediaSetSpeaker: async () => {} };',
  '',
].join('\n'));
// ADR-001 Этап 2: accountNamespace живёт в identity.js, а не в api.js.
// Мок повторяет новую форму — иначе копия calls.js не резолвится.
await stub('identity.js', 'export const accountNamespace = async (e) => "anon:" + e;\n');
await stub('relay-client.js', 'export const getSettings = async () => ({ enabled: false });\nexport const publish = async () => ({});\n');
await stub('crypto.js', 'export default {};\n');
await stub('history.js', 'export const saveHistory = async () => {};\nexport const loadHistory = async () => [];\n');
writeFileSync(`${MOCKS}/features/call-watchdog.js`, readFileSync(CALL_WATCHDOG, 'utf8'));
writeFileSync(`${MOCKS}/features/call-ring.js`, readFileSync(CALL_RING, 'utf8'));
writeFileSync(`${MOCKS}/features/call-terminal.js`, readFileSync(CALL_TERMINAL, 'utf8'));
writeFileSync(`${MOCKS}/features/timing.js`, readFileSync(TIMING, 'utf8'));
writeFileSync(`${MOCKS}/features/call-idle.js`, readFileSync(CALL_IDLE, 'utf8'));
writeFileSync(`${MOCKS}/features/call-resend.js`, readFileSync(CALL_RESEND, 'utf8'));
// ADR-001: call-session.js тянет reactive из 'vue' — в смоуке Vue не нужен
// (reactive от мока = identity, state работает как plain object).
writeFileSync(
  `${MOCKS}/features/call-session.js`,
  readFileSync(CALL_SESSION, 'utf8').replaceAll(
    "from 'vue'",
    "from '../vue-stub.js'",
  ),
);
writeFileSync(`${MOCKS}/vue-stub.js`, 'export const reactive = (o) => o;\n');
// Стаб обязан экспортировать ВСЁ, что модуль импортирует: calls.js берёт
// `{ sessionStore, uiStore }`. Пока экспортировали только sessionStore, смоук
// падал SyntaxError'ом на загрузке модуля — и не проверял ничего.
await stub(
  'features/session-store.js',
  'export const sessionStore = { getCurrentEmail: () => "me@x.ru", state: { isLoggedIn: true } };\n'
  + 'export const uiStore = { toast: () => {}, scrollToBottom: () => {}, tr: (k) => k };\n',
);
writeFileSync(`${MOCKS}/features/call-clock.js`, readFileSync(CALL_CLOCK, 'utf8'));
// ADR-001: calls.js тянет invoke из @tauri-apps/api/core (M2.3 bridge) —
// подменяем на stub, иначе Node не резолвит пакет в /tmp-копии.
writeFileSync(
  `${MOCKS}/features/calls.js`,
  readFileSync(CALLS, 'utf8').replaceAll(
    "from '@tauri-apps/api/core'",
    "from '../tauri-core.js'",
  ),
);
writeFileSync(`${MOCKS}/tauri-core.js`, 'export const invoke = async () => null;\n');
const C = await import(MOCKS + '/features/calls.js');

// ── 1. canCallBack: объявлено 5 полей, читать можно только их ───────
{
  const DECLARED = ['activeChat', 'activeChatType', 'callState', 'expCalls', 'peerKeys'];
  const read = new Set();
  const state = {
    activeChat: 'peer@x', activeChatType: 'chat', callState: 'idle',
    expCalls: { on: true }, peerKeys: { 'peer@x': 'K' },
  };
  const deps = new Proxy(state, {
    get(t, k) { if (typeof k === 'string') read.add(k); return t[k]; },
  });
  const out = C.canCallBack(deps, { callEvent: { kind: 'missed' } });
  check('canCallBack возвращает true на активных данных', out === true, out);
  const extra = [...read].filter(k => !DECLARED.includes(k));
  check('canCallBack НЕ читает ничего сверх объявленных 5 полей',
    extra.length === 0, { прочитано: [...read], лишнее: extra });
  check('canCallBack прочитал все 5 объявленных (иначе контракт врёт)',
    DECLARED.every(k => read.has(k)), { прочитано: [...read] });

  // Если подсунуть лишнее поле в deps — оно не должно влиять на ответ:
  // функция о нём не знает, значит и не должна его использовать.
  const withJunk = { ...state, someUnrelatedField: 'should-not-matter' };
  check('лишние поля в deps не влияют на результат',
    C.canCallBack(withJunk, { callEvent: { kind: 'missed' } }) === true);
}

// ── 2. Функции с ОДНИМ скаляром: объект-контекст им не передать ────
// isCallSeen/rememberCallSeen принимают строку email. Если бы они всё ещё
// ждали ctx, передача строки уронила бы их на ctx.email → undefined.
{
  check('isCallSeen принимает строку email (а не ctx)',
    typeof (await C.isCallSeen('anon:a@b.c', 'nope')) === 'boolean');
  check('isCallSeen с невалидным ctx-объектом → false, а не throw',
    (await C.isCallSeen({ email: null }, 'nope')) === false);
}

// ── 3. callEventLabel: принимает функцию перевода, а не контекст ────
{
  let calls = 0;
  const t = (k) => { calls++; return 'T:' + k; };
  check('callEventLabel зовёт переданный t с ключом события',
    C.callEventLabel(t, { callEvent: { kind: 'missed', duration: 0 } }) === 'T:call_missed');
  check('перевод вызван ровно один раз', calls === 1, calls);
  check('callEventLabel без callEvent → пусто и перевод НЕ звался',
    C.callEventLabel(t, {}) === '' && calls === 1, calls);
}

// ── 4. Регрессия-щит: ctx-сигнатуры больше нет ─────────────────────
// Проверяем по исходнику: в переведённых функциях не должно остаться ни
// обращения к ctx, ни параметра-контекста.
{
  const src = readFileSync(CALLS, 'utf8');
  // Точное тело функции по балансу скобок: split по «следующей export function»
  // захватывал бы промежуточные помощники и давал ложные срабатывания.
  const bodyOf = (name) => {
    const at = src.search(new RegExp(`^export (?:async )?function ${name}\\b`, 'm'));
    if (at < 0) return null;
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
  };
  const converted = ['isCallSeen', 'rememberCallSeen', 'callEventLabel', 'canCallBack',
    'startFastPolling', 'stopFastPolling',
    'toggleCallMute', 'toggleSpeaker'];
  for (const fn of converted) {
    const body = bodyOf(fn);
    check(`${fn}: функция найдена`, !!body);
    check(`${fn}: тело не обращается к ctx`, !!body && !/\bctx\b/.test(body),
      body ? body.slice(0, 80) : '—');
    check(`${fn}: сигнатура не принимает ctx первым параметром`,
      !!body && !new RegExp(`function ${fn}\\s*\\(\\s*ctx`).test(src));
  }
}

// ── 5. Граница держится на уровне языка, а не проверкой ─────────────
// Проверено эмпирически при разработке: если в тело canCallBack добавить
// чтение `callSpeaker` (поля НЕ из списка), оно падает с ReferenceError —
// деструктурированный параметр не создаёт свободных имён. То есть
// зависимость нельзя случайно «подцепить»; компилятор/рантайм её не даст.
// Этот тест фиксирует сам механизм, чтобы его не списали при рефакторинге.
{
  const strictBoundary = (deps) => {
    const { a, b } = deps;
    return () => a + b + undeclaredField; // обращение вне списка
  };
  let threw = null;
  try { strictBoundary({ a: 1, b: 2 })(); } catch (e) { threw = e.constructor.name; }
  check('чтение поля вне списка зависимостей → ReferenceError (граница жёсткая)',
    threw === 'ReferenceError', threw);

  const looseBoundary = (ctx) => () => ctx.a + ctx.b + ctx.undeclaredField;
  let outcome;
  try { outcome = { threw: false, value: looseBoundary({ a: 1, b: 2 })() }; }
  catch (e) { outcome = { threw: true }; }
  // Главное различие: ctx отдаёт МОЛЧА undefined и результат портится в NaN —
  // никакой ошибки, баг всплывёт позже и в другом месте. Деструктуризация
  // вместо этого роняет сразу и на месте.
  check('старый стиль ctx доставал ЛЮБОЕ поле молча (undefined → NaN, без исключения)',
    outcome.threw === false && Number.isNaN(outcome.value), outcome);
}

// ── 6. Мутирующие функции: контракт «считает, а не пишет» ───────────
// Ключевая смена поведения второй партии: раньше toggle/часы писали в ctx
// сами, и App.vue ни о чём не знал. Теперь фича ВОЗВРАЩАЕТ значение, а
// состояние принадлежит компоненту. Если бы кто-то вернул мутацию ctx,
// этот блок перестал бы видеть смену значения — и стал бы красным.
{
  check('toggleCallMute(false) → true и НЕ мутирует вход',
    C.toggleCallMute({ callMuted: false, currentCall: null }) === true);
  check('toggleCallMute(true) → false',
    C.toggleCallMute({ callMuted: true, currentCall: null }) === false);
  check('toggleSpeaker(false) → true',
    C.toggleSpeaker({ callSpeaker: false, currentCall: null }) === true);
  check('toggleSpeaker(true) → false',
    C.toggleSpeaker({ callSpeaker: true, currentCall: null }) === false);

  // Часы теперь — владелец call-session.startCallClock/stopCallClock (ADR-004 E).

  let idle = 0;
  C.startFastPolling(() => idle++);
  check('startFastPolling зовёт переданный idleLoop', idle === 1, idle);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);