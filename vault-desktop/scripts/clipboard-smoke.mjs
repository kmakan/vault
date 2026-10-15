// Копирование в буфер (ADR-003 Этап 3, партия 10).
//
// Фолбэк через execCommand — не «запасной путь на всякий случай», а единственно
// рабочий там, где navigator.clipboard недоступен: WebKitGTK без фокуса, старый
// WebView, иногда Android при вызове не из жеста. Поэтому он проверяется
// отдельно и явно: если фолбэк отвалится, заметят только те, у кого и так всё
// плохо.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/clipboard-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const st = { exec: [], appended: [], removed: [] };
globalThis.__st = st;
writeFileSync(MOCKS + '/clipboard.mjs', readFileSync(path.join(ROOT, 'src', 'clipboard.js'), 'utf8'));
const CB = await import(MOCKS + '/clipboard.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };

// navigator в Node — только геттер, прямое присваивание падает.
// Определяем свойство явно.
const setNav = (v) => Object.defineProperty(globalThis, 'navigator', {
  value: v, configurable: true, writable: true,
});

// Мини-браузер: достаточно, чтобы дойти до фолбэка.
const installDom = ({ execFails = false, selectFails = false } = {}) => {
  globalThis.document = {
    body: {
      appendChild: (el) => { st.appended.push(el); },
      removeChild: (el) => { st.removed.push(el); },
    },
    createElement: () => ({
      value: '', style: {},
      select: () => { if (selectFails) throw new Error('select не работает'); st.exec.push('select'); },
    }),
    execCommand: (cmd) => {
      st.exec.push(cmd);
      if (execFails) throw new Error('execCommand отказал');
      return true;
    },
  };
  st.exec = []; st.appended = []; st.removed = [];
};

console.log('\nADR-003 Этап 3, партия 10 · копирование в буфер');

// 1. Основной путь: navigator.clipboard доступен и отвечает.
installDom();
let used = 0;
setNav({ clipboard: { writeText: async (t) => { used++; if (t === 'FAIL') throw new Error('отказ'); } } });
ok('clipboard API → true, фолбэк не трогаем', (await CB.copyTextToClipboard('текст')) === true && used === 1);
ok('в фолбэк не пошли', st.exec.length === 0);

// 2. clipboard бросает → фолбэк срабатывает.
installDom();
setNav({ clipboard: { writeText: async () => { throw new Error('Permission denied'); } } });
ok('отказ clipboard API → фолбэк, результат true', (await CB.copyTextToClipboard('текст')) === true);
ok('фолбэк вызвал select и execCommand', st.exec.join(',') === 'select,copy');

// 3. clipboard отсутствует целиком (старый WebView).
installDom();
setNav({});
ok('нет navigator.clipboard → фолбэк', (await CB.copyTextToClipboard('текст')) === true);
ok('textarea создана, выделена, скопирована и убрана',
  st.appended.length === 1 && st.removed.length === 1 && st.removed[0] === st.appended[0]);
ok('элемент уведён с глаз перед execCommand',
  st.appended[0].style.position === 'fixed' && st.appended[0].style.opacity === '0');

// 4. Фолбэк тоже отказал → false, а не исключение.
installDom({ execFails: true });
setNav({});
ok('отказ фолбэка → false, без исключения', (await CB.copyTextToClipboard('текст')) === false);

installDom({ selectFails: true });
setNav({});
ok('отказ select → false, без исключения', (await CB.copyTextToClipboard('текст')) === false);

// 5. navigator отсутствует вовсе (SSR/ранняя инициализация) — не должно падать.
// navigator отсутствует, но document есть: фолбэк ОБЯЗАН сработать. Первая
// версия теста ждала здесь false и падала — но false означало бы «скопировать
// невозможно», а фолбэк как раз для того, чтобы копирование работало там, где
// clipboard API нет. Проверять надо оба случая.
installDom();
setNav(undefined);
ok('без navigator фолбэк всё равно копирует — ради этого он и нужен',
  (await CB.copyTextToClipboard('текст')) === true && st.exec.includes('copy'));

// Совсем ничего нет — среда без и navigator, и document.
installDom();
setNav(undefined);
delete globalThis.document;
ok('ни navigator, ни document → false, без ReferenceError',
  (await CB.copyTextToClipboard('текст')) === false);

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);