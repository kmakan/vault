// Smoke-тест для relay-store.js (ADR-004, Этап A13).
// framework-agnostic owner: zero imports, no ctx, isolation, eco/relay/mode.
import { readFileSync } from 'node:fs';
import path from 'node:path';
const MODULE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'features', 'relay-store.js');
const src = readFileSync(MODULE_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

console.log('\nADR-004 Этап A13 · модуль-владелец relay-состояния');

check('нет НИ ОДНОГО импорта — модуль не зависит ни от чего, включая фреймворк',
  !/^\s*import\s/m.test(src) && !/^\s*require\s*\(/m.test(src));
const body = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('нет доступа к ctx', !/\bctx\b/.test(body));

const { createRelayStore } = await import('file://' + MODULE_PATH);
const s1 = createRelayStore();
check('ecoMode стартует false', s1.state.ecoMode === false);
check('relayEnabled стартует false', s1.state.relayEnabled === false);
check('relayDeliveryMode стартует relay', s1.state.relayDeliveryMode === 'relay');

const s2 = createRelayStore();
s1.enableEco();
check('изоляция — второй стор не видит первый', s2.state.ecoMode === false);

check('enableEco() → true', s1.enableEco() === true);
check('enableEco(false) → false', s1.enableEco(false) === false);
check('isEcoMode() читает', s1.isEcoMode() === false);

check('enableRelay() → true', s1.enableRelay() === true);
check('isRelayEnabled() читает', s1.isRelayEnabled() === true);
check('enableRelay(false) → false', s1.enableRelay(false) === false);

check('setRelayMode("relay")', s1.setRelayMode('relay') === 'relay');
check('deliveryMode() читает', s1.deliveryMode() === 'relay');
check('setRelayMode("email") возвращает email', s1.setRelayMode('email') === 'email');

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
