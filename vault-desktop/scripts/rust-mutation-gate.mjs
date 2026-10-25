// Мутационный гейт для RUST-ядра (ADR-005 W4).
//
// ЗАЧЕМ. JS-сторона закрыта мутационным гейтом (vault-desktop/scripts/
// mutation-gate.mjs): каждый смоук обязан ЛОВИТЬ подложенную поломку. Rust-
// ядро — то, куда W4 переносит решения о протоколе, — до сих пор проверялось
// ТОЛЬКО обычными тестами. А обычный тест не отвечает на вопрос «а он вообще
// что-то проверяет?»: тест, который зелёный на сломанном коде, не хуже
// отсутствия теста — он ещё и создаёт видимость защищённости.
//
// МUTATION ЗДЕСЬ — ЭТО ВОПРОС К ТЕСТУ. Подставляем поломку в правило и смотрим,
// ПОЙМАЛ ли её тест. Поймал — тест работает. Остался зелёным — тест ничего не
// проверяет (или проверяет не то).
//
// ОСОБЕННОСТЬ РУСТА. Компилятор ловит часть поломок сам (неверный тип,
// несуществующее поле). Такая мутация НЕ является пробелом в тестах — её
// поймал компилятор, а не тест, и это отдельная категория (mutRejected),
// не провал гейта. Провал гейта — это «тест зелёный на сломанном коде».
//
// ПРАВИЛА ДВИЖКА:
//   * мутация применяется ТОЧНЫМ совпадением строки; строки нет — это ОШИБКА
//     набора (тест/код устарел), а не «пропущено»;
//   * после прогона файл ВОССТАНАВЛИВАЕТСЯ побайтно (всегда, даже при ошибке);
//   * базовый прогон обязателен: набор, чей тест не проходит на чистом дереве,
//     бессмысленен (сломанный тест «ловит» любую поломку);
//   * крейт берётся из поля `crate` набора (по умолчанию `vault-client`) — это
//     КАТАЛОГ, где лежат тесты. Имя пакета для `cargo test -p` может быть
//     другим (`pkg`): мост живёт в `vault-desktop/src-tauri`, а пакет
//     называется `vault-desktop`, и путь cargo именем пакета не принимает.
//     Файл мутации может лежать в другом крейте: cargo соберёт его как path-
//     зависимость. Так `vault-core` (общий слой хранилищ) перестаёт быть
//     слепой зоной, не превращаясь во второй гейт.
//
// ЗАПУСК:
//   node scripts/rust-mutation-gate.mjs                    # все наборы
//   node scripts/rust-mutation-gate.mjs --set ephemeral    # один набор
//   node scripts/rust-mutation-gate.mjs --list             # список наборов
//   node scripts/rust-mutation-gate.mjs --check-patterns   # наборы ещё находят свой код
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
// Дисковый журнал — тот же, что у JS-гейта. finally не выполняется при
// SIGTERM/SIGKILL, а убитый прогон rust-гейта оставлял мутанта В КРЕЙТЕ:
// `if false { return PubOutcome::Disabled; }` в relay.rs ронял базовый прогон
// ВСЕХ наборов сразу («тесты не проходят на чистом дереве»), и 187 мутаций
// мерились по сломанному дереву.
import { recoverJournal, writeJournal, clearJournal } from './mutations/engine.mjs';

const HERE = import.meta.dirname;                       // vault-desktop/scripts
const REPO = path.resolve(HERE, '..', '..');             // корень репозитория
const DEFAULT_CRATE = 'vault-client';
const SETS_DIR = path.join(HERE, 'rust-mutations', 'sets');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function loadSets() {
  if (!existsSync(SETS_DIR)) return [];
  const sets = [];
  for (const f of readdirSync(SETS_DIR).filter((x) => x.endsWith('.mjs')).sort()) {
    const mod = await import(path.join(SETS_DIR, f));
    const s = mod.default || mod;
    if (!s || !s.id || !s.file || !s.smoke) {
      console.error(`  ✗ набор ${f}: не хватает id/file/smoke`);
      continue;
    }
    const crate = s.crate || DEFAULT_CRATE;
    if (!existsSync(path.join(REPO, crate, 'Cargo.toml'))) {
      console.error(`  ✗ набор ${f}: крейт ${crate} не найден`);
      continue;
    }
    sets.push(s);
  }
  return sets;
}

// Запуск тестов крейта. kind: 'lib' (юнит-тесты) | 'all' (включая интеграционные)
// | произвольная строка cargo-фильтра.
// Каталог крейта (cwd) и ИМЯ пакета для `-p` — разные вещи: мост лежит в
// `vault-desktop/src-tauri`, а пакет называется `vault-desktop`. cargo не
// принимает путь в качестве имени пакета, поэтому набор задаёт `pkg`.
function runTests(crate, kind = 'lib', timeoutMs = 600000, pkg = null) {
  const target = pkg || crate;
  const args = kind === 'all'
    ? ['test', '-p', target, '--quiet']
    : ['test', '-p', target, '--lib', '--quiet'];
  const res = spawnSync('cargo', args, {
    cwd: path.join(REPO, crate),
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
  });
  const out = (res.stdout || '') + (res.stderr || '');
  return {
    code: res.status === null ? -1 : res.status,
    timedOut: res.error && res.error.code === 'ETIMEDOUT',
    compiled: !/error\[E\d+\]|error: could not compile|error: aborting/.test(out),
    output: out,
  };
}

// Прогон одного набора. Возвращает { id, total, caught, survived, rejected, broken }.
export function runSet(set, opts = {}) {
  const log = opts.log || (() => {});
  const file = path.join(REPO, set.file);
  if (!existsSync(file)) {
    return { id: set.id, total: set.mutations.length, caught: 0, survived: [], rejected: [], broken: [{ name: '(файл модуля)', reason: 'нет файла ' + set.file }] };
  }
  const original = readFileSync(file, 'utf8');
  const crate = set.crate || DEFAULT_CRATE;
  const kind = set.kind || 'lib';
  const caught = [];
  const survived = [];
  const rejected = [];   // поломку поймал компилятор — не пробел в тестах
  const broken = [];

  // Базовый прогон: тест обязан проходить на чистом дереве.
  const base = runTests(crate, kind, set.timeoutMs, set.pkg);
  if (base.code !== 0) {
    // причину надо печатать: «тесты не проходят» без неё одинаково означает
    // таймаут сборки, ошибку компиляции и упавший тест, а чинить надо разные
    // вещи (набор, код, тест соответственно).
    const why = base.timedOut
      ? `прогон превысил ${set.timeoutMs || 600000} мс (холодная сборка крейта?)`
      : !base.compiled
        ? 'крейт не собрался'
        : `тесты упали (код ${base.code})`;
    const tail = base.output.trim().split('\n').slice(-6).join('\n');
    return {
      id: set.id, total: set.mutations.length, caught, survived, rejected, broken,
      broken: [{ name: '(базовый прогон)', reason: `набор бессмысленен: ${why}\n${tail}` }],
    };
  }

  for (const m of set.mutations) {
    const mFile = path.join(REPO, m.file || set.file);
    const src = readFileSync(mFile, 'utf8');
    if (!src.includes(m.pattern)) {
      broken.push({ name: m.name, reason: 'паттерн не найден' });
      log('  ✗ ' + m.name + ' — мутация НЕ ПРИМЕНИЛАСЬ: паттерн не найден');
      continue;
    }
    const mutated = src.replace(m.pattern, m.replacement);
    writeJournal(mFile, src);
    writeFileSync(mFile, mutated);
    let out;
    let foreign = null;
    try {
      out = runTests(crate, kind, set.timeoutMs, set.pkg);
    } finally {
      // Побайтное восстановление — только если файл за прогон не менял никто
      // кроме нас (см. mutations/engine.mjs: чужую правку откат затирал).
      const now = readFileSync(mFile, 'utf8');
      if (now !== src && now !== mutated) {
        clearJournal(mFile);
        foreign = 'файл изменён извне во время прогона — восстановление отменено';
      } else {
        writeFileSync(mFile, src);
        clearJournal(mFile);
      }
    }
    if (foreign) {
      broken.push({ name: m.name, reason: foreign + ': ' + mFile });
      log('  ✗ ' + m.name + ' — ' + foreign + '; набор остановлен, чужую правку не трогаем');
      return { id: set.id, total: set.mutations.length, caught, survived, rejected, broken };
    }
    if (out.timedOut) {
      broken.push({ name: m.name, reason: 'тесты зависли (таймаут)' });
      log('  ✗ ' + m.name + ' — тесты ЗАВИСЛИ (таймаут)');
      continue;
    }
    if (!out.compiled) {
      rejected.push(m.name);
      log('  ○ ' + m.name + ' — поймал компилятор (не пробел в тестах)');
      continue;
    }
    if (out.code !== 0) {
      caught.push(m.name);
      log('  ✓ ' + m.name);
    } else {
      survived.push(m.name);
      log('  ✗ ' + m.name + ' — ВЫЖИЛА (тест зелёный на сломанном коде!)');
    }
  }

  const after = readFileSync(file, 'utf8');
  if (sha(after) !== sha(original)) {
    broken.push({ name: '(восстановление)', reason: 'файл не восстановлен побайтно' });
  }
  return { id: set.id, total: set.mutations.length, caught, survived, rejected, broken };
}

// ── main ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const sets = await loadSets();
if (args.includes('--list')) {
  for (const s of sets) console.log(`${s.id.padEnd(22)} ${s.crate ? `[${s.crate}] ` : ''}${s.file}  (${s.mutations.length} мутаций, kind=${s.kind || 'lib'})`);
  process.exit(0);
}

// «Набор ещё меряет?» — БЕЗ cargo, секунды на весь список. PATTERNS — ЭТО
// КОНТРАКТ С ФОРМОЙ КОДА: переезд решения между функциями (25.10: квоты из
// relay_pub в publisher_key/daily_limit_for_token) или правка формата обрывают
// его МОЛЧА. Такой набор не становится красным целиком — он теряет проверки и
// продолжает ловить оставшиеся, поэтому цвет прогона скрывает дыру. Режим стоит в
// `npm run quality` ПЕРЕД долгим прогоном именно потому, что ловит это за
// секунды, а не через полчаса.
if (args.includes('--check-patterns')) {
  const JOURNAL_DIR = '/tmp/vault-mutation-journal';
  const busy = existsSync(JOURNAL_DIR)
    ? readdirSync(JOURNAL_DIR).filter((x) => x.endsWith('.bak'))
    : [];
  if (busy.length) {
    console.error('✗ идёт прогон гейта (журнал не пуст) — проверка паттернов по мутанту бессмысленна');
    process.exit(1);
  }
  let checked = 0;
  const missing = [];
  const ambiguous = [];
  const cache = new Map();
  for (const s of sets) {
    for (const m of s.mutations) {
      checked++;
      const rel = m.file || s.file;
      const abs = path.join(REPO, rel);
      if (!existsSync(abs)) {
        missing.push(`${s.id}: нет файла ${rel} → весь набор ничего не меряет`);
        continue;
      }
      if (!cache.has(abs)) cache.set(abs, readFileSync(abs, 'utf8'));
      const src = cache.get(abs);
      const hits = src.split(m.pattern).length - 1;
      if (!hits) {
        missing.push(`${s.id}: паттерн не найден → «${m.name}» ничего не меряет`);
      } else if (hits > 1) {
        // Мутация садится на ПЕРВОЕ совпадение. Если строка встречается дважды
        // (например, ключ издателя и в гейте лимита, и в раздаче остатка),
        // проверка может бить не по тому решению — это видно только вручную.
        ambiguous.push(`${s.id}: ${hits} совпадения → «${m.name}» сядет на первое`);
      }
    }
  }
  if (missing.length) {
    console.error(`✗ rust-mutation-gate --check-patterns: ${missing.length}/${checked} мутаций вне игры`);
    for (const x of missing) console.error('  • ' + x);
    console.error('\n  Паттерн заново закрепляют за ТЕКУЩЕЙ формой кода; набор, который');
    console.error('  перестал находить строку, проверяет меньше, чем показывает его размер.');
    process.exit(1);
  }
  if (ambiguous.length) {
    console.log(`⚠ ${ambiguous.length}/${checked} паттернов встречаются в файле больше одного раза:`);
    for (const x of ambiguous) console.log('  • ' + x);
  }
  console.log(`✓ rust-mutation-gate --check-patterns: ${checked} мутаций в ${sets.length} наборах находят свой код`);
  process.exit(0);
}

{
  const restored = recoverJournal();
  if (restored.length) {
    console.log(`  журнал: восстановлено после убитого прогона — ${restored.join(', ')}`);
  }
}
const only = args.includes('--set') ? args[args.indexOf('--set') + 1] : null;
const chosen = only ? sets.filter((s) => s.id === only) : sets;
if (!chosen.length) {
  console.error(`набор не найден: ${only}`);
  process.exit(1);
}

console.log(`▸ rust-mutation-gate: наборов ${chosen.length}, мутаций ` +
  chosen.reduce((a, s) => a + s.mutations.length, 0));
const crates = [...new Set(chosen.map((s) => s.crate || DEFAULT_CRATE))].sort();
console.log(`  крейты: ${crates.join(', ')}  (cargo test -p <крейт> --lib)\n`);

let total = 0, caught = 0;
const allSurvived = [];
const allBroken = [];
for (const s of chosen) {
  console.log(`▸ ${s.id}: ${s.mutations.length} мутаций → ${s.file}` +
    (s.crate ? ` (крейт ${s.crate})` : ''));
  const r = runSet(s, { log: (m) => console.log(m) });
  total += r.total;
  caught += r.caught.length;
  r.survived.forEach((x) => allSurvived.push(`${s.id}: ${x}`));
  r.broken.forEach((x) => allBroken.push(`${s.id}: ${x.name} — ${x.reason}`));
  console.log(`  → поймано ${r.caught.length}/${r.total}` +
    (r.rejected.length ? `, компилятор поймал ${r.rejected.length}` : '') + '\n');
}

console.log(`=== ИТОГ: ${caught}/${total} мутаций поймано`);
if (allSurvived.length) {
  console.error('\n✗ ВЫЖИВШИЕ МУТАЦИИ (тест зелёный на сломанном коде — тест ничего не проверяет):');
  for (const x of allSurvived) console.error('  • ' + x);
}
if (allBroken.length) {
  console.error('\n✗ СЛОМАННЫЕ МУТАЦИИ (набор устарел — чинить набор, а не пропускать):');
  for (const x of allBroken) console.error('  • ' + x);
}
if (allSurvived.length || allBroken.length) {
  console.error('\n  Мутационное тестирование — не «для галочки»: каждая выжившая');
  console.error('  мутация — это дырка в проверках, которую не найдёт ни один тест.');
  process.exit(1);
}
console.log('\n✓ rust-mutation-gate: все мутации пойманы, файлы восстановлены');
