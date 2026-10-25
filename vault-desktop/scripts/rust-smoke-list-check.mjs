// Проверка смоуков rust-наборов (задача #36): фильтр cargo должен собирать
// ХОТЯ БЫ ОДИН тест. Список тестов крейта берётся ОДИН раз на крейт командой
// `cargo test -p <pkg> --lib -- --list` (фильтр cargo сверяется с ПОЛНЫМ ПУТЁМ
// теста `модуль::tests::имя`, а не с именем функции).
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = '/home/maksim/whisper';
const DIR = path.join(REPO, 'vault-desktop/scripts/rust-mutations/sets');
// Должно совпадать с DEFAULT_CRATE в rust-mutation-gate.mjs: набор без поля
// `crate` живёт там же, где его мутации. Раньше здесь стоял
// 'vault-desktop/src-tauri' — и для сотен наборов без `crate` список тестов
// запрашивался не из того каталога: cargo ошибался, список выходил пустым,
// а проверка «фильтр собирает хотя бы один тест» молча не проверяла ничего.
const DEFAULT_CRATE = 'vault-client';

const cache = new Map();
const broken = [];
function listOf(crate, pkg, lib) {
  const key = `${crate}|${pkg}|${lib}`;
  if (cache.has(key)) return cache.get(key);
  const argv = lib
    ? ['test', '-p', pkg, '--lib', '--', '--list']
    : ['test', '-p', pkg, '--', '--list'];
  const res = spawnSync('cargo', argv, {
    cwd: path.join(REPO, crate),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CARGO_TERM_COLOR: 'never' },
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const names = out.split('\n').filter((l) => l.endsWith(': test')).map((l) => l.slice(0, -': test'.length).trim());
  if (!names.length) {
    console.error(`✗ крейт ${crate} (pkg ${pkg}): --list не вернул ни одного теста — прогон сломан?`);
    console.error(out.split('\n').slice(-8).join('\n'));
    // Пустой список — это не «ок, фильтра нет»: сверять не с чем, проверка
    // ничего не утверждает. Зелёный прогон без измерения хуже красного.
    broken.push(`${crate}/${pkg}`);
  }
  cache.set(key, names);
  return names;
}

const files = readdirSync(DIR).filter((x) => x.endsWith('.mjs')).sort();
let checked = 0, dead = 0, notCargo = 0, total = 0;
for (const f of files) {
  const s = (await import(path.join(DIR, f))).default;
  const crate = s.crate || DEFAULT_CRATE;
  const m = /^cargo test -p (\S+)( --lib)?(?:\s+(\S+))?\s*$/.exec((s.smoke || '').trim());
  if (!m || (m[3] && m[3].startsWith('-'))) {
    notCargo++;
    console.log(`  · ${s.id}: смоук не разбирается как «cargo test -p <pkg> [--lib] [фильтр]» → не меряется здесь: ${s.smoke}`);
    continue;
  }
  const pkg = m[1], lib = !!m[2], filter = m[3];
  const names = listOf(crate, s.pkg || pkg, lib);
  total += names.length;
  checked++;
  if (!filter) { console.log(`  · ${s.id}: фильтр не задан (весь крейт) — ок`); continue; }
  const hits = names.filter((n) => n.includes(filter));
  if (!hits.length) {
    dead++;
    console.error(`✗ ${s.id}: фильтр «${filter}» не собирает НИ ОДНОГО теста из ${names.length} (${pkg})`);
    console.error(`   смоук: ${s.smoke}`);
  } else {
    console.log(`  ✓ ${s.id}: «${filter}» → ${hits.length} тестов`);
  }
}
console.log(`\n=== проверено наборов: ${checked}, мёртвых фильтров: ${dead}, не-cargo смоуков: ${notCargo}`);
console.log(`    (суммарно тестов в крейтах: ${[...cache.values()].reduce((a, v) => a + v.length, 0)}, уникальных крейтов: ${cache.size})`);
if (broken.length) console.error(`✗ крейтов, где --list не дал тестов: ${broken.join(', ')}`);
process.exit(dead || broken.length ? 1 : 0);
