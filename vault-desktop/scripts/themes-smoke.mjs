// Node-смоук src/themes.js — оформление.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Тема — это набор CSS-переменных, которые пишутся в
// :root и запоминаются. Правила: неизвестная тема не применяется (и не стирает
// текущую); применение темы пишет ВСЕ её переменные; выбранная тема
// сохраняется и перечитывается при старте; по умолчанию — тёмная.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/themes-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// Стен DOM: пишем только setProperty.
const applied = new Map();
globalThis.document = {
  documentElement: {
    style: {
      setProperty: (k, v) => applied.set(k, v),
    },
  },
};

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const src = readFileSync(path.join(ROOT, 'src', 'themes.js'), 'utf8');
writeFileSync(MOCKS + '/themes.mjs', src, 'utf8');
const T = await import(MOCKS + '/themes.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() { applied.clear(); mem.clear(); }

// ── Каталог тем ──────────────────────────────────────────────────────────
{
  ok('каталог тем не пуст', Object.keys(T.themes).length >= 2, Object.keys(T.themes));
  ok('у каждой темы есть набор переменных', Object.values(T.themes).every((t) => t && t.vars && Object.keys(t.vars).length > 0));
  ok('у каждой темы есть имя', Object.values(T.themes).every((t) => typeof t.name === 'string' && t.name.length > 0));
  const ids = Object.keys(T.themes);
  ok('тема по умолчанию существует в каталоге', T.themes[T.loadSavedTheme()] !== undefined, T.loadSavedTheme());
  ok('дефолт — тёмная тема', T.loadSavedTheme() === 'dark', T.loadSavedTheme());
}

// ── Применение темы ──────────────────────────────────────────────────────
{
  reset();
  // Берём заведомо НЕ тёмную тему: иначе проверка «сохранённая тема
  // перечитывается» прошла бы и при мутации «всегда тёмная».
  const themeId = Object.keys(T.themes).find((k) => k !== 'dark') || Object.keys(T.themes)[0];
  T.applyTheme(themeId);
  ok('тема применена (переменные записаны)', applied.size === Object.keys(T.themes[themeId].vars).length, applied.size);
  ok('значения переменных — из каталога темы',
    Object.entries(T.themes[themeId].vars).every(([k, v]) => applied.get(k) === v));
  ok('выбор темы сохранён', localStorage.getItem('vault-theme') === themeId, localStorage.getItem('vault-theme'));
  ok('сохранённая тема перечитывается', T.loadSavedTheme() === themeId);
}
{
  reset();
  let unknownThrew = null;
  try { T.applyTheme('такой-темы-нет'); } catch (e) { unknownThrew = e; }
  ok('неизвестная тема не применяется (переменные не пишутся)',
    unknownThrew === null && applied.size === 0, unknownThrew ? String(unknownThrew.message) : applied.size);
  ok('неизвестная тема не сохраняется',
    unknownThrew === null && localStorage.getItem('vault-theme') === null);
}
{
  reset();
  const themeId = Object.keys(T.themes).find((k) => k !== 'dark') || Object.keys(T.themes)[0];
  T.applyTheme(themeId);
  const first = applied.size;
  let unknownThrew = null;
  try { T.applyTheme('такой-темы-нет'); } catch (e) { unknownThrew = e; }
  ok('неизвестная тема не стирает применённую',
    unknownThrew === null && applied.size === first, unknownThrew ? String(unknownThrew.message) : applied.size);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
