// ── ADR-001: гейт связности (ctx-coupling) ─────────────────────────────
//
// Зачем. Цель ADR-001 — «правка одной фичи не задевает соседние». Пока
// фичи брали `ctx` (весь экземпляр App.vue, 212 полей), цель была
// недостижима ПО УЧЕБУ: любая функция могла достать любое поле, не зная о
// его существовании.
//
// Гейт делает связность ИЗМЕРИМОЙ и не даёт ей расти обратно. Это важно
// даже там, где ctx оставлен сознательно (тяжёлые оркестраторы calls.js —
// они работают с крипто-материалом, их переписывать зря нельзя): пока
// связность зафиксирована в baseline, её рост виден в диффе, а не
// проявляется как тихий регресс через полгода.
//
// Правило:
//   • суммарные ctx-ссылки по features/ НЕ МОГУТ превысить baseline;
//   • уменьшение — всегда хорошо (гейт это отмечает);
//   • рост — падение. Если рост осознанный, baseline обновляется явно
//     (`--write`) и попадает в git как решение, а не как случайность.
//
// Запуск:  node scripts/ctx-coupling-gate.mjs [--write]

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FEATURES = path.join(ROOT, 'src/features');
const BASELINE = path.join(ROOT, 'scripts/ctx-coupling-baseline.json');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

// Тело функции по балансу скобок. Тот же подход, что в calls-deps-smoke:
// split по «следующей функции» захватывал бы промежуточные участки.
//
// Два важных момента, оба найденные на живых данных:
//  1) Обращение к группам — ИНДЕКСОМ (m[1]), не m.group(1): в этом
//     окружении объект совпадения приходит плоским Array (keys:
//     0,1,index,input,groups), методов RegExp нет — m.group() TypeError.
//  2) Перед подсчётом скобок ОБЯЗАТЕЛЬНО выкидываются комментарии и
//     строковые литералы. Без этого фигурные скобки внутри строки/регэкса
//     ломают баланс, depth никогда не возвращается в 0, и функция молча
//     ПРОПУСКАЕТСЯ целиком (messages.js показывал 0 функций вместо 1).
const STRIP_STRINGS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const STRIP_LINES = /^\s*\/\/.*$/gm;
const STRIP_BLOCKS = /\/\*[\s\S]*?\*\//g;
// Поля-владельцы (ADR-004). Исключаются из подсчёта coupling: запись через
// владельца — планомерный перенос состояния, а не рост связности.
// Симметрично с ctx-ratchet-gate.js OWNER_FIELDS.
const OWNER_FIELDS = new Set([
  'chat',
  'setGroupKey', 'setGroupAvatar', 'mergeGroupKeys', 'mergeGroupAvatars',

  'setSending', 'getSending', 'setPendingOutgoing', 'getPendingOutgoingBucket',
  'mergePendingOutgoing', 'removePendingOutgoing', 'clearPendingOutgoing', 'dropBucket',
  // A11: unreadCounts owner API (chat-store.js)
  'incUnread', 'clearUnread', 'clearAllUnread', 'unreadOf', 'setUnread',
  // A12: session-store.js owner API (isLoggedIn + emails)
  'login', 'logout', 'setEmails', 'clearEmails', 'emailCount',
]);


function functionBodies(src) {
  const clean = src.replace(STRIP_BLOCKS, '').replace(STRIP_LINES, '')
    // строковые литералы заменяем на пустые кавычки — длина строки сохраняется,
    // поэтому смещения open/close в clean совпадают со смещениями в src
    .replace(STRIP_STRINGS, '""');
  const out = [];
  const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) {
    const open = src.indexOf('{', m.index);
    if (open < 0) continue;
    let depth = 0, closed = false;
    for (let i = open; i < clean.length; i++) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') {
        depth--;
        if (depth === 0) {
          out.push({ name: m[1], body: src.slice(open, i + 1), line: src.slice(0, m.index).split('\n').length });
          closed = true;
          break;
        }
      }
    }
    // Незакрытое тело — не молча пропускаем: считаем функцией до конца файла,
    // иначе метрика систематически занижается на файлах со странными литералами.
    if (!closed) out.push({ name: m[1], body: src.slice(open), line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

const measured = {};
let totalRefs = 0, totalFns = 0, ctxFns = 0;
for (const f of walk(FEATURES)) {
  const rel = path.relative(ROOT, f);
  const src = readFileSync(f, 'utf8');
  const fns = functionBodies(src);
  // refs — ТОЛЬКО из кода (не комментариев): строковый regex на raw src
  // ловит ctx.* в комментариях (ложные срабатывания у owner-модулей).
  const code = src.replace(STRIP_BLOCKS, "").replace(STRIP_LINES, "").replace(STRIP_STRINGS, "");
  const refs = code.match(/\bctx\.([A-Za-z_]\w*)/g) || [];
  // Владельцы ADR-004 (setSending/setPendingOutgoing и пр.) не считаются coupling.
  const ownRefs = refs.filter(r => !OWNER_FIELDS.has(r.slice(4)));
  if (!ownRefs.length && !fns.length && !refs.length) continue;
  const withCtx = fns
    .filter(fn => /\bctx\b/.test(fn.body))
    .sort((a, b) => b.body.length - a.body.length);
  measured[rel] = {
    ctxRefs: ownRefs.length,
    fields: [...new Set(ownRefs.map(r => r.slice(4)))].sort(),
    functions: fns.length,
    functionsWithCtx: withCtx.length,
    biggestCtxFn: withCtx[0]?.name || null,
  };
  totalRefs += ownRefs.length;
  totalFns += fns.length;
  ctxFns += withCtx.length;
}

const now = { totalCtxRefs: totalRefs, totalFunctions: totalFns, functionsWithCtx: ctxFns, modules: measured };

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, JSON.stringify(now, null, 2) + '\n');
  console.log(`✓ baseline записан: ${totalRefs} ctx-ссылок, ${ctxFns}/${totalFns} функций с ctx`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('✗ нет baseline. Создать: node scripts/ctx-coupling-gate.mjs --write');
  process.exit(2);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const problems = [];

if (totalRefs > base.totalCtxRefs) {
  problems.push(`суммарно ctx-ссылок ${totalRefs} > baseline ${base.totalCtxRefs} (+${totalRefs - base.totalCtxRefs})`);
}
for (const [mod, m] of Object.entries(measured)) {
  const b = base.modules[mod];
  if (!b) {
    // Новый модуль — проблема ТОЛЬКО если он действительно тянет ctx.
    // Раньше условием было одно отсутствие модуля в baseline, и гейт писал
    // «новый модуль X использует ctx (0)»: чистый модуль объявлялся виноватым
    // при нуле ссылок. Это ложное срабатывание толкало либо «чинить» нечего,
    // либо вписать модуль в baseline не глядя — и тогда проверка для реально
    // связанных новых модулей исчезала бы совсем.
    if (m.ctxRefs > 0) {
      problems.push(`новый модуль ${mod} использует ctx (${m.ctxRefs}) — переведи на явные зависимости`);
    }
    continue;
  }
  if (m.ctxRefs > b.ctxRefs) {
    problems.push(`${mod}: ctx-ссылок ${m.ctxRefs} > baseline ${b.ctxRefs} (+${m.ctxRefs - b.ctxRefs})`);
  }
  const added = m.fields.filter(f => !(b.fields || []).includes(f));
  if (added.length) {
    problems.push(`${mod}: +${added.length} новых полей в ctx (${added.slice(0, 6).join(', ')})`);
  }
}

const delta = totalRefs - base.totalCtxRefs;
if (problems.length) {
  console.error(`✗ ctx-coupling: ${problems.length} проблем(ы)`);
  for (const p of problems) console.error('  ' + p);
  console.error(`\n  baseline: ${BASELINE}`);
  console.error('  осознанно принять изменение: node scripts/ctx-coupling-gate.mjs --write');
  process.exit(1);
}
console.log(delta < 0
  ? `✓ ctx-coupling: ${totalRefs} ссылок (baseline ${base.totalCtxRefs}, −${-delta})`
  : `✓ ctx-coupling: ${totalRefs} ссылок (baseline ${base.totalCtxRefs})`);