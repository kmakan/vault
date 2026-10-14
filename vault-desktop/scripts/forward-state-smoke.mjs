// Node-смоук контракта состояния фичи «Пересылка» (ADR-001 Этап 1).
//
// forwardTo — это пересылаемое сообщение ИЛИ null («пересылка не открыта»).
// UI читает его как флаг: `:show="!!forwardTo"`. Значит контракт критичен
// именно типом: null вместо false/undefined, иначе диалог откроется на
// пустом месте.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'src/features/forward/state.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// 1. Контракт гейта: модуль поднимается в Node без браузерных API.
const src = readFileSync(STATE, 'utf8');
check('state.js не содержит import', !/^\s*import\s/m.test(src));

const { forwardState } = await import(STATE);
check('экспортирует функцию forwardState', typeof forwardState === 'function');

// 2. Умолчание 1:1 с data() App.vue до выноса — и именно null.
const s = forwardState();
check('forwardTo = null', s.forwardTo === null, s.forwardTo);
check('forwardTo строго null (не false/undefined — иначе !!forwardTo откроет диалог)',
  s.forwardTo === null, typeof s.forwardTo);
check('набор полей ровно 1', Object.keys(s).length === 1, Object.keys(s));

// 3. Нет общего состояния между вызовами: пересылаемое сообщение одной
//    сессии не должно «протухать» в следующую.
const a = forwardState(), b = forwardState();
a.forwardTo = { id: 'm1', content: 'секрет' };
check('мутация одного вызова не течёт в другой', b.forwardTo === null);
check('!forwardTo === true на пустом состоянии (диалог закрыт)', !forwardState().forwardTo);

// 4. Модуль реэкспортирует фабрику, App.vue разворачивает спред.
const fsrc = readFileSync(path.join(ROOT, 'src/features/forward.js'), 'utf8');
check('forward.js реэкспортирует forwardState', /export\s*\{\s*forwardState\s*\}/.test(fsrc));
const app = readFileSync(path.join(ROOT, 'src/App.vue'), 'utf8');
check('App.vue разворачивает ...forwardState()', /\.\.\.forwardState\(\)/.test(app));
check('в App.vue не осталось ручного forwardTo:', !/^\s+forwardTo:\s/m.test(app));

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
