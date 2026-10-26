// Node-смоук features/ephemeral.js + src/ephemeral-rule.js — исчезающие
// сообщения.
//
// ADR-005 W4 (`t_821261f7`): ПРАВИЛО времени жизни — в Rust. JS-часть:
// мост (ephemeral-rule.js) зовёт Rust-мост, фича — исполняет решение
// (взводит таймер, удаляет по истечении).
//
// Оракул: мок `vault_ephemeral_*` считает по формуле baseMs + ttlSecs*1000 —
// это ОРАКУЛ МОСТА (проверяем, что JS правильно зовёт и применяет ответ).
// Формула самого ядра проверяется отдельно, тестами Rust
// (vault_client::vault::ephemeral).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/ephemeral-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Мост Rust: оракул + управление отказом ──────────────────────────────
globalThis.__coreMock = {
  calls: [],
  fail: false,
  async invoke(cmd, args) {
    globalThis.__coreMock.calls.push([cmd, args]);
    if (globalThis.__coreMock.fail) throw new Error('мост недоступен');
    if (cmd === 'vault_ephemeral_expire_at') {
      const { baseMs, ttlSecs } = args;
      if (!ttlSecs || ttlSecs <= 0) return 0;
      return baseMs + ttlSecs * 1000;
    }
    if (cmd === 'vault_ephemeral_is_expired') {
      const { expiresAt, nowMs } = args;
      return expiresAt > 0 && nowMs >= expiresAt;
    }
    throw new Error('unexpected command ' + cmd);
  },
};
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__coreMock.invoke(...a);\n');
// api-мок (kv)
const _kv = new Map();
globalThis.__dbMock = {
  kvGet: async (ns, k) => (_kv.has(k) ? _kv.get(k) : null),
  kvSet: async (ns, k, v) => { _kv.set(k, v); },
};
writeFileSync(MOCKS + '/api.js', 'export const db = globalThis.__dbMock;\nexport default { db };\n');

// ── Копии модулей (примитив + фича) ──────────────────────────────────────
prepareModuleCopy(
  ROOT + '/src/ephemeral-rule.js',
  MOCKS + '/ephemeral-rule.mjs',
  { '@tauri-apps/api/core': 'core.js' },
  MOCKS,
);
prepareModuleCopy(
  ROOT + '/src/features/ephemeral.js',
  MOCKS + '/ephemeral.mjs',
  {
    '../api.js': 'api.js',
    '../ephemeral-rule.js': 'ephemeral-rule.mjs',
  },
  MOCKS,
);
const E = await import(MOCKS + '/ephemeral.mjs');
const Rule = await import(MOCKS + '/ephemeral-rule.mjs');
const { uiStore } = await import(ROOT + '/src/features/session-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Стенд ────────────────────────────────────────────────────────────────
const calls = { tomb: [], mid: [], hist: [], tick: 0, timers: [], cleared: [] };
const chat = {
  state: { messages: [] },
  set: (m) => { chat.state.messages = m; },
  removeById: (id) => {
    const i = chat.state.messages.findIndex((m) => m.id === id);
    if (i < 0) return false;
    chat.state.messages.splice(i, 1);
    return true;
  },
};
const messagesStore = {
  timers: new Map(),
  hasTimer(key) { return this.timers.has(key); },
  setTimer(key, fn, delay) { this.timers.set(key, fn); calls.timers.push([key, delay]); },
  clearTimer(key) { this.timers.delete(key); calls.cleared.push(key); },
  tick() { calls.tick++; },
};
const deps = {
  activeChat: () => calls.activeChat,
  activeChatType: () => calls.activeChatType || 'chat',
  currentGroup: () => calls.currentGroup || null,
  ephemeralOptions: () => [{ v: 300, label: '5 мин' }, { v: 3600, label: '1 час' }],
  setCurrentEphemeralTtl: (v) => { calls.ttl = v; },
  messagesStore,
  chat,
  addTombstone: (id) => calls.tomb.push(id),
  addMidTombstone: (mid) => calls.mid.push(mid),
  saveCurrentHistory: (k) => calls.hist.push(k),
};
function reset(over = {}) {
  _kv.clear();
  globalThis.__coreMock.calls.length = 0;
  globalThis.__coreMock.fail = false;
  calls.tomb = []; calls.mid = []; calls.hist = []; calls.timers = []; calls.cleared = [];
  calls.tick = 0; calls.ttl = null;
  calls.activeChat = 'peer@x.ru'; calls.activeChatType = 'chat'; calls.currentGroup = null;
  chat.state.messages = [];
  messagesStore.timers.clear();
  uiStore.setModal('showEphemeralMenu', false);
  Object.assign(calls, over);
}

// 1. Мост: expireAt зовёт Rust и берёт его ответ
console.log('1. Мост expireAt: ответ Rust без своей арифметики');
{
  reset();
  const e = await Rule.expireAt(1000, 60);
  check('expireAt: значение из Rust', e === 61000, e);
  const bridgeCall = globalThis.__coreMock.calls[0] || null;
  check('expireAt: команда Rust вызвана',
    bridgeCall !== null && bridgeCall[0] === 'vault_ephemeral_expire_at', globalThis.__coreMock.calls);
  check('expireAt: ttl<=0 — без похода в Rust', (await Rule.expireAt(1000, 0)) === 0 && globalThis.__coreMock.calls.length === 1);
}

// 2. Мост: отказ моста не роняет и не «истекает раньше срока»
console.log('2. Мост: отказ моста → безопасный откат');
{
  reset();
  globalThis.__coreMock.fail = true;
  let e = null;
  let bridgeThrew = null;
  try { e = await Rule.expireAt(1000, 60); } catch (err) { bridgeThrew = err; }
  check('expireAt: отказ моста → 0 (не исчезает)',
    bridgeThrew === null && e === 0, bridgeThrew ? String(bridgeThrew.message) : e);
  let expired = null;
  try { expired = await Rule.isExpired(61000, 99999); } catch (err) { expired = 'исключение'; }
  check('isExpired: отказ моста → false', expired === false, expired);
}

// 3. Мост: isExpired — решение Rust
console.log('3. Мост isExpired: решение Rust');
{
  reset();
  check('isExpired: истекло', (await Rule.isExpired(1000, 1000)) === true);
  check('isExpired: не истекло', (await Rule.isExpired(1000, 999)) === false);
  check('isExpired: без срока — false и без похода в Rust', (await Rule.isExpired(0, 999)) === false);
}

// 4. Подпись TTL: из списка опций или fallback
console.log('4. ephemeralLabel');
{
  reset();
  check('метка из опций', E.ephemeralLabel(deps, 300) === '5 мин');
  check('метка-фолбэк для неизвестного TTL', E.ephemeralLabel(deps, 42) === '42 c');
}

// 5. applyEphemeral: TTL сохраняется, модалка закрывается, тост показан
console.log('5. applyEphemeral');
{
  reset();
  uiStore.setModal('showEphemeralMenu', true);
  await E.applyEphemeral(deps, 300);
  check('TTL записан в kv', _kv.get('ephemeral:peer@x.ru') === '300', _kv.get('ephemeral:peer@x.ru'));
  check('модалка закрыта', uiStore.getModal('showEphemeralMenu') === false);
  check('текущий TTL обновлён', calls.ttl === 300);
  check('индикатор перерисован', calls.tick === 1);
}

// 6. applyEphemeral: чат «Заметки» — TTL не применяется
console.log('6. applyEphemeral: чат заметок — no-op');
{
  reset();
  calls.activeChat = '__notes__';
  await E.applyEphemeral(deps, 300);
  check('в заметках TTL не пишется', !_kv.has('ephemeral:__notes__'));
}

// 7. setEphemeralTtl: kv + перерисовка
console.log('7. setEphemeralTtl');
{
  reset();
  await E.setEphemeralTtl(deps, 'g1', 3600);
  check('TTL в kv', _kv.get('ephemeral:g1') === '3600');
  check('индикатор перерисован', calls.tick === 1);
}

// 8. scheduleEphemeral: таймер взводится на остаток времени
console.log('8. scheduleEphemeral: таймер');
{
  reset();
  const expiresAt = Date.now() + 5000;
  await E.scheduleEphemeral(deps, { id: 'm1', expiresAt, mid: 'mid1' }, 'peer@x.ru');
  check('таймер взведён', calls.timers.length === 1 && calls.timers[0][0] === 'peer@x.ru:m1', calls.timers);
  check('задержка ≈ остаток', calls.timers[0][1] > 3000 && calls.timers[0][1] <= 5000, calls.timers[0][1]);
  check('сообщение НЕ удалено до срока', calls.tomb.length === 0);
}

// 9. scheduleEphemeral: уже истёкшее (приложение было закрыто) → удаляем сразу
console.log('9. scheduleEphemeral: истёкшее при запуске → удалить сразу');
{
  reset();
  chat.state.messages = [{ id: 'm2' }];
  await E.scheduleEphemeral(deps, { id: 'm2', expiresAt: Date.now() - 1000, mid: 'mid2' }, 'peer@x.ru');
  check('tombstone поставлен', calls.tomb[0] === 'm2', calls.tomb);
  check('сообщение убрано', chat.state.messages.length === 0);
  check('таймер НЕ взведён', calls.timers.length === 0);
}

// 10. scheduleEphemeral: повторное взведение — no-op
console.log('10. scheduleEphemeral: повтор — no-op');
{
  reset();
  const expiresAt = Date.now() + 5000;
  await E.scheduleEphemeral(deps, { id: 'm3', expiresAt }, 'peer@x.ru');
  await E.scheduleEphemeral(deps, { id: 'm3', expiresAt }, 'peer@x.ru');
  check('таймер один', calls.timers.length === 1, calls.timers);
}

// 11. Истечение по таймеру: tombstone + удаление + история
console.log('11. Истечение по таймеру');
{
  reset();
  chat.state.messages = [{ id: 'm4' }];
  E.expireEphemeral(deps, 'peer@x.ru', 'm4', 'mid4');
  check('tombstone + mid-tombstone', calls.tomb[0] === 'm4' && calls.mid[0] === 'mid4', calls);
  check('сообщение убрано из списка', chat.state.messages.length === 0);
  check('история сохранена', calls.hist[0] === 'peer@x.ru', calls.hist);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
