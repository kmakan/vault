// Единая точка правды о прогрессе Этапа 3.
//
// Зачем: числа прогресса я вписывал в журнал и ADR ПО ПАМЯТИ шесть раз и
// ошибался шесть раз (7088 вместо 7119, 7084 вместо 7107, 163 вместо 165
// методов, 2101 вместо 2098 строк, 7081 вместо 7079...). Читатель через месяц
// поверит этим числам, а враньё там хуже отсутствия числа.
//
// ПРАВИЛО: ни одного числа о прогрессе не писать руками. Запустить это и
// скопировать отсюда.
//
// Смоуки берутся ВСЕ по маске *smoke*.mjs, а не только зарегистрированные в
// package.json: в прошлой версии скрипта считалось 21 из 47, и сумма не
// совпадала с той, что я складывал руками. Молча пропущенные смоуки хуже, чем
// явный список провалов — поэтому здесь они перечисляются, а не прячутся.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

function inventory() {
  return execFileSync('node', [path.join(SCRIPTS, 'appvue-inventory.mjs')], {
    encoding: 'utf8', cwd: ROOT,
  });
}

// Форматы в проекте разные, и каждый уже стоил неверного счёта:
//   «=== ИТОГ: 29 pass, 0 fail»                     большинство
//   «=== ИТОГО: 29 pass, 0 fail ===»                префикс «===» перед «ИТОГО»
//   «call-session-smoke: 40/40 checks passed»       счёт вида N/M
//   «ALL 31 passed»                                 channels-smoke
//   «=== video-smoke: 57 passed, 0 failed ===»      без слова ИТОГ вовсе
// Первое число всегда — сколько проверок прошло.
//
// ПРОШЛАЯ ОШИБКА. Альтернатива `=== ИТОГ:?` не совпадала со строкой «===
// ИТОГО: …» (после «ИТОГ» идёт «О», а не «:»), а альтернатива `ИТОГО:?` не
// пускала префикс «=== ». Из-за этого девять ЗЕЛЁНЫХ смоуков попадали в
// «формат не распознан», и сумма проверок по проекту была занижена — то есть
// «ПОКА СУММЕ НЕЛЬЗЯ ДОВЕРЯТЬ» касалось в том числе исправных смоуков.
function parseCount(out) {
  const lines = out.trim().split('\n').reverse();
  for (const line of lines.slice(0, 8)) {
    const t = line.trim();
    let m = /^(?:=+\s*)?(?:ИТОГО|ИТОГ|ИТОГИ):?\s*(\d+)\s+(?:pass|passed)\b/i.exec(t);
    if (m) return Number(m[1]);
    m = /^ALL\s+(\d+)\s+passed/i.exec(t);
    if (m) return Number(m[1]);
    m = /(\d+)\s*\/\s*\d+\s+checks passed/i.exec(t);
    if (m) return Number(m[1]);
    m = /(\d+)\s+passed\b/i.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}

const inv = inventory();
const m = /методов всего (\d+), делегатов (\d+), со своей логикой (\d+)/.exec(inv);
const logic = /строк в методах со своей логикой: (\d+) из (\d+)/.exec(inv);
const appvueLines = readFileSync(path.join(ROOT, 'src', 'App.vue'), 'utf8').split('\n').length;

// smoke-imports.mjs — общий хелпер, а не смоук: он начинается с 'smoke' и
// попадал бы под маску, портя счёт своим нулём в нераспознанных.
const files = readdirSync(SCRIPTS)
  .filter((f) => /smoke.*\.mjs$/.test(f) && f !== 'smoke-imports.mjs')
  .sort();

let total = 0, counted = 0, failed = [], unparsed = [];
for (const f of files) {
  let out = '', err = '';
  try {
    out = execFileSync('node', [path.join(SCRIPTS, f)], {
      encoding: 'utf8', cwd: ROOT, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    err = String(e.message || '');
  }
  if (/^\s*✗/m.test(out) || err) failed.push(f);
  const n = parseCount(out);
  if (n === null) unparsed.push(f);
  else { total += n; counted++; }
}

console.log('=== ПРОГРЕСС ЭТАПА 3 (числа отсюда, руками не писать) ===');
console.log('методов со своей логикой: ' + (m ? m[3] : '?'));
console.log('строк логики:              ' + (logic ? logic[1] : '?') + ' (из ' + (logic ? logic[2] : '?') + ')');
console.log('App.vue, строк:            ' + appvueLines);
console.log('смоуков учтено: ' + counted + ' из ' + files.length + ', проверок суммарно: ' + total);
if (unparsed.length) {
  console.log('\n!! формат вывода не распознан (' + unparsed.length + ') — сумма НЕПОЛНАЯ:');
  for (const f of unparsed) console.log('   ' + f);
}
if (failed.length) {
  console.log('\n!! провалились (' + failed.length + '):');
  for (const f of failed) console.log('   ' + f);
}
if (unparsed.length || failed.length) {
  console.log('\nПОКА СУММЕ НЕЛЬЗЯ ДОВЕРЯТЬ — сначала починить списки выше.');
  process.exit(1);
}