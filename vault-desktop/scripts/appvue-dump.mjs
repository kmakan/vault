import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Печатает исходник методов App.vue по именам — чтобы переносить их не
// перепечатывая (перепечатка = новый код = новый баг).
const names = process.argv.slice(2);
const P = path.resolve(import.meta.dirname, '..', 'src', 'App.vue');
const lines = readFileSync(P, 'utf8').split('\n');
const start = lines.findIndex((l) => l.trim() === 'methods: {');
let depth = 0, end = start;
for (let i = start; i < lines.length; i++) {
  depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
  if (depth === 0 && i > start) { end = i; break; }
}
const block = lines.slice(start + 1, end);
const M = /^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/;
let out = '';
for (let i = 0; i < block.length; i++) {
  const m = M.exec(block[i]);
  if (!m) continue;
  const name = m[1];
  let b = (block[i].match(/{/g) || []).length - (block[i].match(/}/g) || []).length;
  let j = i + 1;
  while (b > 0 && j < block.length) {
    b += (block[j].match(/{/g) || []).length - (block[j].match(/}/g) || []).length;
    j++;
  }
  if (!names.includes(name)) { i = j - 1; continue; }
  out += `\n/* ==== ${name} (App.vue L${start + 2 + i}) ==== */\n`;
  out += block.slice(i, j).join('\n') + '\n';
  i = j - 1;
}
process.stdout.write(out);