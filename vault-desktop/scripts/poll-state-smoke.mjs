// Node-смоук контракта состояния фичи «Опросы» (ADR-001 Этап 1).
//
// Опросы — групповая фича: pollDialog открывает форму, pollTimer держит
// хендл таймера. Проверяем контракт, по которому check-template.cjs
// резолвит спред `...pollState()`, и что App.vue больше не объявляет эти
// поля вручную (иначе поле задвоится: спред + объявление).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'src/features/poll/state.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// 1. Контракт гейта: модуль поднимается в Node без браузерных API.
const src = readFileSync(STATE, 'utf8');
check('state.js не содержит import', !/^\s*import\s/m.test(src));

const { pollState } = await import(STATE);
check('экспортирует функцию pollState', typeof pollState === 'function');

// 2. Умолчания 1:1 с data() App.vue до выноса.
const s = pollState();
check('pollDialog = false (форма закрыта при старте)', s.pollDialog === false, s.pollDialog);
check('pollTimer = null (таймер не запущен)', s.pollTimer === null, s.pollTimer);
check('набор полей ровно 2', Object.keys(s).length === 2, Object.keys(s));

// 3. Нет общего состояния между вызовами.
const a = pollState(), b = pollState();
a.pollDialog = true;
a.pollTimer = 42;
check('мутация одного вызова не течёт в другой',
  b.pollDialog === false && b.pollTimer === null);

// 4. pollTimer — служебный хендл: фабрика обязана отдавать null, а не
//    «запомненный» таймер (иначе таймер одной сессии утечёт в другую).
check('pollTimer всегда null в свежей фабрике', pollState().pollTimer === null);

// 5. Модуль реэкспортирует фабрику, App.vue разворачивает спред.
const fsrc = readFileSync(path.join(ROOT, 'src/features/poll.js'), 'utf8');
check('poll.js реэкспортирует pollState', /export\s*\{\s*pollState\s*\}/.test(fsrc));
const app = readFileSync(path.join(ROOT, 'src/App.vue'), 'utf8');
check('App.vue разворачивает ...pollState()', /\.\.\.pollState\(\)/.test(app));
check('в App.vue не осталось ручного pollDialog:', !/^\s+pollDialog:\s/m.test(app));
check('в App.vue не осталось ручного pollTimer:', !/^\s+pollTimer:\s/m.test(app));

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
