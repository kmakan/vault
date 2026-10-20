// Node-смоук features/chat-ui.js — навигация по чату: скролл, меню чата и
// сообщения, мобильный чат, видимость чата.
//
// ADR-005 W3 (`t_b1bdbb99`), партия 10: логика уехала из App.vue. Состояние —
// у владельца форм (uiStore), DOM и окно — через deps.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/chat-ui-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// Окно браузера: модуль считает координаты от window.innerWidth/innerHeight.
globalThis.window = { innerWidth: 400, innerHeight: 800 };
globalThis.__shellMock = { opened: [] };
writeFileSync(MOCKS + '/shell-mock.mjs',
  'export const open = async (url) => { globalThis.__shellMock.opened.push(url); };\n');

prepareModuleCopy(
  ROOT + '/src/features/chat-ui.js',
  MOCKS + '/chat-ui.mjs',
  { '@tauri-apps/plugin-shell': 'shell-mock.mjs' },
  MOCKS,
);
const U = await import(MOCKS + '/chat-ui.mjs');
const { uiStore } = await import(ROOT + '/src/features/session-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// ── Стенд ────────────────────────────────────────────────────────────────
const state = { isMobile: false, mobileOpen: false, jump: false, chatMenu: null, messageMenu: null, copied: [], alerts: [], el: null, menuEl: null, nextTicks: 0 };
const deps = {
  // Мобильность — из стенда (сценарии переключают её).
  get isMobile() { return state.isMobile; },
  setMobileChatOpen: (v) => { state.mobileOpen = v; },
  mobileChatOpen: () => state.mobileOpen,
  getMessageListEl: () => state.el,
  getMessageMenuEl: () => state.menuEl,
  nextTick: (cb) => { state.nextTicks++; if (cb) cb(); },
  nextTickAsync: async () => { state.nextTicks++; },
  setShowJumpToBottom: (v) => { state.jump = v; },
  setChatMenu: (v) => { state.chatMenu = v; },
  setMessageMenu: (v) => { state.messageMenu = v; },
  getMenuState: (key) => (key === 'chatMenu' ? state.chatMenu : state.messageMenu),
  setMenuState: (key, v) => { if (key === 'chatMenu') state.chatMenu = v; else state.messageMenu = v; },
  copyText: (t) => { state.copied.push(t); },
  activeChat: () => state.activeChat || '',
  activeChatType: () => state.activeChatType || 'chat',
  alert: (m) => { state.alerts.push(m); },
};
function reset(over = {}) {
  Object.assign(state, {
    isMobile: false, mobileOpen: false, jump: false, chatMenu: null, messageMenu: null,
    copied: [], alerts: [], el: null, menuEl: null, nextTicks: 0, activeChat: '', activeChatType: 'chat',
  }, over);
  globalThis.__shellMock.opened = [];
}

// 1. Мобильный чат
console.log('1. Мобильный чат');
{
  reset({ isMobile: true });
  U.openMobileChat(deps);
  check('на мобильном — чат открыт', state.mobileOpen === true);
  reset({ isMobile: false });
  U.openMobileChat(deps);
  check('на десктопе — не открывается', state.mobileOpen === false);
  reset({ isMobile: true, mobileOpen: true });   // сначала открыт — иначе «закрыт» нечего проверять
  U.closeMobileChat(deps);
  check('закрытие чата', state.mobileOpen === false);
}

// 2. scrollToBottom: у низа — прокручиваем, у верха — нет (без force)
console.log('2. scrollToBottom');
{
  reset({ el: { scrollHeight: 1000, scrollTop: 950, clientHeight: 100 } });
  U.scrollToBottom(deps, false);
  check('у нижнего края — прокрутка вниз', state.el.scrollTop === 1000, state.el.scrollTop);
  reset({ el: { scrollHeight: 1000, scrollTop: 0, clientHeight: 100 } });
  U.scrollToBottom(deps, false);
  check('вверху — не дёргаем (пользователь читает)', state.el.scrollTop === 0, state.el.scrollTop);
  U.scrollToBottom(deps, true);
  check('force — прокрутка вниз', state.el.scrollTop === 1000, state.el.scrollTop);
  reset({ el: null });
  U.scrollToBottom(deps, true);
  check('без списка — без падения', state.nextTicks >= 1);
}

// 3. onMessagesScroll: кнопка «вниз» появляется вдали от низа
console.log('3. onMessagesScroll');
{
  reset({ el: { scrollHeight: 1000, scrollTop: 0, clientHeight: 100 } });
  U.onMessagesScroll(deps);
  check('вверху — кнопка «вниз» показана', state.jump === true);
  reset({ el: { scrollHeight: 1000, scrollTop: 950, clientHeight: 100 } });
  U.onMessagesScroll(deps);
  check('у низа — кнопка скрыта', state.jump === false);
}

// 4. jumpToBottom
console.log('4. jumpToBottom');
{
  reset({ el: { scrollHeight: 1000, scrollTop: 0, clientHeight: 100, scrollTo: (o) => { state.scrolled = o; } } });
  U.jumpToBottom(deps);
  check('прокрутка вниз', state.scrolled && state.scrolled.top === 1000, state.scrolled);
  check('кнопка «вниз» скрыта', state.jump === false);
}

// 5. openChatMenu: координаты + Android-случай (clientX/Y = 0)
console.log('5. openChatMenu');
{
  reset();
  const e = { clientX: 100, clientY: 200, preventDefault() {}, stopPropagation() {} };
  U.openChatMenu(deps, { type: 'contact', email: 'a@x.ru' }, e);
  check('меню открыто', state.chatMenu && state.chatMenu.show === true, state.chatMenu);
  check('координаты меню', state.chatMenu.x === 100 && state.chatMenu.y === 200, state.chatMenu);
  // Android: контекстное меню присылает 0/0 — берём координаты элемента
  const rect = { top: 10, bottom: 60, left: 20, height: 50, width: 100 };
  const e2 = {
    clientX: 0, clientY: 0, preventDefault() {}, stopPropagation() {},
    target: { getBoundingClientRect: () => rect, closest: () => ({ getBoundingClientRect: () => rect }) },
  };
  U.openChatMenu(deps, { type: 'contact', email: 'b@x.ru' }, e2);
  check('Android: координаты от элемента, а не 0/0', state.chatMenu.y === 64 && state.chatMenu.x === 8, state.chatMenu);
}

// 6. closeChatMenu
console.log('6. closeChatMenu');
{
  reset({ chatMenu: { show: true, target: {}, x: 1, y: 2 } });
  U.closeChatMenu(deps);
  check('меню закрыто', state.chatMenu && state.chatMenu.show === false && !state.chatMenu.target, state.chatMenu);
}

// 7. openMessageMenu: телефоны и ссылки из текста
console.log('7. openMessageMenu');
{
  reset();
  const e = { clientX: 30, clientY: 40, target: { getBoundingClientRect: () => ({ left: 5, bottom: 25 }) } };
  U.openMessageMenu(deps, e, { content: 'звони +79961234567 пиши https://example.com' });
  check('меню сообщения открыто', state.messageMenu && state.messageMenu.x === 30, state.messageMenu);
  check('телефон извлечён', (state.messageMenu.phones || []).length === 1, state.messageMenu.phones);
  check('ссылка извлечена', (state.messageMenu.urls || []).length === 1, state.messageMenu.urls);
  // callEvent: текста нет — меню всё равно открывается
  reset();
  U.openMessageMenu(deps, e, { callEvent: { kind: 'ended' }, content: 'звони +79961234567' });
  check('у звонковой пилюли текст НЕ разбирается',
    state.messageMenu && !(state.messageMenu.phones || []).length && !(state.messageMenu.urls || []).length, state.messageMenu);
}

// 8. clampMenuAfterRender: меню у края экрана поджимается
console.log('8. clampMenuAfterRender');
{
  reset({
    messageMenu: { x: 395, y: 795, msg: {} },
    menuEl: { offsetWidth: 200, offsetHeight: 100 },
  });
  await U.clampMenuAfterRender(deps, 'messageMenu', 395, 795);
  check('меню поджато в экран', state.messageMenu.x <= 400 - 200 - 8 && state.messageMenu.y <= 800 - 100 - 8, state.messageMenu);
  // чужая пара координат — не трогаем
  reset({ messageMenu: { x: 10, y: 10, msg: {} }, menuEl: { offsetWidth: 200, offsetHeight: 100 } });
  await U.clampMenuAfterRender(deps, 'messageMenu', 999, 999);
  check('чужие координаты — без изменений', state.messageMenu.x === 10 && state.messageMenu.y === 10, state.messageMenu);
}

// 9. onMessageTextClick: ссылка открывается, телефон копируется
console.log('9. onMessageTextClick');
{
  reset();
  const mk = (sel, attrs) => ({
    target: { closest: (s) => (s === sel ? attrs : null) },
    preventDefault() { this.prevented = true; },
  });
  const urlEv = mk('a[data-url]', { dataset: { url: 'https://example.com' } });
  U.onMessageTextClick(deps, urlEv);
  check('ссылка открыта во внешнем приложении', globalThis.__shellMock.opened.includes('https://example.com'), globalThis.__shellMock.opened);
  const phoneEv = mk('a[data-phone]', { dataset: { phone: '+79961234567' } });
  U.onMessageTextClick(deps, phoneEv);
  check('телефон скопирован', state.copied.includes('+79961234567'), state.copied);
}

// 10. chatVisible
console.log('10. chatVisible');
{
  reset({ activeChat: 'a@x.ru', activeChatType: 'chat' });
  check('открытый чат виден', U.chatVisible(deps, 'a@x.ru') === true);
  check('другой чат не виден', U.chatVisible(deps, 'b@x.ru') === false);
  reset({ activeChat: 'group:g1', activeChatType: 'group' });
  check('открытая группа видна', U.chatVisible(deps, 'group:g1') === true);
  reset({ activeChat: 'group:g1', activeChatType: 'group', isMobile: true, mobileOpen: false });
  check('на мобильном при возврате к списку группа не видна', U.chatVisible(deps, 'group:g1') === false);
  // Мобильная навигация: вернулись к списку — чат не виден
  reset({ activeChat: 'a@x.ru', activeChatType: 'chat', isMobile: true, mobileOpen: false });
  check('на мобильном при возврате к списку чат не виден', U.chatVisible(deps, 'a@x.ru') === false);
}

// 11. searchMessages — заглушка
console.log('11. searchMessages');
{
  reset();
  U.searchMessages(deps);
  check('поиск пока заглушка (оповещение)', state.alerts.length === 1, state.alerts);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
