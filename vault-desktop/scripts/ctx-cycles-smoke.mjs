// ctx-cycles-smoke — валидация гейта циклов импортов (ADR-004 Этап D).
// Повторяет ctx-cycles-gate, но для calls.js + call-session/calls-deps:
// calls.js НЕ должен импортировать features друг в друга circular
// (call-session.js, calls-deps.js, relay.js, incoming.js).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'src');
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.js') || e.endsWith('.vue')) files.push(p);
  }
})(ROOT);
files.sort();
const rel = (p) => path.relative(ROOT, p);

// adjacency: A → B если A импортирует B
const adj = {};
for (const f of files) {
  const r = rel(f);
  adj[r] = new Set();
  const src = readFileSync(f, 'utf8');
  const re = /(?:import\s+(?:[^'"]*?\s+from\s+)?|require\()\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f), spec);
    const relTarget = rel(target);
    adj[r].add(relTarget);
  }
}

// 1. no self-import
// 2. no direct feature→feature import in src/features/ (circular risk)
const featureFiles = Object.keys(adj).filter((p) => p.startsWith('features/'));
const violations = [];
for (const f of featureFiles) {
  for (const t of adj[f]) {
    if (t === f) { violations.push(`${f} → self`); continue; }
    if (!t.startsWith('features/')) continue;
    // calls.js → call-session.js / calls-deps.js / relay.js / incoming.js
    if (t === f) continue;
    // Allow calls.js → call-session.js (owner, no cycle) — but NOT
    // call-session.js → calls.js (owner must not import feature).
    if (t === 'features/calls.js' && f === 'features/call-session.js') {
      violations.push(`${f} → calls.js (owner must not import feature)`);
    }
    if (t === 'features/calls-deps.js' && f === 'features/calls.js') {
      violations.push(`${f} → calls-deps.js (capability must not import calls)`);
    }
    if (t === 'features/relay.js' && f === 'features/calls.js') {
      violations.push(`${f} → relay.js (capability must not import calls)`);
    }
    if (t === 'features/incoming.js' && f === 'features/calls.js') {
      violations.push(`${f} → incoming.js (capability must not import calls)`);
    }
  }
}

// 3. DFS cycle detection (all pairs)
function findCycle() {
  const seen = new Set();
  const stack = [];
  const visit = (node) => {
    if (seen.has(node)) return;
    seen.add(node);
    stack.push(node);
    for (const t of adj[node] || []) {
      if (stack.includes(t)) {
        return { cycle: [...stack, t] };
      }
      const r = visit(t);
      if (r) return r;
    }
    stack.pop();
  };
  for (const f of Object.keys(adj)) {
    const r = visit(f);
    if (r) return r;
  }
  return null;
}

const checks = [];
const ok = (n, cond) => checks.push({ n, pass: !!cond });

ok('no self-import', !violations.some((v) => v.includes('self')));
ok('owner (call-session) does not import calls.js',
  !violations.some((v) => v.includes('call-session.js → calls.js')));
ok('calls.js does not import calls-deps/relay/incoming',
  !violations.some((v) => v.includes('calls.js → calls-deps') ||
    v.includes('calls.js → relay.js') ||
    v.includes('calls.js → incoming.js')));
const cycle = findCycle();
ok('no import cycles in src/', !cycle);
if (cycle) console.error('CYCLE:', cycle.cycle);

const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass);
console.log(`ctx-cycles-smoke: ${passed}/${checks.length} checks passed`);
if (failed.length) {
  console.error('FAIL:', failed.map((c) => c.n));
  process.exit(1);
}