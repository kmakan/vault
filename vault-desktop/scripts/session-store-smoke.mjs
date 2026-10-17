// Smoke-тест для session-store.js (ADR-004, Этап A12).
// framework-agnostic owner: zero imports, no ctx, isolation, login/logout,
// setEmails/clearEmails/emailCount. Без Vue/Tauri.
import { readFileSync } from 'node:fs';
import path from 'node:path';
const MODULE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'features', 'session-store.js');
const src = readFileSync(MODULE_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

console.log('\nADR-004 Этап A12 · модуль-владелец сессионного состояния');

// 1. Zero-import gate
check('нет НИ ОДНОГО импорта — модуль не зависит ни от чего, включая фреймворк',
  !/^\s*import\s/m.test(src) && !/^\s*require\s*\(/m.test(src));

// 2. No-ctx gate (в коде, не комментариях)
const body = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('нет доступа к ctx', !/\bctx\b/.test(body));

// 3. State starts clean
const { createSessionStore } = await import('file://' + MODULE_PATH);
const s1 = createSessionStore();
check('isLoggedIn стартует false', s1.state.isLoggedIn === false);
check('emails стартует пустым', JSON.stringify(s1.state.emails) === '[]');

// 4. Isolation
const s2 = createSessionStore();
s1.login();
check('изоляция — второй стор не видит первый', s2.state.isLoggedIn === false);

// 5. login/logout
s1.logout();
check('logout → isLoggedIn=false', s1.is() === false);
s1.login();
check('login → isLoggedIn=true', s1.is() === true);
check('login возвращает true', s1.login() === true);
check('logout возвращает false', s1.logout() === false);

// 6. setEmails/clearEmails
s1.setEmails(['a@b', 'c@d']);
check('setEmails пишет список', s1.state.emails.length === 2 && s1.emailCount() === 2);
check('setEmails(null) косячит в []', s1.emailCount() === 2 && s1.setEmails(null).length === 0 && s1.emailCount() === 0);
s1.setEmails(['x@y']);
check('emailCount считает', s1.emailCount() === 1);
s1.clearEmails();
check('clearEmails опустошает', JSON.stringify(s1.state.emails) === '[]' && s1.emailCount() === 0);

// 7. setEmails возвращает массив
check('setEmails возвращает state.emails', s1.setEmails(['m@n']) === s1.state.emails);

// 8. J.7: account password через владельца (быв. App.vue data this.password)
// recovery.js читает через ctx.password → теперь proxy → sessionStore.getPassword()
check('password стартует пустой', s1.getPassword() === '');
s1.setPassword('hunter2');
check('setPassword пишет', s1.getPassword() === 'hunter2');
check('setPassword возвращает значение', s1.setPassword('secret') === 'secret');
check('изоляция password — второй стор пуст', createSessionStore().getPassword() === '');
s1.clearPassword();
check('clearPassword сбрасывает в пустую строку', s1.getPassword() === '');
check('setPassword(null) → "" (не краш)', (s1.setPassword(null), s1.getPassword() === ''));

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
