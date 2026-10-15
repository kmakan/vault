// Модуль-владелец состояния групп (ADR-004, Этап A9).
// ТЕСТ ПРОВЕРЯЕТ НЕ СТРОКИ, А ИМУТАБЕЛЬНОСТЬ, И В ЭТОМ СМЫСЛЕ «ИМУТАБЕЛЬНОСТЬ»
// ЗДЕСЬ ОЧЕНЬ ОСТОРОЖНОЕ СЛОВО. Состояnие групп — часть E2E-шифрования:
// group key ошибается → шифрование падает для всей группы. Поэтому тест
// закрывает не «функции вызываются», а «ничто не происходит тихо».
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const { createGroupsStore } = await import(path.join(ROOT, 'src', 'features', 'groups-store.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ ПРОВАЛ:', name); }
};

console.log('\nADR-004 Этап A9 · модуль-владелец состояния групп');

// ── Создание ──────────────────────────────────────────────────────────
const s = createGroupsStore();
ok('состояние начинается пустым',
  typeof s.state.groupKeys === 'object' && Object.keys(s.state.groupKeys).length === 0 &&
  typeof s.state.groupAvatars === 'object' && Object.keys(s.state.groupAvatars).length === 0);
ok('созданные сторы независимы — второй не видит первый',
  (() => { const a = createGroupsStore(), b = createGroupsStore(); a.setGroupKey('g1', 'K1'); return b.getGroupKey('g1') === undefined; })());

// ── groupKeys ─────────────────────────────────────────────────────────
ok('getGroupKey отсутствующего → undefined (не исключение)', s.getGroupKey('nope') === undefined);
ok('setGroupKey записывает и возвращает', s.setGroupKey('g1', 'KEY1') === 'KEY1');
ok('getGroupKey читает обратно', s.getGroupKey('g1') === 'KEY1');
ok('setGroupKey перезаписывает', (s.setGroupKey('g1', 'KEY2'), s.getGroupKey('g1') === 'KEY2'));
ok('getGroupKey(неизвестный id) → undefined', s.getGroupKey('g2') === undefined);

// ── groupAvatars ──────────────────────────────────────────────────────
ok('getGroupAvatar отсутствующего → undefined', s.getGroupAvatar('nope') === undefined);
ok('setGroupAvatar записывает и возвращает', s.setGroupAvatar('g1', 'AVATAR1') === 'AVATAR1');
ok('getGroupAvatar читает обратно', s.getGroupAvatar('g1') === 'AVATAR1');
ok('setGroupAvatar перезаписывает', (s.setGroupAvatar('g1', 'AVATAR2'), s.getGroupAvatar('g1') === 'AVATAR2'));

// ── Граница ───────────────────────────────────────────────────────────
ok('getGroupKey(null) не падает', s.getGroupKey(null) === undefined);
ok('getGroupAvatar(null) не падает', s.getGroupAvatar(null) === undefined);
ok('setGroupKey(null, key) запишет по ключу "null"', s.setGroupKey(null, 'KEY_N') === 'KEY_N');
ok('getGroupKey после setGroupKey(null) читает обратно', s.getGroupKey(null) === 'KEY_N');

// ── Гейт: владелец ни от чего снаружи не зависит ──────────────────────
const body = readFileSync(path.join(ROOT, 'src', 'features', 'groups-store.js'), 'utf8');
const imports = [...body.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
ok('нет НИ ОДНОГО импорта — модуль не зависит ни от чего, включая фреймворк',
  imports.length === 0, 'найдено: ' + JSON.stringify(imports));
ok('нет доступа к ctx', !/\bctx\b/.test(body.replace(/\/\/.*$/gm, '')));
ok('нет доступа к api, crypto, invoke', !/\b(api|crypto|invoke)\s*\./.test(body));

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
