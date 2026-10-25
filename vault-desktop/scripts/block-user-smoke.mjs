// Node-смоук features/block-user.js — блокировка отправителя из пяти мест UI.
//
// Что ловится: блокировка — это ЕДИНСТВЕННОЕ место, где «скрытое письмо»
// становится скрытым, и ошибка в нём тиха: письма просто перестают приходить.
// Пять входных точек (меню чата, баннер, меню сообщения, участник группы)
// должны вести себя ОДИНАКОВО, иначе пользователь в одном месте блокирует, а
// в другом — нет. Проверяем общее: правильный адрес, правильный переход
// (заблокирован/разблокирован), тост, перерисовка открытого чата и закрытие
// меню.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/block-user-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/block-user.js',
  MOCKS + '/block-user.mjs',
  {},
  MOCKS,
);
const B = await import(MOCKS + '/block-user.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const st = {
    ignored: new Set(),
    toasts: [],
    loaded: [],
    closed: 0,
    ignoredCalls: [],
    unignoredCalls: [],
  };
  const deps = {
    st,
    isIgnored: (email) => st.ignored.has(String(email || '').toLowerCase()),
    ignoreUser: async (email) => { st.ignoredCalls.push(email); st.ignored.add(String(email || '').toLowerCase()); },
    unignoreUser: async (email) => { st.unignoredCalls.push(email); st.ignored.delete(String(email || '').toLowerCase()); },
    activeChat: () => 'peer@x.ru',
    activeChatType: () => 'chat',
    currentGroup: () => null,
    chatMenuTarget: () => 'peer@x.ru',
    msgSenderEmail: (msg) => (msg && msg.sender_id) || '',
    loadMessages: async (chat) => { st.loaded.push(chat); },
    toast: (msg) => { st.toasts.push(msg); },
    tr: (key) => key,
    closeChatMenu: () => { st.closed += 1; },
    ...over,
  };
  return deps;
}

// ── Меню чата: переключение блокировки ─────────────────────────────────
{
  const deps = makeDeps({ chatMenuTarget: () => '' });
  await B.toggleIgnoreContact(deps);
  check('меню: адрес без цели → ничего не делаем',
    deps.st.ignoredCalls.length === 0 && deps.st.closed === 0, deps.st);
}
{
  const deps = makeDeps();
  await B.toggleIgnoreContact(deps);
  check('меню: блокировка — вызов ignore + тост + закрытие меню',
    deps.st.ignoredCalls.length === 1 && deps.st.toasts.length === 1 && deps.st.closed === 1, deps.st);
  check('меню: тост объясняет, что произошло',
    String(deps.st.toasts[0]).includes('ignore_on'), deps.st.toasts);
}
{
  const deps = makeDeps();
  deps.st.ignored.add('peer@x.ru');
  await B.toggleIgnoreContact(deps);
  check('меню: повторный клик снимает блокировку',
    deps.st.unignoredCalls.length === 1 && deps.st.ignoredCalls.length === 0, deps.st);
  check('меню: тост о разблокировке',
    String(deps.st.toasts[0]).includes('ignore_off'), deps.st.toasts);
}
{
  const deps = makeDeps();
  await B.toggleIgnoreContact(deps);
  check('меню: открытый чат с собеседником перерисован',
    deps.st.loaded.length === 1 && deps.st.loaded[0] === 'peer@x.ru', deps.st.loaded);
}
{
  const deps = makeDeps({ activeChat: () => 'other@x.ru' });
  await B.toggleIgnoreContact(deps);
  check('меню: чат с другим — перерисовки нет', deps.st.loaded.length === 0, deps.st.loaded);
}
{
  const deps = makeDeps({ activeChatType: () => 'group' });
  await B.toggleIgnoreContact(deps);
  check('меню: в группе перерисовки 1:1-чата нет', deps.st.loaded.length === 0, deps.st.loaded);
}

// ── Баннер открытого чата ──────────────────────────────────────────────
{
  const deps = makeDeps();
  await B.unblockActiveChat(deps);
  check('баннер: разблокировка + тост + перерисовка',
    deps.st.unignoredCalls.length === 1 && deps.st.toasts.length === 1 && deps.st.loaded.length === 1, deps.st);
}
{
  const deps = makeDeps({ activeChatType: () => 'group' });
  await B.unblockActiveChat(deps);
  check('баннер: в группе — ничего не делаем',
    deps.st.unignoredCalls.length === 0 && deps.st.loaded.length === 0, deps.st);
}
{
  const deps = makeDeps({ activeChat: () => '' });
  await B.unblockActiveChat(deps);
  check('баннер: без открытого чата — ничего не делаем', deps.st.unignoredCalls.length === 0, deps.st);
}

// ── Меню сообщения ─────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await B.blockSenderOfMessage(deps, { from: 'me', sender_id: 'a@x.ru' });
  check('сообщение: своё сообщение не блокируем', deps.st.ignoredCalls.length === 0, deps.st);
}
{
  // В 1:1 без явного автора блокируется адрес чата — это правило поведения
  // (в 1:1 отправитель — это собеседник чата).
  const deps = makeDeps({ msgSenderEmail: () => '' });
  await B.blockSenderOfMessage(deps, { from: 'peer', sender_id: '' });
  check('сообщение: в 1:1 без автора блокируется адрес чата',
    deps.st.ignoredCalls.length === 1 && deps.st.ignoredCalls[0] === 'peer@x.ru', deps.st.ignoredCalls);
}
{
  // В группе адреса чата нет — без автора блокировать некого.
  const deps = makeDeps({ msgSenderEmail: () => '', activeChatType: () => 'group' });
  await B.blockSenderOfMessage(deps, { from: 'peer', sender_id: '' });
  check('сообщение: в группе без автора — ничего не делаем', deps.st.ignoredCalls.length === 0, deps.st);
}
{
  const deps = makeDeps();
  await B.blockSenderOfMessage(deps, { from: 'peer', sender_id: 'author@x.ru' });
  check('сообщение: блокируем автора (sender_id, не адрес чата)',
    deps.st.ignoredCalls.length === 1 && deps.st.ignoredCalls[0] === 'author@x.ru', deps.st.ignoredCalls);
}
{
  const deps = makeDeps();
  deps.st.ignored.add('author@x.ru');
  await B.blockSenderOfMessage(deps, { from: 'peer', sender_id: 'author@x.ru' });
  check('сообщение: повторный клик снимает блокировку',
    deps.st.unignoredCalls.length === 1 && deps.st.ignoredCalls.length === 0, deps.st);
  check('сообщение: тост о разблокировке есть (иначе пользователь не знает, что произошло)',
    deps.st.toasts.length === 1, deps.st.toasts);
}
{
  // Тот же экран, что и в меню чата, но другая ветка кода: блок из меню
  // сообщения при открытом 1:1 с этим же собеседником обязан перерисовать
  // чат, иначе «блок не работает» выглядит как работающих два входа из четырёх.
  const deps = makeDeps();
  await B.blockSenderOfMessage(deps, { from: 'peer', sender_id: 'peer@x.ru' });
  check('сообщение: открытый чат с этим же адресом перерисован',
    deps.st.ignoredCalls.length === 1 && deps.st.loaded.length === 1
    && deps.st.loaded[0] === 'peer@x.ru', deps.st);
}

// ── Участник группы ────────────────────────────────────────────────────
{
  const deps = makeDeps();
  await B.blockUser(deps, 'peer@x.ru');
  check('группа: без открытой группы — ничего не делаем', deps.st.ignoredCalls.length === 0, deps.st);
}
{
  const deps = makeDeps({ currentGroup: () => ({ id: 'g1' }) });
  await B.blockUser(deps, 'peer@x.ru');
  check('группа: участник заблокирован + тост',
    deps.st.ignoredCalls.length === 1 && deps.st.toasts.length === 1, deps.st);
}
{
  const deps = makeDeps();
  await B.unblockUser(deps, '');
  check('группа: пустой адрес — ничего не делаем', deps.st.unignoredCalls.length === 0, deps.st);
}
{
  const deps = makeDeps();
  await B.unblockUser(deps, 'peer@x.ru');
  check('группа: участник разблокирован + тост',
    deps.st.unignoredCalls.length === 1 && deps.st.toasts.length === 1, deps.st);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
