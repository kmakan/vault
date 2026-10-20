// Гейт мутационного тестирования.
//
// ЧТО ПРОВЕРЯЕТ. Обычный тест отвечает на вопрос «работает ли код». Этот
// гейт — на вопрос «А ТЕСТ ВООБЩЕ ЧТО-ТО ПРОВЕРЯЕТ?». Мы подставляем в
// модуль поломку и требуем, чтобы смоук покраснел. Мутация, на которой смоук
// остался зелёным, означает: этот кусок кода НЕ ПОКРЫТ.
//
// ПОЧЕМУ ЭТО ГЕЙТ, А НЕ СКРИПТ. 20.10.2026: за день мутации вскрыли девять
// слабых сценариев в разных фичах — и каждая молча оставляла фичу без
// настоящей проверки (проверка без своих данных, `|| true`, незначимое
// начальное значение, стенд, повторяющий НЕ поведение владельца, мутация не
// в той функции, эквивалентная мутация). Пока это был разовый ритуал в
// /tmp — наборы терялись, и ничто не мешало повторить.
//
// ПРАВИЛА:
//   * «выжившая» мутация (смоук зелёный) — ПРОВАЛ;
//   * мутация, которая НЕ ПРИМЕНИЛАСЬ (строка не найдена) — ПРОВАЛ: набор
//     устарел, и его надо чинить, а не молча пропускать;
//   * смоук, который ЗАВИС (таймаут) — ПРОВАЛ: тест не отработал;
//   * файлы модулей восстанавливаются побайтно (контроль — в движке).
//
// ЗАПУСК:
//   node scripts/mutation-gate.mjs             # все наборы
//   node scripts/mutation-gate.mjs --set keys  # один набор (быстрый цикл)
//   node scripts/mutation-gate.mjs --list      # что есть
import { runSet } from './mutations/engine.mjs';
import { loadAllSets, loadSets } from './mutations/index.mjs';

const args = process.argv.slice(2);
const only = args.includes('--set') ? args[args.indexOf('--set') + 1] : null;
const listOnly = args.includes('--list');

const sets = await loadAllSets();
if (listOnly) {
  for (const s of sets) console.log(`${s.id}: ${s.mutations.length} мутаций → ${s.smoke} (${s.file})`);
  process.exit(0);
}

const toRun = only ? sets.filter((s) => s.id === only) : sets;
if (!toRun.length) {
  console.error('✗ mutation-gate: набор не найден: ' + only);
  console.error('  есть: ' + sets.map((s) => s.id).join(', '));
  process.exit(1);
}

const t0 = Date.now();
let total = 0, caught = 0;
const survived = [];
const broken = [];

for (const set of toRun) {
  console.log(`\n▸ ${set.id}: ${set.mutations.length} мутаций → ${set.smoke}`);
  const res = runSet(set, { log: (m) => console.log(m) });
  total += res.total;
  caught += res.caught.length;
  for (const s of res.survived) survived.push(`${set.id}: ${s}`);
  for (const b of res.broken) broken.push(`${set.id}: ${b.name} — ${b.reason}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n=== ИТОГ: ${caught}/${total} мутаций поймано (${secs} c)`);

if (broken.length) {
  console.log('\n✗ СЛОМАННЫЕ МУТАЦИИ (набор устарел — чинить набор, а не пропускать):');
  for (const b of broken) console.log('  • ' + b);
}
if (survived.length) {
  console.log('\n✗ ВЫЖИВШИЕ МУТАЦИИ (смоук зелёный на сломанном коде — тест ничего не проверяет):');
  for (const s of survived) console.log('  • ' + s);
}
if (survived.length || broken.length) {
  console.log('\n  Мутационное тестирование — не «для галочки»: каждая выжившая');
  console.log('  мутация — это дырка в проверках, которую не найдёт ни один смоук.');
  process.exit(1);
}
console.log('✓ mutation-gate: все мутации пойманы, файлы восстановлены');
