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
// Точная форма проверки: ищем `forwardTo:`-ЗАПИСЬ в объект, которая НЕ читает
// владельца (`this.forwardTo`). ПРЕЖНЯЯ регулярка (`/^\s+forwardTo:\s/m`) ловила
// АРГУМЕНТ вызова в forwardDeps() — `forwardTo: this.forwardTo, displayName: ...`
// — и краснела на здоровом коде: состояние уже в forwardState(), а App.vue лишь
// передаёт его в фичу. Ложное срабатывание, не дефект продукта (17.10).
const MANUAL_RE = /^[ \t]+forwardTo:[ \t]*([^\n]*)/gm;
const manualForwardTo = [...app.matchAll(MANUAL_RE)]
  .filter(m => !/this\.forwardTo/.test(m[1]));
check('в App.vue нет ручного владельца forwardTo (только чтение this.forwardTo)',
  manualForwardTo.length === 0, manualForwardTo.map(m => m[0].trim()).join(' | '));
// Анти-рот: детектор обязан ловить НАСТОЯЩЕЕ объявление поля (иначе проверка
// вырождена и пропустит возврат ручного владельца).
const fakeApp = 'data() {\n  return {\n    forwardTo: null,\n  };\n}';
check('анти-рот: детектор ручного forwardTo не вырожден',
  [...fakeApp.matchAll(MANUAL_RE)].filter(m => !/this\.forwardTo/.test(m[1])).length === 1);

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
