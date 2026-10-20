// Реестр наборов мутаций.
//
// Каждый набор — «фича + смоук + список поломок, которые смоук обязан
// поймать». Реестр — единственное место, где перечислено, что мы проверяем
// мутационно; сам гейт (scripts/mutation-gate.mjs) их прогоняет.
//
// НАБОРЫ ДОЛЖНЫ ПОКРЫВАТЬ ВСЕ ФИЧИ СО СМОУКОМ. Гейт
// scripts/feature-coverage.mjs требует: у каждой features/*.js есть смоук,
// а у каждого смоука — набор мутаций. Иначе «покрытие» — иллюзия.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SETS_DIR = path.resolve(import.meta.dirname, 'sets');

export function loadSets() {
  const files = readdirSync(SETS_DIR).filter((f) => f.endsWith('.mjs')).sort();
  return files.map((f) => pathToFileURL(path.join(SETS_DIR, f)).href);
}

export async function loadAllSets() {
  const out = [];
  for (const href of loadSets()) {
    const mod = await import(href);
    out.push(mod.default);
  }
  return out;
}
