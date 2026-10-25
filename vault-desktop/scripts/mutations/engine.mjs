// Движок мутационного тестирования.
//
// ЗАЧЕМ ЭТО В РЕПОЗИТОРИИ (а не «скрипт в /tmp на вечер»).
// Мутационное тестирование отвечает на вопрос, который обычные тесты не
// проверяют: «а тест вообще что-то проверяет?». Подставляем поломку в
// модуль и смотрим, ПРОПУЩЕНО ли тест. Если тест зелёный на сломанном
// коде — тест ничего не проверяет.
//
// 20.10.2026 показало, почему это должно быть гейтом, а не ритуалом:
// за день слабые сценарии вскрылись МУТАЦИЯМИ в девяти разных фичах
// (проверка без своих данных, проверка-декорация, незначимое начальное
// значение, стенд, повторяющий НЕ поведение владельца, мутация не в той
// функции, эквивалентная мутация, ...). Каждая из них молча оставляла
// фичу без настоящей проверки.
//
// ПРАВИЛА ДВИЖКА:
//   * мутация применяется ТОЧНЫМ совпадением строки; если строки нет —
//     это ОШИБКА набора (тест устарел), а не «пропущено»;
//   * после прогона файл ВОССТАНАВЛИВАЕТСЯ (всегда, даже при ошибке);
//   * «выжившая» мутация (тест зелёный на сломанном коде) — провал гейта.
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');   // vault-desktop/

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ЖУРНАЛ на диске — страховка от «всегда» в правиле «файл восстанавливается».
// finally отрабатывает при ИСКЛЮЧЕНИИ, но не при SIGTERM/SIGKILL: убитый
// прогон гейта оставлял в рабочем дереве СТРОКУ МУТАЦИИ (`if (false) return
// false;` в recovery-escrow.js — снятый лимит попыток → смоук убивался OOM
// через 40 секунд, и выглядит как поломка кода, а не как мусор после гейта).
// Копия пишется ДО мутации и снимается ПОСЛЕ восстановления; leftover
// подхватывает recoverJournal() на следующем старте.
//
// У ЗАПИСИ ЖУРНАЛА ЕСТЬ ВЛАДЕЛЕЦ (25.10): JS-гейт и Rust-гейт живут в одном
// каталоге, и `recoverJournal()` запускается перед каждым прогоном. Без префикса
// владельца JS-прогон поднимал «leftover от убитого прогона» — активный мутант
// Rust-гейта — и откатывал файл прямо во время чужого прогона: тот мутант
// проверялся на целом коде и записывался как ВЫЖИВШИЙ. Теперь запись помечена
// префиксом, чужые прогону не трогаются, а одновременный запуск — ошибка.
const JOURNAL_DIR = '/tmp/vault-mutation-journal';
const OWNER_PREFIX = { js: 'js-', rust: 'rs-' };
let owner = 'js';

export function setJournalOwner(o) {
  if (!OWNER_PREFIX[o]) throw new Error('неизвестный владелец журнала: ' + o);
  owner = o;
}
const ownPrefix = () => OWNER_PREFIX[owner];
const hexOf = (file) => Buffer.from(file, 'utf8').toString('hex');
const journalPath = (file) => path.join(JOURNAL_DIR, ownPrefix() + hexOf(file) + '.bak');

// Кому принадлежит запись: 'js', 'rust' или 'legacy' (журнал до появления
// владельцев — его восстанавливает кто первый пришёл, это безопасно).
function entryOwner(name) {
  for (const [o, p] of Object.entries(OWNER_PREFIX)) if (name.startsWith(p)) return o;
  return 'legacy';
}
const HEX_ONLY = /^[0-9a-f]+$/;
function entryFile(name) {
  const hex = name.replace(/^(?:js-|rs-)/, '').replace(/\.bak$/, '');
  if (!HEX_ONLY.test(hex)) return null;
  return Buffer.from(hex, 'hex').toString('utf8');
}

// Чужие записи журнала = идёт прогон другого гейта. Пустой список — можно стартовать.
export function foreignJournal() {
  if (!existsSync(JOURNAL_DIR)) return [];
  const out = [];
  for (const name of readdirSync(JOURNAL_DIR)) {
    if (!name.endsWith('.bak')) continue;
    const o = entryOwner(name);
    if (o === 'legacy' || o === owner) continue;
    const file = entryFile(name);
    if (file) out.push({ file, owner: o, name });
  }
  return out;
}

/// `--takeover`: поднять чужой leftover (прогон другого гейта был убит, и его
/// мутант остался в рабочем дереве). По умолчанию этого НЕ делать — см. выше.
export function recoverForeignJournal() {
  const restored = [];
  for (const e of foreignJournal()) {
    const abs = path.isAbsolute(e.file) ? e.file : path.join(ROOT, e.file);
    const backup = readFileSync(path.join(JOURNAL_DIR, e.name), 'utf8');
    if (existsSync(abs) && readFileSync(abs, 'utf8') !== backup) {
      writeFileSync(abs, backup);
    }
    try { unlinkSync(path.join(JOURNAL_DIR, e.name)); } catch (e2) { /* уже снят */ }
    restored.push(`${e.file} (владелец ${e.owner})`);
  }
  return restored;
}

export function writeJournal(file, content) {
  mkdirSync(JOURNAL_DIR, { recursive: true });
  writeFileSync(journalPath(file), content);
}

export function clearJournal(file) {
  try { unlinkSync(journalPath(file)); } catch (e) { /* журнала нет — и ладно */ }
}

// Восстановить всё, что оставил убитый прогон СВОЕГО гейта. Возвращает список
// файлов; чужие записи не трогаются (они и есть признак живого прогона).
// Ключ журнала — ПУТЬ КАК ЕСТЬ: rust-гейт мутирует крейты ВНЕ vault-desktop
// (vault-client/…), и для абсолютного пути join(ROOT, file) дал бы мусор.
export function recoverJournal() {
  if (!existsSync(JOURNAL_DIR)) return [];
  const restored = [];
  for (const name of readdirSync(JOURNAL_DIR)) {
    if (!name.endsWith('.bak')) continue;
    const o = entryOwner(name);
    if (o !== 'legacy' && o !== owner) continue;
    const file = entryFile(name);
    if (!file) continue;
    const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
    const backup = readFileSync(path.join(JOURNAL_DIR, name), 'utf8');
    if (existsSync(abs) && readFileSync(abs, 'utf8') !== backup) {
      writeFileSync(abs, backup);
      restored.push(file);
    }
    try { unlinkSync(path.join(JOURNAL_DIR, name)); } catch (e) { /* уже снят */ }
  }
  return restored;
}

function applyMutation(file, pattern, replacement) {
  const abs = path.join(ROOT, file);
  const src = readFileSync(abs, 'utf8');
  if (!src.includes(pattern)) {
    return { applied: false, reason: 'паттерн не найден' };
  }
  const before = sha(src);
  const mutated = src.replace(pattern, replacement);
  if (mutated === src) {
    return { applied: false, reason: 'мутация ничего не меняет' };
  }
  writeJournal(file, src);
  writeFileSync(abs, mutated);
  return { applied: true, before, after: sha(mutated), mutated };
}

// Побайтное восстановление — только ЕСЛИ файл за время прогона не менял никто
// кроме нас. Прогон мутаций пишет в рабочие файлы и откатывает их снимком,
// взятым ДО мутации; параллельная сессия, правящая тот же файл в этот момент,
// теряет свою правку (проверено на живом дереве 24.10 — откат съел чужие
// изменения в vault-core/src/identity.rs). Чужую запись не затираем: сигнал,
// набор остановлен, код выхода — провал.
function restoreFile(file, content, expectMutated) {
  const abs = path.join(ROOT, file);
  const now = readFileSync(abs, 'utf8');
  if (now !== content && now !== expectMutated) {
    clearJournal(file);
    return { ok: false, reason: 'файл изменён извне во время прогона — восстановление отменено' };
  }
  writeFileSync(abs, content);
  clearJournal(file);
  return { ok: true };
}

// Маркеры ПРОВАЛА УТВЕРЖДЕНИЯ (смоук упал на проверке, а не на ошибке).
// Смоук, который УПАЛ С ИСКЛЮЧЕНИЕМ, «ловит» любую мутацию (код выхода ≠ 0)
// — и это ложное срабатывание: тест ничего не проверяет, он просто сломан.
// Поэтому гейт различает: провал утверждения — мутация поймана честно;
// исключение — смоук сломан, и это ОТДЕЛЬНАЯ категория провала.
const FAILURE_MARKERS = /(^|\s)(✗|FAIL:|FAILED|провалов)/m;

function runSmoke(smoke, timeoutMs = 180000) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', smoke)], {
    cwd: ROOT,
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: res.status === null ? -1 : res.status,
    timedOut: res.error && res.error.code === 'ETIMEDOUT',
    output: (res.stdout || '') + (res.stderr || ''),
  };
}

// Прогон одного набора мутаций.
// Возвращает: { id, total, caught, survived: [...], broken: [...] }
export function runSet(set, opts = {}) {
  const log = opts.log || (() => {});
  const file = set.file;
  const abs = path.join(ROOT, file);
  if (!existsSync(abs)) {
    return { id: set.id, total: set.mutations.length, caught: 0, survived: [], broken: [{ name: '(файл модуля)', reason: 'нет файла ' + file }] };
  }
  const original = readFileSync(abs, 'utf8');
  // Бэкапы всех файлов, которые бьёт набор (у каждой мутации может быть свой).
  const backups = new Map();
  for (const m of set.mutations) {
    const mf = m.file || file;
    if (!backups.has(mf)) backups.set(mf, readFileSync(path.join(ROOT, mf), 'utf8'));
  }
  const caught = [];
  const survived = [];
  const crashed = [];
  const broken = [];

  // БАЗОВЫЙ ПРОГОН на чистом дереве: смоук обязан проходить ДО мутаций.
  // Иначе «пойманная» мутация ничего не значит: сломанный тест ловит всё
  // (код выхода ≠ 0), и набор рисует зелёную галочку там, где проверок нет.
  {
    const base = runSmoke(set.smoke, set.timeoutMs);
    if (base.code !== 0) {
      return {
        id: set.id, total: set.mutations.length, caught, survived, crashed,
        broken: [{ name: '(базовый прогон)', reason: 'смоук не проходит на чистом дереве — набор бессмысленен' }],
      };
    }
  }

  for (const m of set.mutations) {
    // Мутация может бить по СВОЕМУ файлу (набор — про набор, а не про файл).
    const mFile = m.file || file;
    const res = applyMutation(mFile, m.pattern, m.replacement);
    if (!res.applied) {
      broken.push({ name: m.name, reason: res.reason });
      log('  ✗ ' + m.name + ' — мутация НЕ ПРИМЕНИЛАСЬ: ' + res.reason);
      continue;
    }
    let out;
    let foreign = null;
    try {
      out = runSmoke(set.smoke, set.timeoutMs);
    } finally {
      const r = restoreFile(mFile, backups.get(mFile) || original, res.mutated);
      if (!r.ok) foreign = r.reason;
    }
    if (foreign) {
      broken.push({ name: m.name, reason: foreign + ': ' + mFile });
      log('  ✗ ' + m.name + ' — ' + foreign + ' (' + mFile + '); набор остановлен, чужую правку не трогаем');
      return { id: set.id, total: set.mutations.length, caught, survived, crashed, broken };
    }
    if (out.timedOut) {
      // Таймаут — тест не отработал: мутацию засчитываем как пойманную только
      // если смоук УПАЛ, а не завис. Зависший тест — проблема теста.
      broken.push({ name: m.name, reason: 'смоук завис (таймаут)' });
      log('  ✗ ' + m.name + ' — смоук ЗАВИС (таймаут)');
      continue;
    }
    if (out.code !== 0) {
      if (FAILURE_MARKERS.test(out.output)) {
        caught.push(m.name);
        log('  ✓ ' + m.name);
      } else {
        // Смоук упал с ИСКЛЮЧЕНИЕМ: мутация «поймана» случайно (любой
        // непустой код выхода считался провалом). Такой смоук ничего не
        // проверяет — это поломка теста, а не успех мутации.
        crashed.push(m.name);
        caught.push(m.name);
        log('  ✓ ' + m.name + ' (смоук упал с исключением — поведение сломано, но без утверждения)');
      }
    } else {
      survived.push(m.name);
      log('  ✗ ' + m.name + ' — ВЫЖИЛА (тест зелёный на сломанном коде!)');
    }
  }
  // Контроль: ВСЕ затронутые файлы восстановлены побайтно.
  const after = readFileSync(abs, 'utf8');
  if (sha(after) !== sha(original)) {
    broken.push({ name: '(восстановление)', reason: 'файл не восстановлен побайтно' });
  }
  return { id: set.id, total: set.mutations.length, caught, survived, crashed, broken };
}
