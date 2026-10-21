// Node-смоук src/note-id.js — идентификатор заметки для себя.
//
// Формула id заметки была в трёх местах и копии разошлись (в chat.js время
// инъецировалось ради чистоты смоука, в attachments.js — бралось из Date.now()).
// Проверяем, что правило одно: префикс, база по времени и случайная часть.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/note-id-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

writeFileSync(MOCKS + '/note-id.mjs', readFileSync(path.join(ROOT, 'src', 'note-id.js'), 'utf8'));
const { noteId } = await import(MOCKS + '/note-id.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Формат ─────────────────────────────────────────────────────────────
{
  const id = noteId(1700000000000);
  check('префикс note-', id.startsWith('note-'), id);
  check('время в base36', id.startsWith('note-' + (1700000000000).toString(36)), id);
  check('случайная часть — 5 символов', id.length === 'note-'.length + (1700000000000).toString(36).length + 5, id);
}
{
  // Тот же now → та же база времени (инъекция нужна для чистоты смоуков).
  const base = 'note-' + (1700000000000).toString(36);
  const a = noteId(1700000000000);
  const b = noteId(1700000000000);
  check('одно и то же время — одна база', a.startsWith(base) && b.startsWith(base), [a, b]);
}
{
  // Разные вызовы — разные id (случайная часть различает).
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(noteId(1700000000000));
  check('200 вызовов дали разные id', ids.size === 200, ids.size);
}
{
  const id = noteId();
  check('без now берётся текущее время', typeof id === 'string' && id.startsWith('note-'), id);
}
{
  // id не должен содержать символов, ломающих ключ localStorage/поиск.
  const id = noteId(1700000000000);
  check('id без пробелов и спецсимволов', /^[a-z0-9-]+$/.test(id), id);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
