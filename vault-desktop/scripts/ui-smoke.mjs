// Node-смоук src/ui.js — замена системных alert/confirm/prompt.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. В WebKitGTK (Tauri) нативный alert показывает
// заголовок «javascript - tauri://localhost» и светит внутреннюю технологию;
// модуль подменяет его на СВОИ элементы. Подмена стоит пользователю
// подтверждений («Удалить контакт?», ввод имени группы) — если она ломается,
// действие либо не спрашивает, либо спрашивает не тем.
//
// ПРОВЕРЯЕМ: alert → тост с текстом; confirm → модалка с сообщением, ОК
// даёт true, «Отмена» — false; prompt → модалка с полем ввода, ОК даёт
// введённое, «Отмена» — null; Escape закрывает (false/null); диалог
// закрывается с DOM.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── Минимальный стен DOM ─────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.className = '';
    this.textContent = '';
    this.type = '';
    this.value = '';
    this.placeholder = '';
    this.listeners = {};
    this.classList = { add: () => {}, remove: () => {} };
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  focus() {}
  select() {}
  click() { for (const fn of this.listeners.click || []) fn({ target: this }); }
  keydown(key) { for (const fn of this.listeners.keydown || []) fn({ key, target: this }); }
  mousedown(target) { for (const fn of this.listeners.mousedown || []) fn({ target: target || this }); }
  find(cls) {
    for (const c of this.children) {
      if (c.className === cls) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
  all(cls, out = []) {
    for (const c of this.children) {
      if (c.className === cls) out.push(c);
      c.all(cls, out);
    }
    return out;
  }
}
const docRoot = new El('body');
const docListeners = {};
globalThis.document = {
  body: docRoot,
  getElementById: () => null,
  createElement: (tag) => new El(tag),
  addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
  removeEventListener: (type, fn) => {
    if (docListeners[type]) docListeners[type] = docListeners[type].filter((f) => f !== fn);
  },
};
// Оригиналы сохраняем ДО подмены: иначе подмена вызывает сама себя
// (внутри стрелки `setTimeout` — это уже глобальная, то есть НАША).
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
globalThis.requestAnimationFrame = (fn) => { fn(); };
globalThis.setTimeout = (fn, ms) => { realSetTimeout(fn, ms); return 0; };
globalThis.clearTimeout = (id) => realClearTimeout(id);

// Модуль подменяет window.alert/confirm/prompt при импорте.
const win = { navigator: { userAgent: 'node' } };
globalThis.window = win;

const src = readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');
const mod = new Function('window', 'document', 'requestAnimationFrame', 'setTimeout', 'clearTimeout',
  src + '\nreturn { ensureRoot };');
const { ensureRoot } = mod(win, globalThis.document, globalThis.requestAnimationFrame,
  globalThis.setTimeout, globalThis.clearTimeout);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
function reset() { docRoot.children = []; }
const root = () => docRoot.children[0];

// ── alert → тост ─────────────────────────────────────────────────────────
{
  reset();
  win.alert('Удалено');
  const toasts = root().all('vault-toast');
  ok('alert создаёт тост', toasts.length === 1, toasts.length);
  ok('в тосте текст сообщения', toasts[0] && toasts[0].textContent === 'Удалено', toasts[0] && toasts[0].textContent);
  ok('тост не блокирует (это не alert)', root().find('vault-dialog-overlay') === null);
}

// ── confirm ─────────────────────────────────────────────────────────────
{
  reset();
  const p = win.confirm('Удалить контакт?');
  const overlay = root().find('vault-dialog-overlay');
  ok('confirm открывает модалку', !!overlay);
  ok('в модалке текст вопроса', overlay && overlay.find('vault-dialog-msg').textContent === 'Удалить контакт?');
  ok('в модалке есть «Отмена» и «ОК»',
    overlay && !!overlay.find('vault-dialog-cancel') && !!overlay.find('vault-dialog-ok'));
  ok('в модалке confirm НЕТ поля ввода', overlay && overlay.find('vault-dialog-input') === null);
  overlay.find('vault-dialog-ok').click();
  const v = await p;
  ok('«ОК» подтверждает (true)', v === true, v);
  ok('после закрытия модалки её нет в DOM', root().find('vault-dialog-overlay') === null);
}
{
  reset();
  const p = win.confirm('Удалить контакт?');
  root().find('vault-dialog-overlay').find('vault-dialog-cancel').click();
  const v = await p;
  // Web-API: confirm обязан вернуть boolean — «Отмена» даёт false (не null).
  ok('«Отмена» отклоняет (false, как Web-API)', v === false, v);
}
{
  reset();
  const p = win.confirm('Удалить контакт?');
  // Escape закрывает диалог подтверждения.
  for (const fn of (docListeners.keydown || [])) fn({ key: 'Escape' });
  const v = await p;
  ok('Escape отклоняет (false)', v === false, v);
  ok('Escape убирает модалку из DOM', root().find('vault-dialog-overlay') === null);
  ok('Escape снимает слушатель клавиш', !(docListeners.keydown || []).length, (docListeners.keydown || []).length);
}

// ── prompt ──────────────────────────────────────────────────────────────
{
  reset();
  const p = win.prompt('Имя новой группы', 'Работа');
  const overlay = root().find('vault-dialog-overlay');
  ok('prompt открывает модалку с полем ввода', !!overlay && !!overlay.find('vault-dialog-input'));
  const input = overlay.find('vault-dialog-input');
  ok('в поле подставлено значение по умолчанию', input.value === 'Работа', input.value);
  input.value = 'Проект X';
  overlay.find('vault-dialog-ok').click();
  const v = await p;
  ok('«ОК» возвращает введённое', v === 'Проект X', v);
}
{
  reset();
  const p = win.prompt('Имя новой группы', 'Работа');
  root().find('vault-dialog-overlay').find('vault-dialog-cancel').click();
  const v = await p;
  ok('«Отмена» возвращает null (не пустую строку)', v === null, v);
}
{
  reset();
  const p = win.prompt('Имя новой группы');
  const overlay = root().find('vault-dialog-overlay');
  const input = overlay.find('vault-dialog-input');
  ok('без значения по умолчанию поле пустое', input.value === '', input.value);
  input.value = 'X';
  overlay.find('vault-dialog-ok').click();
  ok('введённое возвращается', (await p) === 'X');
}

// ── Enter в prompt ──────────────────────────────────────────────────────
{
  reset();
  const p = win.prompt('Имя новой группы');
  const overlay = root().find('vault-dialog-overlay');
  const input = overlay.find('vault-dialog-input');
  input.value = 'Через Enter';
  // Ключевое событие слушается на document — эмулируем его там.
  for (const fn of (docListeners.keydown || [])) fn({ key: 'Enter' });
  ok('Enter отправляет введённое', (await p) === 'Через Enter');
  ok('после Enter модалки нет в DOM', root().find('vault-dialog-overlay') === null);
}

// ── Клик по подложке закрывает диалог ───────────────────────────────────
{
  reset();
  const p = win.confirm('Удалить контакт?');
  const overlay = root().find('vault-dialog-overlay');
  overlay.mousedown(overlay); // клик по самой подложке
  ok('клик по подложке закрывает диалог (отменяет)', (await p) === false);
  ok('после клика по подложке модалки нет в DOM', root().find('vault-dialog-overlay') === null);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
