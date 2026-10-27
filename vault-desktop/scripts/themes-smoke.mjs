// Node-смоук src/themes.js — оформление.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Тема — это набор CSS-переменных, которые пишутся в
// :root и запоминаются. Правила: неизвестная тема не применяется (и не стирает
// текущую); применение темы пишет ВСЕ её переменные; выбранная тема
// сохраняется и перечитывается при старте; по умолчанию — тёмная.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
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

// ── Экран настроек следует выбранной теме ────────────────────────────────
// Регресс «попап настроек не в выбранной теме»: фон/текст были захардкожены
// палитрой GitHub-dark и светлая тема получала тёмный экран. Проверяем, что
// страница и сайдбар берут цвета из CSS-переменных темы.
{
  const vue = readFileSync(path.join(ROOT, 'src', 'components', 'SettingsPage.vue'), 'utf8');
  const block = (sel) => {
    const m = vue.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
  };
  const page = block('.settings-page');
  const sidebar = block('.settings-sidebar');
  ok('настройки: фон страницы — из темы', /background:\s*var\(--bg-primary/.test(page), page.trim());
  ok('настройки: текст страницы — из темы', /color:\s*var\(--text-primary/.test(page), page.trim());
  ok('настройки: сайдбар — из темы', /background:\s*var\(--bg-secondary/.test(sidebar), sidebar.trim());
  ok('настройки: нет хардкод-фона GitHub-dark',
    !/background:\s*#(0d1117|161b22)\b/i.test(vue));
}

// ── Ни один токен не остаётся «в воздухе» ────────────────────────────────
// Регресс этого класса уже был: `--radius-*`, `--shadow-sm` и `--font-sans`
// использовались без запасного значения и без объявления, и у элементов
// пропадали скругления, тень и шрифт. Тот же механизм ломает и цвета: если
// токен вызван через `var(--x)` без запасного значения и не объявлен ни в
// одной глобальной базе (`:root` в style.css и в глобальном `<style>` файла
// App.vue), ни во ВСЕХ темах, браузер считает значение невалидным — элемент
// наследует чужое или падает к initial. В dark/light это невидимо, потому что
// переменные других тем выглядят как «достаточный набор».
// Ловушка того же класса: `:root` внутри блока `<style scoped>` — Vue
// дополняет селектор атрибутом `[data-v-…]`, правило перестаёт матчить
// документ, и объявление исчезает молча. Поэтому база собирается только из
// блоков без scoped.
// Проверка статическая и потому измеримая мутациями (style-tokens-mut).
{
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const q = path.join(dir, e.name);
      if (e.isDirectory()) walk(q);
      else if (/\.(css|vue|js)$/.test(e.name) && !q.includes('themes.js')) files.push(q);
    }
  };
  walk(path.join(ROOT, 'src'));

  // Комментарии вырезаются: в них живут имена токенов с двоеточием («--accent
  // цепочкой за --accent-primary: …»), и парсер читает их как объявления.
  const noComments = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
  const declRe = /(--[\w-]+)\s*:\s*([^;]*);/g;

  // База объявлений: каждый `:root` из style.css и из ГЛОБАЛЬНЫХ `<style>` в
  // компонентах (в App.vue живёт вторая половина дизайн-системы).
  const rootDecls = [];
  const scopedRoot = [];
  for (const f of files) {
    if (!/\.(css|vue)$/.test(f)) continue;
    const raw = readFileSync(f, 'utf8');
    const blocks = f.endsWith('.vue')
      ? [...raw.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)]
          .map((st) => [/\bscoped\b/.test(st[1]), noComments(st[2])])
      : [[false, noComments(raw)]];
    for (const [isScoped, body] of blocks) {
      for (const blk of body.matchAll(/:root[^{]*\{([\s\S]*?)\n\}/g)) {
        if (isScoped) { scopedRoot.push(path.relative(ROOT, f)); continue; }
        for (const m of blk[1].matchAll(declRe)) rootDecls.push(m);
      }
    }
  }
  const rootVars = new Set(rootDecls.filter((m) => m[2].trim()).map((m) => m[1]));
  const emptyRoot = rootDecls.filter((m) => !m[2].trim()).map((m) => m[1]);
  const perTheme = {};
  for (const [id, t] of Object.entries(T.themes)) {
    perTheme[id] = new Set(Object.keys(t.vars || {}));
  }
  const inAllThemes = (tok) => Object.values(perTheme).every((set) => set.has(tok));

  const undef = [];
  for (const f of files) {
    const s = noComments(readFileSync(f, 'utf8'));
    for (const m of s.matchAll(/var\((--[\w-]+)(\s*,[^()]*(?:\([^()]*\)[^()]*)*)?\)/g)) {
      if (m[2]) continue; // есть запасное значение — значение получит всегда
      const tok = m[1];
      if (!rootVars.has(tok) && !inAllThemes(tok)) undef.push({ tok, f: path.relative(ROOT, f) });
    }
  }

  const css = noComments(readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8'));
  const allDecls = rootDecls.map((m) => m[0]).join('\n');

  ok('нет обращения к неопределённому токену (var(--x) без запасного значения)',
    undef.length === 0, undef.slice(0, 6));
  ok('в базе нет объявлений с пустым значением', emptyRoot.length === 0, emptyRoot);
  ok('объявления токенов не спрятаны в scoped-блоке (такое правило не матчит документ)',
    scopedRoot.length === 0, scopedRoot);
  // --accent обязан следовать за темой, а не застывать литералом.
  ok('база не перекрывает акцент темы (цепочка на --accent-primary)',
    /--accent:\s*var\(--accent-primary/.test(allDecls),
    (allDecls.match(/--accent:[^\n]*/) || ['объявления --accent нет'])[0]);
  // Отступы под системную навигацию — из env(), иначе на телефоне контент
  // встаёт под виртуальные кнопки (landscape Cubot X50: left=36px, right=48px).
  const safeEdges = ['bottom', 'top', 'left', 'right'];
  ok('отступы под навбар берутся из env(safe-area-inset-*), а не из нулей',
    safeEdges.every((e) => new RegExp(`--safe-${e}:\\s*env\\(safe-area-inset-${e}`).test(css)),
    safeEdges.filter((e) => !new RegExp(`--safe-${e}:\\s*env\\(safe-area-inset-${e}`).test(css)));
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
