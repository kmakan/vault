// Гейт: в Options API не должно быть ДУБЛИКАТОВ ключей — ни внутри блока,
// ни МЕЖДУ блоками.
//
// ЗАЧЕМ (внутри блока). `methods: { ... }` — это ОБЫЧНЫЙ литерал объекта. Два
// ключа с одним именем — не ошибка компиляции: JS молча оставляет ПОЗДНИЙ, а
// ранний исчезает. В App.vue так случилось с `login`:
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
// ЗАЧЕМ (между блоками). В Vue 3 прокси компонента читает поля по порядку:
// setupState → data → props → ctx (где живут computed и methods). Поэтому:
//
//   data ∩ computed → компьютед НЕДОСТИЖИМ: шаблон и код читают поле данных,
//                    а не владельца. В App.vue так было с состоянием «папок»:
//                    `...foldersState()` в data() давало `folderDialogOpen` и
//                    `chatFolderNewName`, а компьютед-прокси на uiStore был
//                    перекрыт. Итог (найдено на устройстве 20.10): диалог
//                    «Новая папка» открывался, имя вводилось, но модуль читал
//                    uiStore — ПУСТОЙ, и папка создавалась БЕЗ ИМЕНИ.
//   data ∩ methods  → метод недостижим (тот же порядок приоритетов).
//   computed ∩ methods → метод недостижим: computed определяется на ctx
//                    ПОЗЖЕ methods и перекрывает его.
//
// Правило: одно состояние — один владелец, одно имя. Если поле нужно и в
// данных, и у владельца — оставьте одно (прокси-компьютед) и уберите второе.
//
// Проверка статическая: разбираем блоки `data`/`computed`/`methods` в .vue,
// ключи `data` собираем вместе со спредами (`...foldersState()`) — спред
// разворачивается ЖИВЫМ импортом state-модуля (контракт ADR-001 Этап 1:
// state-файл не импортирует ничего, поэтому поднимается в Node без
// localStorage и без Tauri).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

// Блоки options верхнего уровня: `  methods: {`, `  computed: {`, …
const BLOCK_RE = /^ {2}(methods|computed|setup|data)\s*[:(]/;
// Метод: `    name(args) {` или `    async name(args) {` (4 пробела).
const METHOD_RE = /^ {4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/;
// Ключ поля данных верхнего уровня: `      name: …` (6 пробелов внутри data()).
const DATA_KEY_RE = /^ {6}([A-Za-z_$][\w$]*)\s*:/;
// Ключ компьютеда: `    name: {` (4 пробела) либо `    name() {` (метод-стиль).
const COMPUTED_KEY_RE = /^ {4}([A-Za-z_$][\w$]*)\s*(:\s*\{|\([^()]*\)\s*\{)/;
// Спред состояния: `      ...foldersState(),`
const SPREAD_RE = /^ {6}\.\.\.([A-Za-z_$][\w$]*)\s*\(\)/;
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

// ── state-модули: имя фабрики → файл (для живого разворачивания спреда) ──
const stateFiles = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && e.name === 'state.js') stateFiles.push(p);
  }
};
if (existsSync(path.join(SRC, 'features'))) walk(path.join(SRC, 'features'));

const spreadCache = new Map();
async function spreadKeys(factoryName) {
  if (spreadCache.has(factoryName)) return spreadCache.get(factoryName);
  let keys = [];
  for (const sf of stateFiles) {
    const src = readFileSync(sf, 'utf8');
    if (!new RegExp(`export\\s+function\\s+${factoryName}\\s*\\(`).test(src)) continue;
    try {
      const mod = await import(pathToFileURL(sf).href);
      const obj = typeof mod[factoryName] === 'function' ? mod[factoryName]() : mod[factoryName];
      keys = obj && typeof obj === 'object' ? Object.keys(obj) : [];
    } catch (e) {
      console.log(`  ! не удалось поднять state-модуль ${path.relative(ROOT, sf)}: ${e.message}`);
      keys = [];
    }
    break;
  }
  spreadCache.set(factoryName, keys);
  return keys;
}

// ── Разбор .vue: блоки и их ключи ────────────────────────────────────────
function parseBlocks(lines) {
  const starts = [];
  lines.forEach((l, i) => { if (BLOCK_RE.test(l)) starts.push(i); });
  const out = [];
  for (let bi = 0; bi < starts.length; bi++) {
    const start = starts[bi];
    const end = bi + 1 < starts.length ? starts[bi + 1] : lines.length;
    const kind = BLOCK_RE.exec(lines[start])[1];
    const keys = [];
    const methods = [];
    const spreads = [];
    for (let i = start; i < end; i++) {
      const m = METHOD_RE.exec(lines[i]);
      if (m && !NOT_METHODS.has(m[1]) && kind !== 'computed') { methods.push({ name: m[1], line: i + 1 }); continue; }
      if (kind === 'computed') {
        const c = COMPUTED_KEY_RE.exec(lines[i]);
        if (c) { keys.push({ name: c[1], line: i + 1 }); continue; }
        continue;
      }
      const d = DATA_KEY_RE.exec(lines[i]);
      if (d) { keys.push({ name: d[1], line: i + 1 }); continue; }
      const s = SPREAD_RE.exec(lines[i]);
      if (s) spreads.push({ name: s[1], line: i + 1 });
    }
    out.push({ kind, start: start + 1, end, keys, methods, spreads });
  }
  return out;
}

const problems = [];
let blocks = 0;
let methods = 0;
let dataKeys = 0;
let spreadKeysTotal = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const parsed = parseBlocks(lines);
  const rel = path.relative(ROOT, file);
  for (const b of parsed) {
    blocks++;
    methods += b.methods.length;
    dataKeys += b.keys.length;

    // 1) дубликаты ВНУТРИ блока
    const seen = new Map();
    for (const m of b.methods) {
      if (!seen.has(m.name)) seen.set(m.name, []);
      seen.get(m.name).push(m.line);
    }
    for (const [name, at] of seen) {
      if (at.length > 1) {
        problems.push(
          `${rel}: ${name} — объявлен ${at.length} раза (строки ${at.join(', ')}). ` +
          'В Options API это обычный литерал объекта: ПОЗДНИЙ перебивает ранний, ' +
          'ранний молча исчезает. Переименуй один из них.',
        );
      }
    }

    // 2) коллизии МЕЖДУ блоками (data/computed/methods одного компонента)
    if (b.kind !== 'data') continue;
    const dataNames = new Map(b.keys.map((k) => [k.name, k.line]));
    const spreadNames = [];
    for (const sp of b.spreads) {
      const keys = await spreadKeys(sp.name);
      spreadKeysTotal += keys.length;
      for (const k of keys) {
        spreadNames.push({ name: k, line: sp.line, via: sp.name });
        dataNames.set(k, sp.line);
      }
    }
    for (const other of parsed) {
      if (other.kind === 'data') continue;
      for (const k of other.keys) {
        if (!dataNames.has(k.name)) continue;
        const via = spreadNames.find((s) => s.name === k.name);
        problems.push(
          `${rel}: «${k.name}» — есть и в data()${via ? ` (через спред ...${via.via}())` : ''}, `
          + `и в ${other.kind}() (строка ${k.line}). В Vue прокси читает setupState → data → props → ctx, `
          + 'поэтому data перекрывает computed: значение из владельца НЕДОСТИЖИМО, '
          + 'а метод с тем же именем не вызывается. Оставь одно объявление.',
        );
      }
      for (const m of other.methods) {
        if (!dataNames.has(m.name)) continue;
        problems.push(
          `${rel}: «${m.name}» — есть и в data(), и в ${other.kind}() (строка ${m.line}). `
          + 'data перекрывает метод: вызов из шаблона уйдёт в поле данных.',
        );
      }
    }
  }
}

if (problems.length) {
  console.log('✗ options-dup-gate: ' + problems.length + ' проблем(ы) с ключами Options API');
  for (const p of problems) console.log('  ' + p);
  console.log('\n  Поздний перебивает ранний; data перекрывает computed — «метод есть, но работает не тот».');
  process.exit(1);
}
console.log('✓ options-dup-gate: ' + files.length + ' .vue, ' + blocks + ' блоков options, '
  + methods + ' методов, ' + dataKeys + ' полей data (+' + spreadKeysTotal + ' из спредов) — коллизий нет');
