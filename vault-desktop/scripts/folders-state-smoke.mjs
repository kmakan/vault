// Node-смоук контракта состояния фичи «Папки чатов» (ADR-001 Этап 1).
//
// Проверяем не логику папок (она в folders-smoke), а КОНТРАКТ, который
// check-template.cjs использует для резолва спреда `...foldersState()`:
//   * state.js не импортирует ничего (иначе гейт не поднимет его в Node);
//   * фабрика возвращает ровно ожидаемые поля с ожидаемыми умолчаниями;
//   * значения совпадают с теми, что были в data() App.vue до выноса.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STATE = path.join(ROOT, 'src/features/folders/state.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// 1. Контракт для гейта: модуль чистый (без import) — иначе check-template
//    упадёт с «localStorage is not defined» и перестанет проверять биндинги.
const src = readFileSync(STATE, 'utf8');
check('state.js не содержит import (гейт поднимает его в Node)',
  !/^\s*import\s/m.test(src));

const { foldersState } = await import(STATE);
check('экспортирует функцию foldersState', typeof foldersState === 'function');

// 2. Фабрика отдаёт объект, не мутирует общий синглтон.
const s1 = foldersState();
const s2 = foldersState();
check('возвращает объект', s1 && typeof s1 === 'object');
check('два вызова дают РАЗНЫЕ объекты (нет общего состояния)',
  s1 !== s2 && s1.activeFolder !== undefined || s1 !== s2);

// 3. Поля и умолчания — 1:1 с тем, что было в data() App.vue (ADR-001).
const expected = {
  activeFolder: '',
  folderDialogOpen: false,
  chatFolderNewName: '',
  chatFoldersNames: [],
};
const keys = Object.keys(s1).sort();
const expKeys = Object.keys(expected).sort();
check('набор полей совпадает', JSON.stringify(keys) === JSON.stringify(expKeys), { got: keys, want: expKeys });
for (const [k, v] of Object.entries(expected)) {
  // Object.is не годится для массивов (новый литерал !== старый) — глубокое.
  const same = Array.isArray(v)
    ? Array.isArray(s1[k]) && s1[k].length === v.length && s1[k].every((x, i) => x === v[i])
    : Object.is(s1[k], v);
  check(`  ${k} = ${JSON.stringify(v)}`, same, s1[k]);
}

// 4. Мутация одного экземпляра не задевает другой (иначе фичи делят состояние).
s1.activeFolder = 'Работа';
s1.chatFoldersNames.push('Личное');
check('мутация экземпляра не течёт в следующий вызов',
  foldersState().activeFolder === '' && foldersState().chatFoldersNames.length === 0);

// 5. computed-делегат в App.vue остаётся чистой функцией (сортировка на копии).
const F = await import(path.join(ROOT, 'src/features/folders/sort.js').replace(/sort\.js$/, 'state.js'))
  .catch(() => null);
// sortedFolderNames живёт в folders.js, который тянет api.js → в Node не поднимется.
// Проверяем его текстом: сортировка на копии, без мутации аргумента.
const fsrc = readFileSync(path.join(ROOT, 'src/features/folders.js'), 'utf8');
const m = fsrc.match(/export function sortedFolderNames\(names\) \{[\s\S]*?\n\}/);
check('sortedFolderNames есть в folders.js', !!m);
if (m) {
  check('sortedFolderNames сортирует на копии (.slice())', /\.slice\(\)/.test(m[0]), m[0]);
  check('sortedFolderNames не мутирует аргумент на месте', !/names\.sort\(/.test(m[0]), m[0]);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
