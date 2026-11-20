#!/usr/bin/env node
// Гейт границ крейтов (ADR-006 §9.1, §9.4).
//
// Правило стрелок: фича может зависеть только от общих крейтов
// (social-model/social-rights/storage-api), НЕ от другой фичи. Единственное
// место, где фичи видят друг друга, — композиционный корень social-app.
//
// Существующие рёбра «фича → фича» зафиксированы в BASELINE как долг: новые
// рёбра гейт не пускает, старые не ломают сборку. Ратчёт может только
// уменьшаться — при устранении долга убрать строку из BASELINE.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cratesDir = join(here, '..', 'crates');

const ROOT = 'social-app';
const SHARED = new Set(['social-model', 'social-rights', 'storage-api']);
const FEATURES = new Set([
  'social-contacts',
  'social-audience',
  'social-post',
  'social-media',
  'social-delivery',
  'social-feed',
  'social-profile',
  'social-sync',
]);

// Унаследованные рёбра между фичами (до введения корня).
const BASELINE = new Set([
  'social-sync->social-feed',
  'social-sync->social-post',
  'social-feed->social-post',
  'social-delivery->social-audience',
]);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function pathDeps(from) {
  const file = join(cratesDir, from, 'Cargo.toml');
  const text = readFileSync(file, 'utf8');
  const deps = [];
  let inDeps = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inDeps = /^\[(dependencies|dev-dependencies)\]$/.test(trimmed);
      continue;
    }
    if (!inDeps) continue;
    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bpath\s*=/);
    if (m) deps.push(m[1]);
  }
  return deps;
}

const dirs = readdirSync(cratesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

let checked = 0;
for (const from of dirs) {
  if (!FEATURES.has(from) && from !== ROOT) continue;
  for (const to of pathDeps(from)) {
    if (!FEATURES.has(to) && to !== ROOT) continue;
    if (from === ROOT) continue; // корень связывает все фичи — это его назначение
    if (SHARED.has(to)) continue;
    const edge = `${from}->${to}`;
    checked += 1;
    if (!BASELINE.has(edge)) {
      fail(`новое ребро «${edge}»: фича не должна зависеть от другой фичи. Связка — только в social-app`);
    }
  }
}

console.log(`OK: crate boundary — ${dirs.length} крейтов, ${checked} рёбер в baseline, новых нет`);
