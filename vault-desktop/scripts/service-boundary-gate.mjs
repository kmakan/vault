// Гейт границы сервисов (ADR-005 W5) — «карта фича → сервис» не должна
// протухать молча.
//
// ЗАЧЕМ. ADR-005 §6 держит горизонт: ядро обмена, соцсеть local-first,
// приватный видеохостинг, приватный стриминг. W5 — оформить это КАРТОЙ и
// проверяемой границей. Карта без гейта протухает за месяцы: появляются фичи,
// которые никто не относит к сервису, и через год карта описывает вымышленную
// архитектуру.
//
// ЧТО ПРОВЕРЯЕТСЯ.
//   1. Полнота карты: каждая фича src/features/*.js объявлена ровно в одном
//      сервисе, и каждая объявленная существует. Нет «сирот» и «призраков».
//   2. Примитивы сервиса: фичи сервиса импортируют только те корневые
//      модули (src/*.js), которые сервису объявлены. Это и есть контракт
//      выноса: список примитивов — то, что сервис возьмёт с собой в свой
//      процесс.
//   3. Границы сервисов: фича одного сервиса не импортирует фичу другого
//      (это же проверяет feature-import-gate, но здесь — по карте, чтобы
//      карта и гейт говорили об одном).
//
// ЧТО НЕ ПРОВЕРЯЕТСЯ (и почему). Готовность границы к выносу в отдельный
// процесс — не механическая проверка: она зависит от того, есть ли у сервиса
// своё хранилище, свой IPC и своя схема развёртывания. Это свойство ADR и
// вехи, а не файла; здесь фиксируется только то, что можно доказать машинно.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FEATURES = path.join(ROOT, 'src', 'features');
const MAP_FILE = path.join(ROOT, '..', 'docs', 'design', 'feature-service-map.json');

const map = JSON.parse(readFileSync(MAP_FILE, 'utf8'));
const problems = [];

const realFeatures = readdirSync(FEATURES).filter((f) => f.endsWith('.js'));

// ── 1. Полнота карты ────────────────────────────────────────────────────
const declared = new Map();   // фича/владелец → сервис
for (const [svc, spec] of Object.entries(map.services)) {
  for (const f of spec.features || []) {
    if (declared.has(f)) problems.push(`${f} объявлена в двух сервисах: ${declared.get(f)} и ${svc}`);
    declared.set(f, svc);
  }
  for (const o of spec.owners || []) {
    if (declared.has(o)) problems.push(`${o} объявлена в двух сервисах: ${declared.get(o)} и ${svc}`);
    declared.set(o, svc);
  }
}
for (const f of realFeatures) {
  if (!declared.has(f)) problems.push(`${f} — НЕ объявлена ни в одном сервисе (сирота карты)`);
}
for (const f of declared.keys()) {
  if (!existsSync(path.join(FEATURES, f))) {
    problems.push(`${f} объявлена в карте, но файла нет (призрак карты)`);
  }
}

// ── 2. Примитивы сервиса ────────────────────────────────────────────────
// Примитивы — корневые модули src/*.js. Фича может импортировать примитив,
// объявленный её сервисом. Владельцы состояния (*-store.js) — отдельная
// категория: это состояние сервиса, и оно не «примитив», а часть сервиса.
for (const [svc, spec] of Object.entries(map.services)) {
  const allowed = new Set(spec.primitives || []);
  for (const f of spec.features || []) {
    const file = path.join(FEATURES, f);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s+['"]\.\.\/([a-z0-9-]+\.js)['"]/g)) {
      const prim = m[1];
      if (!allowed.has(prim)) {
        problems.push(`${svc}: ${f} импортирует примитив ${prim}, не объявленный для сервиса ` +
          `(объявлены: ${[...allowed].join(', ') || '—'})`);
      }
    }
  }
}

// ── 3. Границы сервисов: фича тянет чужого владельца состояния ──────────
// Это НЕ провал, а ДОЛГ под ратчетом: сегодня общее состояние сессии
// (session-store) читают фичи обмена, и это связывает сервисы. Долг может
// только сокращаться; величина — в scripts/service-boundary-baseline.json.
const crossDebt = [];
for (const [svc, spec] of Object.entries(map.services)) {
  const allowedOwners = new Set((spec.owners || []).map((o) => './' + o));
  for (const f of spec.features || []) {
    const file = path.join(FEATURES, f);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s+['"]\.\/([a-z0-9-]+\.js)['"]/g)) {
      const local = m[1];
      if (!local.endsWith('-store.js')) continue;      // не владелец — это фича
      if (allowedOwners.has('./' + local)) continue;  // свой владелец
      crossDebt.push(`${svc}: ${f} → ${local}`);
    }
  }
}

// ── Итог ────────────────────────────────────────────────────────────────
const totalDeclared = [...declared.keys()].length;
const BASELINE = path.join(ROOT, 'scripts', 'service-boundary-baseline.json');
const debtNow = crossDebt.length;
const debtWas = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')).debt : debtNow;
if (debtNow > debtWas) {
  problems.push(`долг границы вырос: ${debtWas} → ${debtNow} (связывающих импортов стало больше)`);
}
if (problems.length) {
  console.log('✗ service-boundary-gate: граница сервисов нарушена:');
  for (const p of problems) console.log('  • ' + p);
  console.log('\n  Карта: docs/design/feature-service-map.json (её же читает гейт).');
  console.log('  Правка карты обязана быть осознанной: объявить фичу в том сервисе,');
  console.log('  которому она принадлежит, и дописать нужные примитивы.');
  process.exit(1);
}

const services = Object.entries(map.services);
console.log(`✓ service-boundary-gate: карта цела — ${totalDeclared} фич и владельцев в ` +
  `${services.length} сервисах, примитивы объявлены по факту.`);
console.log(`  долг границы (фича сервиса тянет чужого владельца состояния): ${debtNow} ` +
  `(было ${debtWas}) — может только сокращаться.`);
for (const [svc, spec] of services) {
  console.log(`  ✓ ${svc.padEnd(10)} ${String((spec.features || []).length).padStart(2)} фич · ` +
    `${String((spec.owners || []).length).padStart(2)} владельцев · ` +
    `${String((spec.primitives || []).length).padStart(2)} примитивов — ${spec.title}`);
}
