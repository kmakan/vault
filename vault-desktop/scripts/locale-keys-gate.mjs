// Гейт ключей локализации: каждый литеральный t('key') / tr('key') из src/
// обязан существовать в ru.js, en.js и zh.js.
//
// ЗАЧЕМ. В i18n.js `t(key)` возвращает САМ КЛЮЧ, если перевода нет:
//
//   let s = locales[state.locale]?.[key] || locales.en[key] || key
//
// Из-за этого модный в проекте приём `t('key') || 'запасной текст'` НЕ работает
// так, как задумано: ключ — непустая строка, `||` не срабатывает, и человек
// видит техническую строку. 19.10.2026 это прилетело на живой приёмке вложений
// (t_e66389bd): как только починили мёртвый канал тостов, тост скачивания
// показал «download_complete». Проверка нашла 16 таких ключей сразу — их не
// видел ни один статический гейт: `check-template.cjs` смотрит bindings
// шаблона, а не ключи, смоуки подставляют свой t(), сборка ключи не читает.
//
// ЧТО ПРОВЕРЯЕТСЯ. Литеральные аргументы `t(...)`/`tr(...)` (одинарные и
// двойные кавычки) обязаны быть во всех трёх локалях. Осознанно НЕ проверяются:
//   · динамические ключи — `t('settings_' + cat.id)`, `t(`dod_${x}`)`
//     (после литерала стоит `+`, либо аргумент не строка);
//   · ключи, приходящие переменной (`t(name)`);
//   · полные строки комментариев (`// ...`, `* ...`) — в них ключи упоминаются
//     в пояснениях, и это не использование.
//
// Запуск: node scripts/locale-keys-gate.mjs   (npm run gate:locale-keys)
// Выход: 0 = OK; 1 = есть ключи без перевода (сборка падает).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const LOCALES = ['ru', 'en', 'zh'];

function listSourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(p, acc);
    else if (/\.(js|vue)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

function localeKeys(name) {
  const text = readFileSync(path.join(SRC, 'locales', `${name}.js`), 'utf8');
  const keys = new Set();
  for (const m of text.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)) keys.add(m[1]);
  return keys;
}

const available = new Map(LOCALES.map((l) => [l, localeKeys(l)]));

// Строки-комментарии целиком выбрасываем: там ключи упоминаются в пояснениях.
// Заменяем их ПУСТЫМИ строками, а не удаляем: иначе съезжает нумерация строк
// в сообщениях гейта (проверено: ключ из attachments.js:47 показывался как :25).
function stripFullLineComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : line;
    })
    .join('\n');
}

const problems = [];
for (const file of listSourceFiles(SRC)) {
  if (path.dirname(file) === path.join(SRC, 'locales')) continue;
  const text = stripFullLineComments(readFileSync(file, 'utf8'));
  const rel = path.relative(ROOT, file);
  // Литерал + СЛЕДУЮЩИЙ символ (через пробелы): `+` означает склейку с
  // переменной (динамический ключ) — такие не проверяем.
  for (const m of text.matchAll(/\b(?:t|tr)\(\s*(['"])([A-Za-z0-9_]+)\1\s*(\+)?/gs)) {
    const [, , key, plus] = m;
    if (plus === '+') continue;
    const missing = LOCALES.filter((l) => !available.get(l).has(key));
    if (missing.length) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push({ rel, line, key, missing });
    }
  }
}

if (problems.length) {
  problems.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  console.error(`✗ locale-keys: ключей без перевода — ${problems.length}`);
  console.error('  t() возвращает сам ключ, поэтому `t(\'key\') || \'текст\'` покажет ключ человеку.');
  console.error('  Добавьте ключ во все три локали (ru/en/zh) или используйте существующий:');
  for (const p of problems) {
    console.error(`  · ${p.key} — нет в ${p.missing.join(', ')} (${p.rel}:${p.line})`);
  }
  process.exit(1);
}

console.log(`✓ locale-keys: все литеральные ключи переведены (${LOCALES.join('/')})`);
