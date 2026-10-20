// Гейт покрытия фич проверками (РАТЧЕТ).
//
// ЗАЧЕМ. «Смоуков 80» — число, которое ничего не значит, если часть фич не
// покрыта: модуль без смоука выглядит рабочим ровно до первого регресса.
// Так и случилось: features/duress.js и features/folders.js остались без
// смоука ПОВЕДЕНИЯ (были только смоуки модулей состояния/владельца) — и
// поломка в них прошла бы незамеченной. Второй пробел: смоук, который
// ничего не проверяет (мутация выживает) — мутационный гейт это видит, а
// список смоуков без наборов мутаций — нет.
//
// ПРАВИЛА (ратчет: ухудшаться нельзя, улучшаться можно):
//   1) у каждой features/*.js (верхний уровень) есть смоук, который её
//      поднимает; исключения — в списке EXEMPT с причиной;
//   2) у каждого смоука есть набор мутаций (scripts/mutations/sets/) — иначе
//      смоук может ничего не проверять, и мы об этом не узнаем;
//   3) набор мутаций ссылается на существующий смоук и файл.
//
// БЭКЛОГ (осознанно оставленные дыры) — в baseline-файле: он виден в отчёте
// и может только сокращаться.
//
// ЗАПУСК:
//   node scripts/feature-coverage-gate.mjs           # проверка
//   node scripts/feature-coverage-gate.mjs --write   # записать baseline
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FEATURES = path.join(ROOT, 'src', 'features');
const SCRIPTS = path.join(ROOT, 'scripts');
const SETS = path.join(SCRIPTS, 'mutations', 'sets');
const BASELINE = path.join(SCRIPTS, 'feature-coverage-baseline.json');

// Фичи, для которых смоук ПОВЕДЕНИЯ осознанно не написан.
// Причина обязательна: пустая строка — не причина.
const EXEMPT = new Map([
  ['duress/state.js', 'файл СОСТОЯНИЯ, а не фича; поведение проверяет duress-smoke'],
  ['poll/state.js', 'файл СОСТОЯНИЯ, а не фича; поведение проверяет poll-smoke'],
  ['forward/state.js', 'файл СОСТОЯНИЯ, а не фича; поведение проверяет forward-smoke'],
]);

// Смоуки, которые не являются «проверками фичи» (утилиты, приёмка устройства).
const SMOKE_EXEMPT = new Map([
  ['device-accept.mjs', 'живая приёмка на устройстве (не модульный смоук)'],
  ['boot-smoke.mjs', 'гейт рендера СОБРАННОГО приложения: мутация в исходнике видна '
    + 'только после пересборки (vite build), поэтому набор мутаций к нему бессмыслен; '
    + 'покрытие сборки — отдельная задача (мутационная проверка бандла)'],
]);

const featureFiles = readdirSync(FEATURES).filter((f) => f.endsWith('.js'));
const smokeFiles = readdirSync(SCRIPTS).filter((f) => f.endsWith('-smoke.mjs'));

const smokeSources = new Map();
for (const f of smokeFiles) {
  smokeSources.set(f, readFileSync(path.join(SCRIPTS, f), 'utf8'));
}

const problems = [];
const covered = [];
const uncovered = [];

for (const f of featureFiles) {
  const rel = 'features/' + f;
  if (EXEMPT.has(rel)) continue;
  const users = [...smokeSources.entries()]
    .filter(([name, src]) => !SMOKE_EXEMPT.has(name) && (src.includes(f) || src.includes('features/' + f)))
    .map(([name]) => name);
  if (users.length === 0) uncovered.push(rel);
  else covered.push({ feature: rel, smokes: users });
}

// Наборы мутаций: каждый должен ссылаться на существующие смоук и файл.
// ОТДЕЛЬНО ЖИВУТ наборы для RUST-ядра (scripts/rust-mutations/sets/): у них
// путь к файлу от корня РЕПОЗИТОРИЯ, а «смоук» — команда cargo. Их
// проверяет собственный гейт (scripts/rust-mutation-gate.mjs), а этот —
// считает только JS-наборы (пути и смоуки у них другие).
const setFiles = readdirSync(SETS).filter((f) => f.endsWith('.mjs'));
const mutationSmokes = new Set();
for (const f of setFiles) {
  const src = readFileSync(path.join(SETS, f), 'utf8');
  const id = (src.match(/id: '([^']+)'/) || [])[1] || f;
  const file = (src.match(/file: '([^']+)'/) || [])[1];
  const smoke = (src.match(/smoke: '([^']+)'/) || [])[1];
  if (!file || !existsSync(path.join(ROOT, file))) problems.push(`набор мутаций ${id}: файл не найден (${file})`);
  if (!smoke || !existsSync(path.join(SCRIPTS, smoke))) problems.push(`набор мутаций ${id}: смоук не найден (${smoke})`);
  if (smoke) mutationSmokes.add(smoke);
}

const withoutMutations = smokeFiles.filter((f) => !SMOKE_EXEMPT.has(f) && !mutationSmokes.has(f));

console.log('— Покрытие фич смоуками —');
for (const c of covered) console.log(`  ✓ ${c.feature} → ${c.smokes.join(', ')}`);
for (const u of uncovered) console.log(`  ✗ ${u} — НЕТ смоука`);
console.log(`\n  покрыто фич: ${covered.length}, без смоука: ${uncovered.length}`);
console.log('\n— Наборы мутаций —');
console.log(`  наборов: ${setFiles.length}, смоуков с набором: ${mutationSmokes.size}, без набора: ${withoutMutations.length}`);
if (withoutMutations.length) {
  console.log('  бэклог (смоуки без набора мутаций):');
  for (const f of withoutMutations) console.log('    • ' + f);
}

const current = {
  uncoveredFeatures: uncovered.slice().sort(),
  smokesWithoutMutations: withoutMutations.slice().sort(),
  exemptions: [...EXEMPT.entries()].map(([k, v]) => ({ feature: k, reason: v })),
};

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`\n✓ feature-coverage baseline записан: ${current.uncoveredFeatures.length} фич без смоука, ${current.smokesWithoutMutations.length} смоуков без набора мутаций`);
  process.exit(0);
}

// Ратчет: ухудшаться нельзя.
let base = { uncoveredFeatures: [], smokesWithoutMutations: [] };
if (existsSync(BASELINE)) base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const newUncovered = current.uncoveredFeatures.filter((x) => !(base.uncoveredFeatures || []).includes(x));
const newWithoutMut = current.smokesWithoutMutations.filter((x) => !(base.smokesWithoutMutations || []).includes(x));
const fixedUncovered = (base.uncoveredFeatures || []).filter((x) => !current.uncoveredFeatures.includes(x));
const fixedMut = (base.smokesWithoutMutations || []).filter((x) => !current.smokesWithoutMutations.includes(x));

if (fixedUncovered.length || fixedMut.length) {
  console.log('\n✓ покрытие улучшилось:');
  for (const x of fixedUncovered) console.log('  • появился смоук: ' + x);
  for (const x of fixedMut) console.log('  • появился набор мутаций: ' + x);
}

if (newUncovered.length || newWithoutMut.length || problems.length) {
  console.log('\n✗ feature-coverage-gate: покрытие ухудшилось.');
  for (const u of newUncovered) console.log('  • фича без смоука: ' + u);
  for (const f of newWithoutMut) console.log('  • смоук без набора мутаций: ' + f);
  for (const p of problems) console.log('  • ' + p);
  process.exit(1);
}
console.log('\n✓ feature-coverage-gate: покрытие не ухудшилось, наборы мутаций ссылаются на живые файлы');
