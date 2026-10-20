// ЕДИНЫЙ ИСТОЧНИК МЕТРИК ГРАНИЦЫ Rust/JS (ADR-005, W0, t_8a422c38).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. `audit:arch` (отчёт человеку) и ратчет «JS-логика»
// (гейт сборки) обязаны считать ОДНО И ТО ЖЕ одним кодом. В проекте уже был
// случай, когда инвентарь показывал 178 методов с логикой, а audit-arch — 166,
// потому что правило делегата было написано дважды и разошлось. Два числа об
// одной величине — значит обоим перестают верить, и метрика перестаёт быть
// инструментом.
//
// ЧТО СЧИТАЕТСЯ. Три независимые величины (ADR-005 §5):
//   1. `ctx`-ссылки — сколько раз JS берёт состояние из компонента;
//   2. методы `App.vue` с собственной логикой — сколько решений живёт в монолите;
//   3. протокольные решения в JS — сборка/разбор конвертов, машина состояний
//      звонка, TTL/истечение. Это то, что по R1 обязано быть в Rust.
//
// ПОЧЕМУ САМОПРОВЕРКА ВСТРОЕНА, А НЕ ОПИСАНА В ДОКУМЕНТЕ. 19.10.2026 аудит
// показывал «KDF в JS» из-за регекспа без границ слова: `scrypt` находился
// внутри `isCryptoReady` («i-sCrypt-o»). Инструмент врал, и никто этого не
// видел, потому что проверяли глазами отчёт, а не инструмент. Поэтому каждый
// детектор здесь обязан пройти пару «заведомо плохо / заведомо чисто» при
// КАЖДОМ запуске: сломавшийся регексп валит гейт, а не занижает цифру молча.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const SRC = path.resolve(import.meta.dirname, '..', '..', 'src');

// ── Список JS-файлов фронта ────────────────────────────────────────────
// Только `.js`: `.vue` проверяет свой гейт (`check-template.cjs`, класс E4),
// а протокольные решения по ADR-005 §6/W4 живут в фичах и модулях формата.
export function listJsFiles(root = SRC) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.js')) out.push(p);
    }
  })(root);
  return out.sort();
}

// ── Детекторы ──────────────────────────────────────────────────────────
// Крипто: hard — то, что обязано быть в Rust. Границы слова и флаг `g`
// обязательны (см. историю дефекта в шапке).
export const CRYPTO_MARKERS = [
  { id: 'crypto-subtle',
    re: /crypto\.subtle\.(importKey|deriveKey|encrypt|decrypt|sign|verify|digest)/g,
    why: 'крипто-операция в JS: WebView получает ключи' },
  { id: 'hmac-sha',
    re: /createHmac|createHash|subtle\.digest\(['"]SHA-?/g,
    why: 'своя хеш-функция вместо Rust' },
  { id: 'pbkdf',
    re: /\b(pbkdf2|scrypt|argon2)/gi,
    why: 'KDF в JS' },
];

// Протокольные решения (ADR-005 §5, R1). Каждый маркер — решение, а не
// «упоминание»: вызов сборки/разбора конверта, переход состояния звонка,
// арифметика TTL. Декларации (`function parseEnvelope(`) исключены
// lookbehind'ом: определение функции — не решение о формате.
export const PROTOCOL_MARKERS = [
  { id: 'envelope-parse',
    re: /(?<!function )\b(?:parseEnvelope|parseEnvelopeSafe)\s*\(/g,
    why: 'разбор wire-конверта в JS: решение «что это за конверт» — в Rust' },
  { id: 'envelope-build',
    re: /(?<!function )\bbuildEnvelope\s*\(/g,
    why: 'сборка wire-конверта в JS: формат принадлежит Rust' },
  { id: 'envelope-json',
    re: /JSON\.parse\s*\(\s*[^)\n]{0,60}?\b(?:env|envelope|wire|plain|plaintext|decrypted)\b/gi,
    why: 'JSON.parse по конверту/плейнтексту: разбор протокола в JS' },
  { id: 'call-state',
    re: /\b(?:setCallState\s*\(\s*|callState\s*(?:===|!==|==|!=|=)\s*)['"](?:idle|ringing|active|ended|declined|missed|cancelled|busy)['"]/g,
    why: 'переход состояния звонка в JS: машина состояний — в Rust (W4)' },
  // Время жизни сообщения — ПРАВИЛО ПРОТОКОЛА (ADR-005 R1, W4): с 20.10
  // арифметика живёт в Rust (vault_client::vault::ephemeral), JS зовёт мост.
  //
  // Ловим АРИФМЕТИКУ (`ttl * 1000`, `base + ttl*1000`) — это и есть решение.
  // Поле `expireAt`/`expiresAt` больше не ловим: в UI-модели это ЗНАЧЕНИЕ ИЗ
  // RUST (момент истечения приезжает готовым), а не вычисление. Прежняя
  // регулярка ловила и имя поля, и строку склейки ('... ttl=' + ttl + ' ...'),
  // и текст комментария — то есть ловила не решение, а совпадения слов.
  { id: 'ttl',
    re: /\bttl\b\s*[*+]\s*(?:\d|ttl\b)/g,
    why: 'арифметика TTL/истечения в JS: время жизни сообщения — правило протокола (решение — в Rust)' },
];

const hits = (src, markers) => markers
  .map((m) => ({ id: m.id, why: m.why, n: (src.match(m.re) || []).length }))
  .filter((h) => h.n > 0);

export const cryptoHits = (src) => hits(src, CRYPTO_MARKERS);
// Комментарии не считаются: правило протокола — это КОД, а не текст про него
// (иначе «ttl*1000» в пояснении считалось бы решением в JS).
export const protocolHits = (src) => hits(stripComments(src), PROTOCOL_MARKERS);

// ── ctx-ссылки ─────────────────────────────────────────────────────────
// ОПРЕДЕЛЕНИЕ ОДНО — и оно же у `ctx-ratchet-gate.mjs`, иначе получаются «два
// числа об одном и том же», которым перестают верить (урок ADR-003).
// Правило измерения:
//   * считаются только файлы-потребители компонента: `src/features/*.js` +
//     `src/api.js` (там `ctx` и живёт; в `api.js` — как транспорт в мост);
//   * комментарии вырезаются: `// ctx.channelPosts` в doc-комментарии нового
//     owner-модуля — это не связь, а описание;
//   * считается каждое вхождение `ctx.<имя>` (не уникальные имена) — величина
//     «сколько мест придётся править», а не «сколько разных полей».
// Историческая справка: до W0 `audit:arch` показывал 735 (сырой счёт по всем .js,
// включая комментарии), а гейт — 686 (это правило). Расхождение в 49 ссылок и
// было поводом спросить «откуда новая ctx». Новых ссылок не было — были две
// разные метрики.
export const CTX_READ = /ctx\.[A-Za-z_$][\w$]*/g;
export const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
export const countCtxRefs = (src) => (stripComments(src).match(CTX_READ) || []).length;
// То же число, но по ВСЕМ .js дерева: нужен только как справка в аудите, чтобы
// расхождение с гейтом было видно числом, а не выяснялось заново.
export const countCtxRefsRaw = (src) => (src.match(/\bctx\.[A-Za-z_$][\w$]*/g) || []).length;

// Имена полей — чтобы нарушение называло себя («берёт НОВЫЕ поля: x, y»), а не
// только увеличивало счётчик: по числу нельзя понять, что именно чинить.
export const ctxFields = (src) =>
  [...new Set([...stripComments(src).matchAll(/ctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();

// ── Инвентарь App.vue ──────────────────────────────────────────────────
// Делегат — метод, тело которого РОВНО `return <вызов>(<аргументы>);`.
// Цепочка свойств допускается: `return this.callSession.startCallClock();` —
// это ТОЖЕ делегат (вызов у владельца), а не логика в монолите. Раньше
// регулярка допускала только одно свойство (`X.y(...)`), и делегаты вида
// `this.<владелец>.<метод>()` попадали в «логику» (найдено на живом App.vue
// 20.10: startCallClock/stopCallClock и прокси login).
// Правило совпадает с `appvue-inventory.mjs`. Всё остальное — логика.
// Делегат — метод, тело которого РОВНО `return <вызов>(<аргументы>);`.
//
// Раньше это проверялось регуляркой `\([^;]*\)` — и она НЕ узнавала
// делегата, у которого в аргументах есть стрелка с телом: `Mod.foo({ cb: () => {
// x = 1; } })`. Такой «свой» метод попадал в «логику» (найдено на живом
// App.vue 20.10: loadProfiles/loadLocalProfiles/loginWithRecovery/…).
// Теперь аргументы разбираются по балансу скобок: `;` внутри вложенной стрелки
// допустим, а тело по-прежнему должно быть РОВНО одним выражением.
const CALL_HEAD_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/;
function isDelegateBody(body) {
  const t = String(body).trim();
  if (!t.startsWith('return ') || !t.endsWith(';')) return false;
  const inner = t.slice(7, -1);
  if (!CALL_HEAD_RE.test(inner)) return false;
  let depth = 0;
  let quote = null;
  let callEnd = -1;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth < 0) return false;
      // Вызов закрылся — дальше в теле ничего быть не должно (иначе это уже
      // два выражения, а не делегат).
      if (depth === 0) { callEnd = i; break; }
    }
  }
  if (callEnd < 0) return false;
  return inner.slice(callEnd + 1).trim() === '';
}
const METHOD_RE = /^\s{4}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/;
// Тело метода — между СКОБКАМИ тела. Скобки ищем С КОНЦА: иначе параметр со
// значением по умолчанию вида `opts = {}` даёт «первую» `{` не ту, и тело
// делегата читается как мусор — метод-делегат попадал в «логику» (найдено на
// живом App.vue 20.10: `sendCallEnvelope(peer, payload, opts = {})`).
const inner = (s) => {
  const b = s.lastIndexOf('}');
  if (b < 0) return '';
  let depth = 0;
  let a = -1;
  for (let i = b; i >= 0; i--) {
    if (s[i] === '}') depth++;
    else if (s[i] === '{') {
      depth--;
      if (depth === 0) { a = i; break; }
    }
  }
  return a < 0 ? '' : s.slice(a + 1, b);
};
const braces = (s) => (s.match(/{/g) || []).length - (s.match(/}/g) || []).length;

export function appVueInventory(appSource) {
  const lines = appSource.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'methods: {');
  if (start < 0) return { found: false, lines: lines.length, methods: 0, delegates: 0, own: 0 };

  let depth = 0;
  let end = start;
  for (let i = start; i < lines.length; i++) {
    depth += braces(lines[i]);
    if (depth === 0 && i > start) { end = i; break; }
  }
  const block = lines.slice(start + 1, end);

  let methods = 0;
  let delegates = 0;
  const ownNames = [];
  for (let i = 0; i < block.length; i++) {
    const m = METHOD_RE.exec(block[i]);
    if (!m) continue;
    const name = m[1];
    const bal = braces(block[i]);
    let body = inner(block[i]);
    if (bal > 0) {
      // Тело многострочного метода — до закрывающей скобки на нулевой глубине.
      let b = bal;
      let j = i + 1;
      while (j < block.length && b > 0) {
        b += braces(block[j]);
        j++;
      }
      body = inner(block.slice(i, j).join('\n'));
      i = j - 1;
    }
    methods++;
    if (isDelegateBody(body)) delegates++;
    else ownNames.push(name);
  }
  return { found: true, lines: lines.length, blockLines: end - start - 1, methods, delegates, own: ownNames.length, ownNames };
}

// ── Самопроверка детекторов ────────────────────────────────────────────
// Три пары «должно поймать / должно не поймать». Проверяется на КАЖДОМ запуске
// audit:arch и ратчета. Ломается регексп — падает сборка с точным диагнозом.
export function selfTest() {
  const cases = [
    // (1) крипто: настоящий KDF ловится, `isCryptoReady` — нет.
    { name: 'crypto: pbkdf2 пойман',        src: "await pbkdf2(pass, salt);",           fn: cryptoHits, want: 1, id: 'pbkdf' },
    { name: 'crypto: isCryptoReady чист',   src: 'if (isCryptoReady()) { return; }',     fn: cryptoHits, want: 0, id: null },
    // (2) конверт: вызов ловится, объявление функции — нет.
    { name: 'envelope: разбор пойман',      src: 'const env = parseEnvelope(text);',     fn: protocolHits, want: 1, id: 'envelope-parse' },
    { name: 'envelope: объявление чисто',   src: 'export function parseEnvelope(s) {',   fn: protocolHits, want: 0, id: null },
    // (3) состояние звонка: переход ловится, UI-строка — нет.
    { name: 'call-state: переход пойман',   src: "useSession().setCallState('active');", fn: protocolHits, want: 1, id: 'call-state' },
    { name: 'call-state: UI-метка чиста',   src: "const label = t('call_active');",      fn: protocolHits, want: 0, id: null },
    // (3a) TTL: арифметика — решение протокола (ловится), поле из Rust — нет.
    { name: 'ttl: арифметика в JS поймана', src: 'const e = base + ttl * 1000;',        fn: protocolHits, want: 1, id: 'ttl' },
    { name: 'ttl: поле из Rust — не решение', src: 'const e = msg.expiresAt;',         fn: protocolHits, want: 0, id: null },
    { name: 'ttl: склейка строк — не арифметика', src: "log('ttl=' + ttl + ' chat=' + id);", fn: protocolHits, want: 0, id: null },
    { name: 'ttl: комментарий — не решение', src: '// раньше было base + ttl*1000\n',  fn: protocolHits, want: 0, id: null },
    // (4) ctx и App.vue: делегат не считается логикой, свой метод — считается.
    { name: 'ctx: ссылка поймана',          src: 'await ctx.sendMessage(x);',            fn: (s) => [{ id: 'ctx', n: countCtxRefs(s) }], want: 1, id: 'ctx' },
    // Комментарий — не связь. Без этой пары один инструмент считает 686, другой
    // 735, и «откуда новая ctx» выясняется заново при каждом вопросе.
    { name: 'ctx: в комментарии — не связь', src: '// ctx.channelPosts описание\n',       fn: (s) => [{ id: 'ctx', n: countCtxRefs(s) }], want: 0, id: null },
    { name: 'App.vue: делегат не логика',   src: 'methods: {\n    foo(a) {\n      return Mod.foo(a);\n    },\n}', fn: (s) => [{ id: 'own', n: appVueInventory(s).own }], want: 0, id: null },
    { name: 'App.vue: свой метод — логика', src: 'methods: {\n    foo(a) {\n      if (a) return 1;\n      return 2;\n    },\n}', fn: (s) => [{ id: 'own', n: appVueInventory(s).own }], want: 1, id: 'own' },
    // Параметр со значением по умолчанию-объектом (`opts = {}`) НЕ должен
    // превращать делегата в «логику»: скобки тела ищем с конца.
    { name: 'App.vue: делегат с opts = {} — не логика', src: 'methods: {\n    foo(p, opts = {}) { return Mod.foo(p, opts); },\n}', fn: (s) => [{ id: 'own', n: appVueInventory(s).own }], want: 0, id: null },
    { name: 'App.vue: многострочный делегат с opts = {} — не логика', src: 'methods: {\n    foo(p, opts = {}) {\n      return Mod.foo(p, opts);\n    },\n}', fn: (s) => [{ id: 'own', n: appVueInventory(s).own }], want: 0, id: null },
    // Делегат через цепочку свойств (вызов у владельца) — тоже не логика.
    { name: 'App.vue: делегат this.владелец.метод() — не логика', src: 'methods: {\n    foo() { return this.callSession.startCallClock(); },\n}', fn: (s) => [{ id: 'own', n: appVueInventory(s).own }], want: 0, id: null },
    // Присваивание в data — это логика (не делегат).
    { name: 'App.vue: присваивание — логика', src: 'methods: {\n    foo(v) { return this.x = v; },\n}', fn: (s) => [{ id: 'own', n: appVueInventory(s).own }], want: 1, id: 'own' },
    // Делегат, у которого в АРГУМЕНТАХ стрелка с телом: `;` внутри не делает
    // его «логикой» (регулярка `[^;]*` раньше такие отвергала).
    { name: 'App.vue: делегат со стрелкой в аргументах — не логика', src: 'methods: {\n    foo() { return Mod.foo({ cb: () => { x = 1; } }); },\n}', fn: (s) => [{ id: 'own', n: appVueInventory(s).own }], want: 0, id: null },
    { name: 'App.vue: два выражения — логика', src: 'methods: {\n    foo() { return Mod.foo({ cb: () => { x = 1; } }); return 2; },\n}', fn: (s) => [{ id: 'own', n: appVueInventory(s).own }], want: 1, id: 'own' },
  ];
  const fails = [];
  for (const c of cases) {
    const got = c.fn(c.src).filter((h) => h.n > 0);
    const n = got.reduce((a, h) => a + h.n, 0);
    const ok = n === c.want && (c.want === 0 || got.some((h) => h.id === c.id));
    if (!ok) fails.push(`${c.name}: ожидалось ${c.want}${c.id ? ' (' + c.id + ')' : ''}, получено ${n} [${got.map((h) => h.id + '×' + h.n).join(', ') || '—'}]`);
  }
  return { total: cases.length, fails };
}

// ── Сбор всего пакета метрик ───────────────────────────────────────────
// `root` параметризован, чтобы ратчет и аудит считали один и тот же набор,
// а тесты могли подсунуть временное дерево.
export function collectArchMetrics({ root = SRC } = {}) {
  const files = listJsFiles(root);
  const rel = (p) => path.relative(root, p);

  const perFile = files.map((f) => {
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n').length;
    return {
      file: rel(f),
      lines,
      src,
      crypto: cryptoHits(src),
      protocol: protocolHits(src),
      ctxRaw: countCtxRefsRaw(src),
    };
  });

  // ── ctx: ТО ЖЕ правило, что у ctx-ratchet-gate (см. шапку CTX_READ) ──
  // Отдельный проход по списку-потребителю, а не «все .js»: иначе величина
  // перестаёт совпадать с гейтом, который её же и держит.
  const ctxScan = [];
  const featureDir = path.join(root, 'features');
  if (existsSync(featureDir)) {
    for (const e of readdirSync(featureDir)) {
      if (e.endsWith('.js')) ctxScan.push('features/' + e);
    }
  }
  if (existsSync(path.join(root, 'api.js'))) ctxScan.push('api.js');
  ctxScan.sort();

  const ctxByFile = {};
  const ctxFieldsByFile = {};
  let ctxRefSites = 0;
  for (const spec of ctxScan) {
    const src = readFileSync(path.join(root, spec), 'utf8');
    const n = countCtxRefs(src);
    if (!n) continue;
    ctxRefSites += n;
    ctxByFile[spec] = n;
    ctxFieldsByFile[spec] = ctxFields(src);
  }

  // Агрегаты протокола: по файлам (сколько решений) и по видам (что именно выросло).
  const protocolByFile = {};
  const protocolByKind = {};
  for (const r of perFile) {
    if (!r.protocol.length) continue;
    protocolByFile[r.file] = Object.fromEntries(r.protocol.map((h) => [h.id, h.n]));
    for (const h of r.protocol) protocolByKind[h.id] = (protocolByKind[h.id] || 0) + h.n;
  }

  const appPath = path.join(root, 'App.vue');
  let appInventory = { found: false, methods: 0, delegates: 0, own: 0 };
  try { appInventory = appVueInventory(readFileSync(appPath, 'utf8')); } catch { /* нет App.vue */ }

  return {
    files: perFile.map(({ src, ...rest }) => rest), // без исходников наружу
    ctxByFile,
    ctxFieldsByFile,
    ctxScope: ctxScan.length,
    ctxRawAllFiles: perFile.reduce((a, r) => a + r.ctxRaw, 0),
    protocolByFile,
    protocolByKind,
    cryptoHard: perFile.flatMap((r) => r.crypto.filter((h) => h.n > 0).map((h) => ({ ...h, file: r.file }))),
    appVue: appInventory,
    totals: {
      files: perFile.length,
      lines: perFile.reduce((a, r) => a + r.lines, 0),
      ctxRefSites,
      protocolSites: Object.values(protocolByKind).reduce((a, n) => a + n, 0),
      protocolFiles: Object.keys(protocolByFile).length,
      appVueOwn: appInventory.own,
      appVueMethods: appInventory.methods,
      appVueDelegates: appInventory.delegates,
      cryptoHard: perFile.reduce((a, r) => a + r.crypto.filter((h) => h.n > 0).length, 0),
    },
  };
}
