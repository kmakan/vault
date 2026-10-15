// ХРАПОВИК СВЯЗНОСТИ. В отличие от ctx-coupling-gate, не может быть ослаблен.
//
// ЗАЧЕМ И ЧЕМ ОТЛИЧАЕТСЯ ОТ ctx-coupling-gate.
//
// ctx-coupling-gate меряет ВЕЛИЧИНУ и останавливает сборку только при росте
// сверх baseline. Рост можно «осознанно принять» через --write — и это делали
// четырежды за одну сессию, каждый раз с честным обоснованием. Обоснования были
// нормальными, а сам механизм позволяет расти бесконечно, фиксируя каждое
// увеличение как новую норму. Это baseline, а не ограничение.
//
// Здесь наоборот: потолок можно ТОЛЬКО ЗАТЯГИВАТЬ. Опции --write нет вовсе;
// скрипт умеет лишь записать потолок ТЕКУЩЕЙ (заниженной) величины и никогда —
// повышенной. Поэтому однажды поставленная граница держится сама.
//
// ЧТО ИЗМЕРЯЕТ. Два разных вида связи, и они опасны по-разному:
//
//   1. СКОЛЬКО ПОЛЕЙ модуль берёт из компонента. Это видимая зависимость: её
//      можно убрать, передав нужные поля явно.
//
//   2. СКОЛЬКО МОДУЛЕЙ ПИШУТ В ОДНО И ТО ЖЕ ПОЛЕ. Это НЕВИДИМАЯ связь, и она
//      хуже: `ctx` — лишь транспорт, а настоящая беда в том, что модули
//      изменяют состояние друг друга, не зная об этом.
//
// Сейчас во втором смысле: peerKeys пишут 14 модулей, peerPqKeys — 13,
// groupKeys — 8. Правка calls.js может испортить peerKeys и сломать send, poll,
// receipts и attachments, а ни один из них об этом не узнает. Пока это
// разрешено, никакое переименование ctx в зависимости не поможет: разделение
// на модули останется косметикой.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE_FILE = path.join(ROOT, 'scripts', 'ctx-ratchet-baseline.json');

// Только модули фич и api.js: именно они работают через ctx.
// Пути ВЕРХНЕГО УРОВНЯ (от src), иначе features/x.js склеивается с
// src/features и даёт src/features/features/x.js — тихо, через existsSync.
const SCAN = [];
const { readdirSync } = await import('node:fs');
for (const f of readdirSync(path.join(ROOT, 'src', 'features'))) {
  if (f.endsWith('.js')) SCAN.push('features/' + f);
}
SCAN.push('api.js');

// ПОЛЯ-ВЛАДЕЛЬЦЫ. Эти поля исключены из подсчёта общих полей, потому что
// они и есть цель миграции (ADR-004). Запись через владельца — это не нарушение,
// а планомерный перенос. Без этого исключения храповик блокировал бы каждый
// переведённый модуль: модуль начинает брать новое поле `chat`, и храповик
// видит рост связности.
const OWNER_FIELDS = new Set([
  // A1: чат-история (chat-store.js)
  'chat',
  // A9: groupKeys/groupAvatars (groups-store.js)
  'setGroupKey',
  'setGroupAvatar',
  'mergeGroupKeys',
  'mergeGroupAvatars',
  // A10: sending/pendingOutgoing (sending-store.js).
  // Состояние — sending (boolean), pendingOutgoing (bucket map).
  // API — set/get/merge/remove/clear/drop. Запись через владельца — планомерный
  // перенос, а не нарушение связности: modules перестают писать чужие поля.
  'sending',
  'pendingOutgoing',
  'setSending',
  'getSending',
  'setPendingOutgoing',
  'getPendingOutgoingBucket',
  'mergePendingOutgoing',
  'removePendingOutgoing',
  'clearPendingOutgoing',
  'dropBucket',
  // A11: unreadCounts (chat-store.js). State + API для непрочитанных.
  'unreadCounts',
  'incUnread',
  'clearUnread',
  'clearAllUnread',
  'unreadOf',
  'setUnread',
  // A12: session-store.js (isLoggedIn + emails). State + API.
  'sessionStore',
  'session',   // A12: call-session.js — state-owner. Поле, а не модуль.
  'isLoggedIn',
  'emails',
  'login',
  'logout',
  'setEmails',
  'clearEmails',
  'emailCount',
  // A13: relay-store.js owner для ecoMode/relayEnabled/relayDeliveryMode.
  'ecoMode',
  'relayEnabled',
  'relayDeliveryMode',
  'enableEco',
  'isEcoMode',
  'enableRelay',
  'isRelayEnabled',
  'setRelayMode',
  'deliveryMode',
  // A14: newMessage draft owner API (chat-store.js)
  'newMessage',
  'setDraft',
  'getDraft',
  'clearDraft',
]);

const CTX_READ = /ctx\.([A-Za-z_$][\w$]*)/g;
// Присваивание или мутация после имени поля.
// ЗАПИСЬ — присваивание или мутация. Чтение по индексу `ctx.peerKeys[email]`
// записью НЕ является, а первая версия считала его записью: голый `[` стоял в
// списке альтернатив. Из-за этого writer-список распухал до 14 модулей у
// peerKeys, и на этой неверной цифре стоял бы весь план развязки.
//
// `[` допустим ТОЛЬКО вместе с присваиванием после закрывающей скобки.
const CTX_WRITE = /ctx\.([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\+\+|--|\+=|-=|\.push\(|\.set\(|\.splice\(|\.delete\(|\[[^\]]*\]\s*(?:=[^=]|\+\+|--|\+=|-=))/g;

function moduleOf(spec) {
  return spec;
}

const moduleFields = {};   // модуль → множество полей
const fieldWriters = {};   // поле → множество модулей
const fieldReaders = {};   // поле → множество модулей

for (const spec of SCAN) {
  const full = path.resolve(ROOT, 'src', spec);
  if (!existsSync(full)) continue;
  const src = readFileSync(full, 'utf8');
  const mod = moduleOf(spec);
  const seen = new Set();
  for (const m of src.matchAll(CTX_READ)) {
    if (OWNER_FIELDS.has(m[1])) continue;
    seen.add(m[1]);
    (fieldReaders[m[1]] ||= new Set()).add(mod);
  }
  for (const m of src.matchAll(CTX_WRITE)) {
    if (OWNER_FIELDS.has(m[1])) continue;
    (fieldWriters[m[1]] ||= new Set()).add(mod.replace(/^features\//, ''));
  }

  // ── ЗАПИСЬ ЧЕРЕЗ ССЫЛКУ. Главная дыра прямого детектора ──────────────
  //
  // Наиболее тихий способ писать в чужое состояние — получить элемент ссылкой и
  // изменить его:
  //     const msg = ctx.messages.find(m => m.id === msgId);
  //     if (!msg.reactions) msg.reactions = [];     ← запись
  //     msg.reactions.push(emoji);                   ← запись
  //
  // Ни одна из этих строк не содержит присваивания сразу после `ctx.messages`,
  // поэтому прямой шаблон их не видит, а писатель в списке не появляется. Проверено
  // на reactions.js::addReaction — это ТИХАЯ запись в чужое состояние, то есть
  // ровно тот класс, ради которого гейт и написан.
  //
  // Детектор приближённый: ищет `const V = ctx.F...` и ищет мутацию V дальше по
  // функции. Ложные срабатывания возможны и допустимы — гейт с ложными
  // срабатываниями можно обойти (явная пометка), а дыра в защите не обходится.
  const ALIAS = /(?:const|let)\s+(\w+)\s*=\s*ctx\.([A-Za-z_$][\w$]*)/g;
  for (const m of src.matchAll(ALIAS)) {
    const varName = m[1];
    const field = m[2];
    if (OWNER_FIELDS.has(field)) continue;
    // Ищем мутацию этой переменной в остатке файла. Граница — следующая
    // декларация с тем же именем или 400 символов (функция обычно короче).
    const rest = src.slice(m.index, m.index + 1200);
    const mutated = new RegExp(
      '\\b' + varName + '\\s*(?:\\.[A-Za-z_$][\\w$]*\\s*=(?!=)|\\.(?:push|splice|sort|reverse|pop|shift|unshift|add|set)\\()');
    if (mutated.test(rest)) {
      (fieldWriters[field] ||= new Set()).add(mod.replace(/^features\//, ''));
    }
  }
  moduleFields[mod.replace(/^features\//, '')] = [...seen].sort();
}

const ser = (o) => Object.fromEntries(
  Object.entries(o).map(([k, v]) => [k, [...v].sort()]));

const current = {
  moduleFields: ser(moduleFields),
  fieldWriters: ser(fieldWriters),
  totals: {
    ctxFields: Object.values(moduleFields).reduce((s, a) => s + a.length, 0),
    ctxRefSites: SCAN.reduce((s, sp) => {
      const f = path.resolve(ROOT, 'src', sp);
      if (!existsSync(f)) return s;
      return s + (readFileSync(f, 'utf8').match(CTX_READ) || []).length;
    }, 0),
    // У Set есть .size, а НЕ .length: v.length === undefined, условие
    // undefined > 1 всегда ложно, и метрика молча читалась нулём.
    sharedWriteFields: Object.values(fieldWriters).filter((v) => v.size > 1).length,
  },
};

// ПОТОЛОК ЧИТАЕТСЯ ИЗ GIT, А НЕ ИЗ РАБОЧЕЙ КОПИИ.
//
// Первая версия читала baseline из файла, и храповик держался ровно настолько,
// насколько прочен редактируемый вручную JSON: достаточно было вписать
// ctxRefSites: 99999, и --write принимал это молча, потому что текущая величина
// выглядела МЕНЬШЕЙ ослабленной. Проверено: тест на ослабление проходил.
//
// Теперь эталон — то, что ЗАКОММИЧЕНО. Ослабить потолок можно только коммитом,
// а коммит виден на ревью и сравним. Молчаливого пути больше нет.
function committedBaseline() {
  if (!existsSync(BASE_FILE)) return null;
  try {
    const { execFileSync } = require_child_process();
    // Путь в git относителен КОРНЮ РЕПОЗИТОРИЯ, а не рабочему каталогу.
    // Первая версия звала `git show HEAD:scripts/...` из vault-desktop — такой
    // путь не существует, команда падала, срабатывал запасной вариант, и prev
    // становился РАБОЧИМ файлом. То есть эталон сравнивался сам с собой, и
    // ослабление проходило молча. Проверка git show сделана явной.
    const rel = execFileSync('git', ['rev-parse', '--show-prefix'],
      { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const out = execFileSync('git', ['show', 'HEAD:' + rel + 'scripts/ctx-ratchet-baseline.json'],
      { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch (e) {
    // Файл есть, но не закоммичен (первый запуск): тогда эталон — сам файл.
    return JSON.parse(readFileSync(BASE_FILE, 'utf8'));
  }
}
function require_child_process() {
  return globalThis.__child_process;
}
const { createRequire } = await import('node:module');
globalThis.__child_process = createRequire(import.meta.url)('node:child_process');

if (process.argv.includes('--write')) {
  const { writeFileSync } = await import('node:fs');
  const prev = committedBaseline();
  if (prev) {
    // СТАРЫЙ ПОТОЛОК ВЫШЕ НОВОГО — СТОП. Храповик не распускается.
    const back = [];
    if (current.totals.ctxRefSites > prev.totals.ctxRefSites) back.push('ctxRefSites ' + prev.totals.ctxRefSites + ' → ' + current.totals.ctxRefSites);
    if (current.totals.ctxFields > prev.totals.ctxFields) back.push('ctxFields ' + prev.totals.ctxFields + ' → ' + current.totals.ctxFields);
    if (current.totals.sharedWriteFields > prev.totals.sharedWriteFields) back.push('sharedWriteFields ' + prev.totals.sharedWriteFields + ' → ' + current.totals.sharedWriteFields);
    if (back.length) {
      console.log('✗ храповик НЕ распускается. Показатели выросли:');
      for (const b of back) console.log('   ' + b);
      console.log('\n  Ослабить потолок нельзя. Сначала сделайте связность меньше,');
      console.log('  потом запишите. Если рост осознанный — это предмет ADR,');
      console.log('  а не молчаливая смена нормы.');
      process.exit(1);
    }
  }
  writeFileSync(BASE_FILE, JSON.stringify(current, null, 2) + '\n');
  console.log('✓ храповик записан (только ужесточение): '
    + current.totals.ctxRefSites + ' ссылок, '
    + current.totals.ctxFields + ' полей, '
    + current.totals.sharedWriteFields + ' полей пишут несколько модулей');
  process.exit(0);
}

if (!existsSync(BASE_FILE)) {
  console.log('✗ ctx-ratchet: потолка нет. Создай его текущей величиной: node scripts/ctx-ratchet-gate.mjs --write');
  process.exit(1);
}

const prev = committedBaseline();
const problems = [];

// РАБОЧАЯ КОПИЯ ПОТОЛКА НЕ ДОЛЖНА БЫТЬ СЛАБЕЕ ЗАКОММИЧЕННОЙ.
//
// Эталон берётся из git, и этого само по себе мало: ослабленный файл остался бы
// на диске и мог бы попасть в следующий коммит, а закоммиченный потолок при этом
// ещё держал бы гейт зелёным. То есть момент, когда гейт ослепнут, наступил бы
// позже — на ревью, где его уже нет.
if (existsSync(BASE_FILE)) {
  const work = JSON.parse(readFileSync(BASE_FILE, 'utf8'));
  const weaker = [];
  if (work.totals.ctxRefSites > prev.totals.ctxRefSites) {
    weaker.push('ctxRefSites в файле ' + prev.totals.ctxRefSites + ' → ' + work.totals.ctxRefSites);
  }
  if (work.totals.ctxFields > prev.totals.ctxFields) {
    weaker.push('ctxFields ' + prev.totals.ctxFields + ' → ' + work.totals.ctxFields);
  }
  if (work.totals.sharedWriteFields < prev.totals.sharedWriteFields) {
    weaker.push('sharedWriteFields ' + prev.totals.sharedWriteFields + ' → ' + work.totals.sharedWriteFields);
  }
  for (const f of Object.keys(prev.fieldWriters)) {
    const a = (prev.fieldWriters[f] || []).length;
    const b = ((work.fieldWriters || {})[f] || []).length;
    if (b < a) weaker.push('писателей у `' + f + '` в файле ' + a + ' → ' + b);
  }
  if (weaker.length) {
    console.log('✗ ctx-ratchet: потолок ОСЛАБЛЕН в scripts/ctx-ratchet-baseline.json');
    for (const w of weaker) console.log('   • ' + w);
    console.log('\n  Эталон — закоммиченная версия. Ослабить можно только коммитом,');
    console.log('  и он будет виден на ревью. Здесь — попытка ослабить молча.');
    process.exit(1);
  }
}

// 1. Модуль не должен взять новое поле.
for (const [mod, fields] of Object.entries(current.moduleFields)) {
  const before = new Set(prev.moduleFields[mod] || []);
  const added = fields.filter((f) => !before.has(f));
  if (before.size === 0 && fields.length > 0 && !(mod in prev.moduleFields)) {
    problems.push('НОВЫЙ модуль ' + mod + ' берёт из компонента ' + fields.length
      + ' полей: ' + fields.join(', ') + ' — это начинается с нуля и его нечем уменьшать');
  } else if (added.length) {
    problems.push(mod + ' берёт НОВЫЕ поля: ' + added.join(', ')
      + ' (было ' + before.size + ', стало ' + fields.length + ')');
  }
}

// 2. Поле не должно получить нового пишущего модуля.
for (const [field, writers] of Object.entries(current.fieldWriters)) {
  const before = new Set(prev.fieldWriters[field] || []);
  const added = writers.filter((w) => !before.has(w));
  if (added.length) {
    problems.push('поле `' + field + '` теперь пишет ещё и: ' + added.join(', ')
      + ' — невидимая запись в состояние чужой фичи (было ' + before.size + ')');
  }
}

// 3. Итоги не должны расти.
if (current.totals.ctxRefSites > prev.totals.ctxRefSites) {
  problems.push('всего ctx-ссылок ' + prev.totals.ctxRefSites + ' → ' + current.totals.ctxRefSites);
}

if (problems.length) {
  console.log('✗ ctx-ratchet: ' + problems.length + ' нарушени(й). Связность выросла — храповик не распускается.');
  for (const p of problems) console.log('   • ' + p);
  console.log('\n  Что делать: НЕ увеличивать связность. Либо передать нужное явно,');
  console.log('  либо вынести состояние в модуль, который им владеет, либо не брать.');
  process.exit(1);
}

console.log('✓ ctx-ratchet: держится — '
  + current.totals.ctxRefSites + ' ссылок (' + prev.totals.ctxRefSites + ' потолок), '
  + current.totals.ctxFields + ' полей, '
  + current.totals.sharedWriteFields + ' полей пишут несколько модулей');