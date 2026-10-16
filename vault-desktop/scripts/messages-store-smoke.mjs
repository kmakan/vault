// Smoke-тест для messages-store.js (ADR-004, Этап J.7).
// owner состояния исчезающих сообщений: ephemeralTimers/ephemeralTick/
// currentEphemeralTtl. zero-import, no-ctx, isolated.
import { readFileSync } from 'node:fs';
import path from 'node:path';
const MODULE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'features', 'messages-store.js');
const src = readFileSync(MODULE_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  \u2713 ' + name); } else { fail++; console.log('  \u2717 ' + name); } }

console.log('\nADR-004 J.7 \u00b7 \u043c\u043e\u0434\u0443\u043b\u044c-\u0432\u043b\u0430\u0434\u0435\u043b\u0435\u0446 state ephemeral');

// 1. Zero-import gate
check('\u043d\u0435\u0442 \u0438\u043c\u043f\u043e\u0440\u0442\u043e\u0432 \u2014 \u043c\u043e\u0434\u0443\u043b\u044c \u043d\u0435 \u0437\u0430\u0432\u0438\u0441\u0438\u0442 \u043d\u0438 \u043e\u0442 \u0447\u0435\u0433\u043e',
  !/^\s*import\s/m.test(src) && !/^\s*require\s*\(/m.test(src));

// 2. No-ctx gate (strip комментарии + строки/регексы)
const body = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('\u043d\u0435\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u043a ctx', !/\bctx\b/.test(body));

// 3. State starts clean
const { createMessagesStore } = await import('file://' + MODULE_PATH);
const ms = createMessagesStore();
check('ephemeralTimers \u0441\u0442\u0430\u0440\u0442\u0435\u0435\u0442 {}', ms.state.ephemeralTimers && Object.keys(ms.state.ephemeralTimers).length === 0);
check('ephemeralTick \u0441\u0442\u0430\u0440\u0442\u0435\u0435\u0442 0', ms.state.ephemeralTick === 0);
check('currentEphemeralTtl \u0441\u0442\u0430\u0440\u0442\u0435\u0435\u0442 0', ms.state.currentEphemeralTtl === 0);

// 4. tick() + setCurrentTtl
ms.tick(); ms.tick();
check('tick() \u0438\u043d\u043a\u0440\u0435\u043c\u0435\u043d\u0442\u0438\u0440\u0443\u0435\u0442', ms.state.ephemeralTick === 2);
ms.setCurrentTtl(30);
check('setCurrentTtl \u043f\u0438\u0448\u0435\u0442', ms.state.currentEphemeralTtl === 30);
check('getCurrentTtl \u0447\u0438\u0442\u0430\u0435\u0442', ms.getCurrentTtl() === 30);

// 5. timer lifecycle (isolated: fake clock via clearTimer before fire)
ms.setTimer('k1', () => { check('\u0442\u0430\u0439\u043c\u0435\u0440 \u0440\u0430\u0431\u043e\u0442\u0430\u0435\u0442', true); }, 50);
check('hasTimer true', ms.hasTimer('k1'));
ms.clearTimer('k1');
check('clearTimer \u0443\u0434\u0430\u043b\u044f\u0435\u0442', !ms.hasTimer('k1'));

// 6. reset
ms.setCurrentTtl(99);
ms.state.ephemeralTick = 5;
ms.reset();
check('reset \u0447\u0438\u0441\u0442\u0438\u0442 \u0440\u0430\u0437', ms.state.ephemeralTick === 0 && ms.state.currentEphemeralTtl === 0
  && Object.keys(ms.state.ephemeralTimers).length === 0);

console.log('\n\u0418\u0422\u043e\u0433: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.error('FAIL'); process.exit(1); }
