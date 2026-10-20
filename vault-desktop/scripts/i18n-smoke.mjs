// Node-смоук src/i18n.js — переводы.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Модуль отдаёт текст интерфейса на трёх языках.
// Правила, которые легко потерять: при отсутствии ключа в текущей локали
// берётся АНГЛИЙСКИЙ (а не сам ключ — пользователь увидел бы «report_send»
// вместо текста); неизвестный ключ всё же показывается как ключ (это лучше,
// чем пустая строка); подстановка параметров идёт в {плейсхолдеры}; язык
// сохраняется в localStorage.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/i18n-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// localStorage до импорта модуля (модуль читает его на верхнем уровне).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// Модуль импортирует 'vue' — в /tmp node_modules нет. Ставим минимальный
// стен: reactive → тот же объект, computed → геттер.
writeFileSync(MOCKS + '/vue.js', `
export const reactive = (o) => o;
export const computed = (fn) => ({ get value() { return fn(); } });
`);

// Копия английской локали с ОДНИМ добавленным ключом — для проверки
// fallback'а (в ru такого ключа нет).
const enCopy = MOCKS + '/locales-en.js';
mkdirSync(MOCKS, { recursive: true });
writeFileSync(enCopy, readFileSync(path.join(ROOT, 'src', 'locales', 'en.js'), 'utf8')
  .replace('export default {', "export default {\n  __test_only_en__: 'English only',\n  __test_two_params__: 'Hello {name}, you have {count} new',"));

let src = readFileSync(path.join(ROOT, 'src', 'i18n.js'), 'utf8');
src = src.replace("from 'vue'", `from "${MOCKS}/vue.js"`)
         .replace("from './locales/en.js'", `from "${MOCKS}/locales-en.js"`)
         .replace("from './locales/ru.js'", `from "${ROOT}/src/locales/ru.js"`)
         .replace("from './locales/zh.js'", `from "${ROOT}/src/locales/zh.js"`);
writeFileSync(MOCKS + '/i18n.mjs', src, 'utf8');

const I = await import(MOCKS + '/i18n.mjs');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

const { t, setLocale, availableLocales, currentLocale } = I.useI18n();

// ── Текущий язык и переключение ──────────────────────────────────────────
ok('по умолчанию английский (нет сохранённого выбора)', currentLocale.value === 'en', currentLocale.value);
setLocale('ru');
ok('язык переключается', currentLocale.value === 'ru');
ok('язык сохраняется в localStorage', localStorage.getItem('vault-locale') === 'ru');
setLocale('такого-языка-нет');
ok('неизвестный язык не переключается', currentLocale.value === 'ru', currentLocale.value);
ok('в списке языков три', availableLocales.value.length === 3, availableLocales.value);
ok('у каждого языка есть название', availableLocales.value.every((l) => typeof l.name === 'string' && l.name.length > 0));

// ── Перевод ──────────────────────────────────────────────────────────────
setLocale('ru');
ok('перевод берётся из текущей локали', t('language_ru') && t('language_ru') !== 'language_ru', t('language_ru'));
{
  // Обычный UI-ключ: в разных локалях — разный текст (названия ЯЗЫКОВ, в
  // отличие, одинаковы во всех локалях — это по замыслу).
  const ruText = t('login');
  setLocale('en');
  ok('в другой локали — другой текст', t('login') !== ruText, { ru: ruText, en: t('login') });
}
{
  // FALLBACK: ключа нет в ТЕКУЩЕЙ локали, но есть в английской → берётся
  // английский (иначе пользователь увидел бы сам ключ). Ключ добавляем в
  // КОПИЮ английской локали (реальные файлы не трогаем) — так проверяется
  // ровно то правило, что нужно: непереведённый ключ не должен быть виден
  // пользователю как «report_send».
  setLocale('ru');
  const out = t('__test_only_en__');
  ok('непереведённый ключ → английский текст (не сам ключ)',
    out === 'English only', { out });
}
ok('неизвестный ключ показывается как сам ключ (не пустая строка)',
  t('__такого_ключа_нет__') === '__такого_ключа_нет__', t('__такого_ключа_нет__'));

// ── Параметры ────────────────────────────────────────────────────────────
{
  setLocale('en');
  const out = t('__test_two_params__', { name: 'VALUE', count: 42 });
  ok('оба параметра подставляются (не только первый)',
    out.includes('VALUE') && out.includes('42') && !out.includes('{name}') && !out.includes('{count}'), out);
  const out2 = t('__test_two_params__', { name: 'V' });
  ok('незаданный параметр остаётся плейсхолдером (не «undefined»)',
    out2.includes('{count}') && !out2.includes('undefined'), out2);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
