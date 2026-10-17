// Гейт: ссылка на модуль-владельца состояния без импорта/объявления.
//
// ЗАЧЕМ. Рефакторинг ADR-004 переписывает `ctx.<поле>` на синглтон-владельца
// (`callSession.state.callState`, `mailboxStore.state.channels`, …). Замена
// делается в одном месте, а ИМПОРТ забывается — и код получает ReferenceError
// не в момент правки, а когда путь исполнится. Ровно это произошло в J.3c
// (5e2bb5e): в relay.js `ctx.callState` → `callSession.state.callState`, импорта
// `callSession` нет. Смоуки/сборка молчали: `node --check` проверяет синтаксис,
// а не ссылки; резервный IDLE-путь в тестах не исполнялся. Ошибка всплыла только
// когда relay-smoke переписали на реальные владельцы.
//
// ЧТО ПРОВЕРЯЕТСЯ. Для каждого имени-владельца (то, что экспортируется как
// `export const X = createY(...)` или `reactive(...)`) в каждом исходнике
// ищется использование `X.` НЕ после точки (`this.x`, `obj.x` — это свойства).
// Такое использование обязано сопровождаться импортом/объявлением/параметром
// в этом же файле.
//
// ЧЕГО НЕ ПРОВЕРЯЕТ (осознанно):
//   · собственные поля объекта, названные как владелец (лечится lookbehind);
//   · типовые/строковые упоминания (комментарии вырезаются);
//   · ПОЛНЫЙ no-undef (это линтер; здесь — узкий класс, который реально стрелял).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

// ── 1. Собираем владельцев из исходников (самоподдержка списка) ──────────
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = jsFiles(SRC);

const owners = new Set();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/export\s+const\s+(\w+)\s*=\s*(create\w+|reactive\s*\()/g)) {
    owners.add(m[1]);
  }
}

// ── 2. Разбор одного файла ────────────────────────────────────────────────
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function declared(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s+\{([^}]*)\}\s+from/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (t) names.add(t.split(/\s+as\s+/).pop().trim());
    }
  }
  for (const m of src.matchAll(/import\s+\*\s+as\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/^\s*import\s+(\w+)\s*(?:,|from)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bfunction\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bclass\s+(\w+)/g)) names.add(m[1]);
  // параметры функций/методов и колбэков: (a, b) / function f(a) / catch (e)
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/^\.\.\./, '').split('=')[0].trim();
      if (/^\w+$/.test(t)) names.add(t);
    }
  }
  for (const m of src.matchAll(/\bcatch\s*\(\s*(\w+)/g)) names.add(m[1]);
  return names;
}

function violations(src) {
  const code = stripComments(src);
  const decl = declared(code);
  const bad = [];
  for (const owner of owners) {
    if (decl.has(owner)) continue;
    // `owner.` но НЕ `this.owner.` / `obj.owner.` / `import ... owner`
    const re = new RegExp('(?<![\\w.$])' + owner + '\\s*\\.', 'g');
    const m = re.exec(code);
    if (m) {
      const line = code.slice(0, m.index).split('\n').length;
      bad.push({ owner, line });
    }
  }
  return bad;
}

// ── 3. Анти-рот: гейт обязан ловить подделку ─────────────────────────────
const SELF_BAD = `export async function f() { return callSession.state.callState; }`;
const SELF_GOOD = `import { callSession } from './call-session.js';\nexport async function f() { return callSession.state.callState; }`;
const selfBadCaught = violations(SELF_BAD).some((v) => v.owner === 'callSession');
const selfGoodOk = violations(SELF_GOOD).length === 0;
if (!selfBadCaught || !selfGoodOk) {
  console.log('✗ owner-refs-gate: САМОПРОВЕРКА ПРОВАЛА (ловит=' + selfBadCaught + ', не_ложно=' + selfGoodOk + ')');
  process.exit(1);
}

// ── 4. Прогон по исходникам ──────────────────────────────────────────────
let bad = 0;
for (const f of files) {
  for (const v of violations(readFileSync(f, 'utf8'))) {
    console.log(`  ✗ ${path.relative(ROOT, f)}:${v.line}: \`${v.owner}.\` без импорта/объявления`);
    bad++;
  }
}
if (bad) {
  console.log(`✗ owner-refs-gate: ${bad} проблем(ы)`);
  console.log('  хелп: владелец — это `export const X = createY()/reactive()`; используешь X. — импортируй X.');
  process.exit(1);
}
console.log(`✓ owner-refs-gate: ${files.length} файлов, ${owners.size} владельцев — ссылок без импорта нет`);
