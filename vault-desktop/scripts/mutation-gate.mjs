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
//   node scripts/mutation-gate.mjs --check-patterns  # наборы ещё находят свой код
import { runSet, recoverJournal, recoverForeignJournal, foreignJournal, setJournalOwner } from './mutations/engine.mjs';
import { loadAllSets, loadSets } from './mutations/index.mjs';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

setJournalOwner('js');

const args = process.argv.slice(2);
const only = args.includes('--set') ? args[args.indexOf('--set') + 1] : null;
const listOnly = args.includes('--list');

// «Набор ещё меряет?» без смоуков — секунды. Паттерн мутации это контракт с
// ФОРМОЙ кода: рефакторинг или переезд решения между функциями обрывают его
// молча, набор теряет проверки и остаётся зелёным на том, что ещё находит
// (25.10 — rust-relay-limit: 7 из 16 мутаций не применялись после d12853f).
// Отдельный режим потому, что чинить тут надо набор, а не код и не тест.
if (args.includes('--check-patterns')) {
  const root = path.resolve(import.meta.dirname, '..');
  const journalDir = '/tmp/vault-mutation-journal';
  const busy = existsSync(journalDir)
    ? readdirSync(journalDir).filter((x) => x.endsWith('.bak'))
    : [];
  if (busy.length) {
    console.error('✗ mutation-gate: идёт прогон гейта (журнал не пуст) — по мутанту паттерны не сверяют');
    process.exit(1);
  }
  const sets = await loadAllSets();
  let checked = 0;
  const missing = [];
  const ambiguous = [];
  const cache = new Map();
  for (const s of sets) {
    for (const m of s.mutations) {
      checked++;
      const rel = m.file || s.file;
      const abs = path.join(root, rel);
      if (!existsSync(abs)) {
        missing.push(`${s.id}: нет файла ${rel} → весь набор ничего не меряет`);
        continue;
      }
      if (!cache.has(abs)) cache.set(abs, readFileSync(abs, 'utf8'));
      const hits = cache.get(abs).split(m.pattern).length - 1;
      if (!hits) {
        missing.push(`${s.id}: паттерн не найден → «${m.name}» ничего не меряет`);
      } else if (hits > 1) {
        ambiguous.push(`${s.id}: ${hits} совпадения → «${m.name}» сядет на первое`);
      }
    }
  }
  if (missing.length) {
    console.error(`✗ mutation-gate --check-patterns: ${missing.length}/${checked} мутаций вне игры`);
    for (const x of missing) console.error('  • ' + x);
    process.exit(1);
  }
  if (ambiguous.length) {
    // Мутация садится на ПЕРВОЕ совпадение, поэтому паттерн, встречающий строку
    // дважды, мерит НЕ ТО решение, которое называет его именем. С 25.10 это
    // красное: предупреждение никто не читает в конце долгого прогона, а дыра
    // выглядит как работающая проверка.
    console.error(`✗ mutation-gate --check-patterns: ${ambiguous.length}/${checked} паттернов встречаются больше одного раза`);
    for (const x of ambiguous) console.error('  • ' + x);
    console.error('\n  Паттерн надо расширить соседними строками так, чтобы совпадение');
    console.error('  было ровно одно: иначе «имя мутации» не гарантирует, что мутировано то решение.');
    process.exit(1);
  }
  console.log(`✓ mutation-gate --check-patterns: ${checked} мутаций в ${sets.length} наборах находят свой код`);
  process.exit(0);
}

// Убитый прогон (SIGTERM/SIGKILL) не исполняет finally и оставляет в коде
// СТРОКУ МУТАЦИИ. Поднимаем это до первого смоука: иначе следующий запуск
// падает на «сломанном коде», которого не было.
//
// ЧУЖУЮ запись журнала не поднимаем: 25.10 JS-прогон восстановил «leftover»
// активного Rust-прогона, и тот мутант проверялся на целом коде (ложный
// ВЫЖИВШИЙ). Одновременный запуск двух гейтов — ошибка, а не гонка.
{
  const foreign = foreignJournal();
  if (foreign.length && !args.includes('--takeover')) {
    console.error('✗ mutation-gate: журнал принадлежит другому гейту — идёт его прогон:');
    for (const f of foreign) console.error(`  • ${f.file} (владелец ${f.owner})`);
    console.error('\n  Дождаться чужого прогона, либо — если он был УБИТ и мутант');
    console.error('  остался в дереве — поднять его явно: --takeover.');
    process.exit(1);
  }
  if (foreign.length) {
    console.log('⚠ mutation-gate: --takeover — подняты чужие leftovers: ' +
      recoverForeignJournal().join(', '));
  }
  const restored = recoverJournal();
  if (restored.length) {
    console.log('⚠ mutation-gate: восстановлены файлы после убитого прогона: ' + restored.join(', '));
  }
}

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
const crashed = [];
const broken = [];

for (const set of toRun) {
  console.log(`\n▸ ${set.id}: ${set.mutations.length} мутаций → ${set.smoke}`);
  const res = runSet(set, { log: (m) => console.log(m) });
  total += res.total;
  caught += res.caught.length;
  for (const s of res.survived) survived.push(`${set.id}: ${s}`);
  for (const s of (res.crashed || [])) crashed.push(`${set.id}: ${s}`);
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
if (crashed.length) {
  // Имена нужны ВСЕГДА, а не только рядом с выжившими: «поймано падением»
  // — это долг смоука (утверждения нет), и без списка его нельзя закрыть.
  console.log('\n  (пойманы падением с исключением, а не утверждением — ' + crashed.length + '):');
  for (const c of crashed) console.log('  • ' + c);
}
if (survived.length || broken.length) {
  console.log('\n  Мутационное тестирование — не «для галочки»: каждая выжившая');
  console.log('  мутация — это дырка в проверках, которую не найдёт ни один смоук.');
  process.exit(1);
}
console.log('✓ mutation-gate: все мутации пойманы, файлы восстановлены');
