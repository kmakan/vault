// Smoke-тест для mailbox-store.js (ADR-004, Этап J.3c).
// owner emails-loading state: emailsLoading/emailError. zero-import, no-ctx.
import { readFileSync } from 'node:fs';
import path from 'node:path';
const MODULE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'features', 'mailbox-store.js');
const src = readFileSync(MODULE_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  \u2713 ' + name); } else { fail++; console.log('  \u2717 ' + name); } }

console.log('\nADR-004 J.3c \u00b7 \u043c\u043e\u0434\u0443\u043b\u044c-\u0432\u043b\u0430\u0434\u0435\u043b\u0435\u0446 emails-loading state');

// 1. Zero-import gate
check('\u043d\u0435\u0442 \u0438\u043c\u043f\u043e\u0440\u0442\u043e\u0432 \u2014 \u043c\u043e\u0434\u0443\u043b\u044c \u043d\u0435 \u0437\u0430\u0432\u0438\u0441\u0438\u0442 \u043d\u0438 \u043e\u0442 \u0447\u0435\u0433\u043e',
  !/^\s*import\s/m.test(src) && !/^\s*require\s*\(/m.test(src));

// 2. No-ctx gate
const body = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('\u043d\u0435\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u043a ctx', !/\bctx\b/.test(body));

// 3. State starts clean
const { createMailboxStore } = await import('file://' + MODULE_PATH);
const ms = createMailboxStore();
check('emailsLoading \u0441\u0442\u0430\u0440\u0442\u0435\u0435\u0442 false', ms.state.emailsLoading === false);
check('emailError \u0441\u0442\u0430\u0440\u0442\u0435\u0435\u0442 \u043f\u0443\u0441\u0442\u044f ', ms.state.emailError === '');

// 4. setters
ms.setEmailsLoading(true);
check('setEmailsLoading \u043f\u0438\u0448\u0435\u0442', ms.state.emailsLoading === true);
ms.setEmailError('fetch: nope');
check('setEmailError \u043f\u0438\u0448\u0435\u0442', ms.state.emailError === 'fetch: nope');
check('setEmailsLoading(true) \u0432\u043e\u0437\u0432\u0440\u0430\u0449\u0430\u0435\u0442', ms.setEmailsLoading(true));

// 5. reset
ms.reset();
check('reset \u0447\u0438\u0441\u0442\u0438\u0442 \u0440\u0430\u0437', ms.state.emailsLoading === false && ms.state.emailError === '');

console.log('\n\u0418\u0422\u043e\u0433: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.error('FAIL'); process.exit(1); }
