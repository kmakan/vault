// Node-смоук features/migrate.js — миграция localStorage при смене email.
// Мокаем ctx.migrateOwnProfile + localStorage. Без Vue/Tauri.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/migrate-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// Простая in-memory реализация localStorage для Node.js
const _ls = new Map();
globalThis.localStorage = {
  getItem: (k) => (_ls.has(k) ? _ls.get(k) : null),
  setItem: (k, v) => _ls.set(k, String(v)),
  removeItem: (k) => _ls.delete(k),
  key: (i) => Array.from(_ls.keys())[i],
  get length() { return _ls.size; },
};

const { migrateLocalStores } = await import(ROOT + '/src/features/migrate.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx() {
  return { migrateOwnProfile: async (...a) => { globalThis.__migrateProfileCalls.push(a); } };
}
globalThis.__migrateProfileCalls = [];

// 1. Пустой вызов / одинаковые email → no-op
_ls.clear(); globalThis.__migrateProfileCalls.length = 0;
await migrateLocalStores(makeCtx(), '', 'b@x');
await migrateLocalStores(makeCtx(), 'a@x', 'a@x');
check('пустой/одинаковый email — no-op, migrateOwnProfile не звался',
  globalThis.__migrateProfileCalls.length === 0);

// 2. Нет источника → просто вызываем migrateOwnProfile
_ls.clear(); globalThis.__migrateProfileCalls.length = 0;
await migrateLocalStores(makeCtx(), 'a@x', 'b@x');
check('нет источников — migrateOwnProfile вызван',
  globalThis.__migrateProfileCalls.length === 1);

// 3. Массивы: дедуп по id, цель побеждает
_ls.clear(); globalThis.__migrateProfileCalls.length = 0;
localStorage.setItem('vault-notes-a@x', JSON.stringify([{ id: 1, text: 'old' }, { id: 2, text: 'keep' }]));
localStorage.setItem('vault-notes-b@x', JSON.stringify([{ id: 1, text: 'NEW' }, { id: 3, text: 'b-only' }]));
await migrateLocalStores(makeCtx(), 'a@x', 'b@x');
const notes = JSON.parse(localStorage.getItem('vault-notes-b@x'));
check('массив: дедуп по id (3 уникальных, не 4)', notes.length === 3, notes);
check('массив: цель побеждает (id=1 → NEW)', notes.find(n => n.id === 1).text === 'NEW');
check('массив: источник удалён', localStorage.getItem('vault-notes-a@x') === null);

// 4. Объекты: merge, цель побеждает
_ls.clear();
localStorage.setItem('vault-reads-sent-a@x', JSON.stringify({ m1: { from: 'a' }, m2: true }));
localStorage.setItem('vault-reads-sent-b@x', JSON.stringify({ m1: { from: 'b' }, m3: true }));
await migrateLocalStores(makeCtx(), 'a@x', 'b@x');
const reads = JSON.parse(localStorage.getItem('vault-reads-sent-b@x'));
check('объект: merge (m1/m2/m3)', reads.m1.from === 'b' && reads.m2 === true && reads.m3 === true);

// 5. Битый JSON источника → источник удалён
_ls.clear();
localStorage.setItem('vault-reactions-a@x', '{broken');
await migrateLocalStores(makeCtx(), 'a@x', 'b@x');
check('битый JSON источника — источник удалён', localStorage.getItem('vault-reactions-a@x') === null);

// 6. Битый JSON цели → источник валиден, записываем его
_ls.clear();
localStorage.setItem('vault-edits-a@x', JSON.stringify({ fix: true }));
localStorage.setItem('vault-edits-b@x', '{broken');
await migrateLocalStores(makeCtx(), 'a@x', 'b@x');
check('битый JSON цели — источник записан', JSON.parse(localStorage.getItem('vault-edits-b@x')).fix === true);

// 7. Регистр-вариант: oldEmail='A@X' → alt='a@x' (lowercase)
_ls.clear();
localStorage.setItem('vault-notes-a@x', JSON.stringify([{ id: 9 }]));
await migrateLocalStores(makeCtx(), 'A@X', 'b@x');
check('регистр-вариант: ключ a@x найден через alt (oldEmail lowercase)',
  localStorage.getItem('vault-notes-a@x') === null);

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
