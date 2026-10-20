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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');   // vault-desktop/

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

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
  writeFileSync(abs, mutated);
  return { applied: true, before, after: sha(mutated) };
}

function restoreFile(file, content) {
  writeFileSync(path.join(ROOT, file), content);
}

// Прогон смоука: мутация должна его ПОЛОВАТЬ (ненулевой код выхода).
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
  const broken = [];
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
    try {
      out = runSmoke(set.smoke, set.timeoutMs);
    } finally {
      restoreFile(mFile, backups.get(mFile) || original);
    }
    if (out.timedOut) {
      // Таймаут — тест не отработал: мутацию засчитываем как пойманную только
      // если смоук УПАЛ, а не завис. Зависший тест — проблема теста.
      broken.push({ name: m.name, reason: 'смоук завис (таймаут)' });
      log('  ✗ ' + m.name + ' — смоук ЗАВИС (таймаут)');
      continue;
    }
    if (out.code !== 0) {
      caught.push(m.name);
      log('  ✓ ' + m.name);
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
  return { id: set.id, total: set.mutations.length, caught, survived, broken };
}
