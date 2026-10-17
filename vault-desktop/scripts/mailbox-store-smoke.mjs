// Smoke-тест для mailbox-store.js (ADR-004, Этап J.3c).
// owner emails-loading state: emailsLoading/emailError. zero-import, no-ctx.
import { readFileSync } from 'node:fs';
import path from 'node:path';
const MODULE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'features', 'mailbox-store.js');
const src = readFileSync(MODULE_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  \u2713 ' + name); } else { fail++; console.log('  \u2717 ' + name); } }

console.log('\nADR-004 J.3c · модуль-владелец emails-loading state');

// 1. Zero-import gate
check('нет импортов — модуль не зависит ни от чего',
  !/^\s*import\s/m.test(src) && !/^\s*require\s*\(/m.test(src));

// 2. No-ctx gate
const body = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('нет доступа к ctx', !/\bctx\b/.test(body));

// 3. State starts clean
const { createMailboxStore } = await import('file://' + MODULE_PATH);
const ms = createMailboxStore();
check('emailsLoading стартует false', ms.state.emailsLoading === false);
check('emailError стартует пустой', ms.state.emailError === '');

// 4. setters
ms.setEmailsLoading(true);
check('setEmailsLoading пишет', ms.state.emailsLoading === true);
ms.setEmailError('fetch: nope');
check('setEmailError пишет', ms.state.emailError === 'fetch: nope');
check('setEmailsLoading(true) возвращает', ms.setEmailsLoading(true));

// 5. reset
ms.reset();
check('reset чистит', ms.state.emailsLoading === false && ms.state.emailError === '');

console.log('\nИтого: ' + pass + ' pass, ' + fail + ' fail');
if (fail) { console.error('FAIL'); process.exit(1); }
