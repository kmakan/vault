// Гейт: в Options API App.vue/components не должно быть ДУБЛИКАТОВ ключей.
//
// ЗАЧЕМ. `methods: { ... }` — это ОБЫЧНЫЙ литерал объекта. Два ключа с одним
// именем — не ошибка компиляции: JS молча оставляет ПОЗДНИЙ, а ранний
// исчезает. В App.vue так случилось с `login`:
//
//   2855  async login() { … api.login(...) … полный вход … }
//   3878  login() { return this.sessionStore.login(); }   ← тонкий прокси
//
// Прокси (ADR-004 A12, владелец сессии) перебил полный вход, а `@submit=
// "login"` в шаблоне зовёт именно метод. Итог: кнопка «Войти» только
// переключала флаг `isLoggedIn` — к IMAP не подключались ВООБЩЕ (проверено
// пробой на живой сборке: `calls: []` после submit формы).
//
// Ни один гейт этого не видел: сборка зелёная, смоуки зелёные, а вход не
// работает. Класс «зелёная сборка, сломанный прод» — но без ошибок в консоли.
//
// Правило: в Options API имя метода уникально. Если два метода нужны —
// разные имена (например, `login()` — вход, `markLoggedIn()` — флаг сессии).
//
// Проверка статическая: разбираем блоки `methods`/`computed` в .vue-файлах и
// ищем имена, встречающиеся дважды. Селектор «метода» — строка вида
// `    name(...) {` / `    async name(...) {` на уровне методов.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

// Блоки options верхнего уровня: `  methods: {`, `  computed: {`, …
const BLOCK_RE = /^ {2}(methods|computed|setup|data)\s*[:(]/;
// Метод: `    name(args) {` или `    async name(args) {` (4 пробела).
const METHOD_RE = /^ {4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/;
// Ключи, которые не являются методами (конструкции, попавшие под регулярку).
const NOT_METHODS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do']);

const files = [];
for (const f of readdirSync(SRC, { withFileTypes: true })) {
  if (f.isFile() && f.name.endsWith('.vue')) files.push(path.join(SRC, f.name));
  if (f.isDirectory() && f.name === 'components') {
    for (const c of readdirSync(path.join(SRC, f.name))) {
      if (c.endsWith('.vue')) files.push(path.join(SRC, f.name, c));
    }
  }
}

const problems = [];
let blocks = 0, methods = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (BLOCK_RE.test(l)) starts.push(i); });
  for (let bi = 0; bi < starts.length; bi++) {
    const start = starts[bi];
    const end = bi + 1 < starts.length ? starts[bi + 1] : lines.length;
    blocks++;
    const seen = new Map();
    for (let i = start; i < end; i++) {
      const m = METHOD_RE.exec(lines[i]);
      if (!m) continue;
      const name = m[1];
      if (NOT_METHODS.has(name)) continue;
      methods++;
      if (!seen.has(name)) seen.set(name, []);
      seen.get(name).push(i + 1);
    }
    for (const [name, at] of seen) {
      if (at.length > 1) {
        const rel = path.relative(ROOT, file);
        problems.push(
          `${rel}: ${name} — объявлен ${at.length} раза (строки ${at.join(', ')}). ` +
          'В Options API это обычный литерал объекта: ПОЗДНИЙ перебивает ранний, ' +
          'ранний молча исчезает. Переименуй один из них.',
        );
      }
    }
  }
}

if (problems.length) {
  console.log('✗ options-dup-gate: ' + problems.length + ' дубликат(ов) ключей Options API');
  for (const p of problems) console.log('  ' + p);
  console.log('\n  Поздний перебивает ранний — «метод есть, но работает не тот».');
  process.exit(1);
}
console.log('✓ options-dup-gate: ' + files.length + ' .vue, ' + blocks + ' блоков options, '
  + methods + ' методов — дубликатов ключей нет');
