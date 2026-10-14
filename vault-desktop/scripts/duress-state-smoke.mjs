// Node-смоук контракта состояния фичи «Duress» (ADR-001 Этап 1).
//
// Duress — security-critical: duress-PIN открывает ДЕКОЙ-режим вместо
// настоящих чатов, panic-PIN стирает данные. Поэтому тут проверяем не
// «работает ли», а КОНТРАКТ, который обязан остаться неизменным:
//
//  * state.js чистый (без import) — иначе check-template.cjs не поднимет
//    его в Node и перестанет проверять биндинги фичи;
//  * умолчания ровно те, что были в data() App.vue до выноса;
//  * duressUnlockedThisSession сбрасывается в false на каждом запуске
//    (иначе декой пережил бы перезапуск и перестал бы защищать);
//  * фабрика не возвращает общий синглтон (фичи не делят состояние).
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'src/features/duress/state.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// 1. Контракт гейта: модуль должен подниматься в Node без браузерных API.
const src = readFileSync(STATE, 'utf8');
check('state.js не содержит import (гейт поднимает его в Node)',
  !/^\s*import\s/m.test(src));

const { duressState } = await import(STATE);
check('экспортирует функцию duressState', typeof duressState === 'function');

// 2. Умолчания 1:1 с data() App.vue до выноса.
const s = duressState();
check('duressLocked = false (обычный режим, не декой)', s.duressLocked === false, s.duressLocked);
check('duressPending = false (тихий SOS не в работе)', s.duressPending === false, s.duressPending);
check('duressUnlockedThisSession = false (декой требует PIN заново)', s.duressUnlockedThisSession === false, s.duressUnlockedThisSession);
check('набор полей ровно 3', Object.keys(s).length === 3, Object.keys(s));

// 3. Безопасность: декой не должен «переживать» перезапуск — то есть фабрика
//    обязана выдавать СВЕЖИЙ незакрытый декой каждый раз.
const a = duressState(), b = duressState();
check('два вызова дают разные объекты (нет общего состояния)', a !== b);
a.duressUnlockedThisSession = true;
a.duressLocked = true;
check('изменение прошлого вызова не влияет на новый (декой не переживает «рестарт»)',
  b.duressUnlockedThisSession === false && b.duressLocked === false);

// 4. Логика duress по-прежнему живёт в модуле и импортирует фабрику наружу.
const fsrc = readFileSync(path.join(ROOT, 'src/features/duress.js'), 'utf8');
check('duress.js реэкспортирует duressState', /export\s*\{\s*duressState\s*\}/.test(fsrc));

// 5. App.vue разворачивает спред (иначе состояние не попадёт в data()).
const app = readFileSync(path.join(ROOT, 'src/App.vue'), 'utf8');
check('App.vue разворачивает ...duressState()', /\.\.\.duressState\(\)/.test(app));
check('в App.vue не осталось ручного объявления duressLocked:',
  !/^\s+duressLocked:\s/m.test(app));

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
