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
//     бессмысленен (сломанный тест «ловит» любую поломку).
//
// ЗАПУСК:
//   node scripts/rust-mutation-gate.mjs                    # все наборы
//   node scripts/rust-mutation-gate.mjs --set ephemeral    # один набор
//   node scripts/rust-mutation-gate.mjs --list             # список наборов
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const HERE = import.meta.dirname;                       // vault-desktop/scripts
const REPO = path.resolve(HERE, '..', '..');             // корень репозитория
const CRATE = path.join(REPO, 'vault-client');
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
    sets.push(s);
  }
  return sets;
}

// Запуск тестов крейта. kind: 'lib' (юнит-тесты) | 'all' (включая интеграционные)
// | произвольная строка cargo-фильтра.
function runTests(kind = 'lib', timeoutMs = 600000) {
  const args = kind === 'all'
    ? ['test', '-p', 'vault-client', '--quiet']
    : ['test', '-p', 'vault-client', '--lib', '--quiet'];
  const res = spawnSync('cargo', args, {
    cwd: CRATE,
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
  const kind = set.kind || 'lib';
  const caught = [];
  const survived = [];
  const rejected = [];   // поломку поймал компилятор — не пробел в тестах
  const broken = [];

  // Базовый прогон: тест обязан проходить на чистом дереве.
  const base = runTests(kind, set.timeoutMs);
  if (base.code !== 0) {
    return {
      id: set.id, total: set.mutations.length, caught, survived, rejected, broken,
      broken: [{ name: '(базовый прогон)', reason: 'тесты не проходят на чистом дереве — набор бессмысленен' }],
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
    writeFileSync(mFile, mutated);
    let out;
    try {
      out = runTests(kind, set.timeoutMs);
    } finally {
      writeFileSync(mFile, src);   // восстановление побайтно
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
  for (const s of sets) console.log(`${s.id.padEnd(22)} ${s.file}  (${s.mutations.length} мутаций, kind=${s.kind || 'lib'})`);
  process.exit(0);
}
const only = args.includes('--set') ? args[args.indexOf('--set') + 1] : null;
const chosen = only ? sets.filter((s) => s.id === only) : sets;
if (!chosen.length) {
  console.error(`набор не найден: ${only}`);
  process.exit(1);
}

console.log(`▸ rust-mutation-gate: наборов ${chosen.length}, мутаций ` +
  chosen.reduce((a, s) => a + s.mutations.length, 0));
console.log(`  крейт: ${path.relative(REPO, CRATE)}  (cargo test -p vault-client --lib)\n`);

let total = 0, caught = 0;
const allSurvived = [];
const allBroken = [];
for (const s of chosen) {
  console.log(`▸ ${s.id}: ${s.mutations.length} мутаций → ${s.file}`);
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
