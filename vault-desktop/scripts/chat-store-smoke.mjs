// Модуль-владелец переписки (ADR-004, Этап A1).
//
// ТЕСТ ПРОВЕРЯЕТ НЕ СТРОКИ, А ИМУТАБЕЛЬНОСТЬ, И В ЭТОМ СМЫСЛЕ «ИМУТАБЕЛЬНОСТЬ»
// ЗДЕСЬ ОЧЕНЬ ОСТОРОЖНОЕ СЛОВО. Переписка — самое ценное состояние приложения,
// и ошибка в ней приводит к тому, что человек теряет переписку. Поэтому тест
// закрывает не «функции вызываются», а «ничто не происходит тихо».
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// Владелец БЕЗ импортов (в том числе без vue), поэтому импортируется прямо из
// исходника — без копии в /tmp и без подмены зависимостей.
const { createChatStore } = await import(path.join(ROOT, 'src', 'chat-store.js'));

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };

console.log('\nADR-004 Этап A1 · модуль-владелец переписки');

// ── Создание ────────────────────────────────────────────────────────────
const s = createChatStore();
ok('состояние начинается пустым', Array.isArray(s.state.messages) && s.state.messages.length === 0);
ok('list() отдаёт тот же массив, а не копию (иначе двойное владение)',
  s.list() === s.state.messages);
ok('созданные сторы независимы — второй не видит первый',
  (() => { const a = createChatStore(), b = createChatStore(); a.append({ id: 'x' }); return b.state.messages.length === 0; })());

// ── Добавление ──────────────────────────────────────────────────────────
const m1 = { id: 'm1', text: 'привет' };
ok('append кладёт сообщение', s.append(m1) === true && s.state.messages.length === 1 && s.state.messages[0] === m1);
ok('append возвращает true при успехе', s.append({ id: 'm2' }) === true);
ok('append возвращает false при дубле (id уже есть)', s.append(m1) === false);
ok('дубль не добавлен — сообщений по-прежнему 2', s.state.messages.length === 2);
ok('append(null) не падает — в переписке бывают дыры, и их нельзя ронять',
  s.append(null) === true && s.state.messages.length === 3);
ok('append({}) без id не падает', s.append({}) === true);

// ── Замена целиком ──────────────────────────────────────────────────────
s.set([{ id: 'a' }, { id: 'b' }]);
ok('set заменяет содержимое', s.state.messages.length === 2 && s.state.messages[0].id === 'a');
// Копия НЕ делается намеренно: она означала бы двойное владение.
// Проверяем, что set кладёт тот же массив, а не копию:
const arr = [{ id: 'x' }];
s.set(arr);
ok('set не копирует — это осознанно, копия = двойное владение', s.state.messages === arr);

s.set([{ id: 'c' }]);
ok('идемпотентность set с тем же массивом не ломает ничего', s.state.messages.length === 1);

// ── Очистка ─────────────────────────────────────────────────────────────
s.set([{ id: 'z' }]);
s.clear();
ok('clear опустошает', s.state.messages.length === 0);

// ── Сортировка на месте ─────────────────────────────────────────────────
s.set([{ id: 'b', ts: 2 }, { id: 'a', ts: 1 }, { id: 'c', ts: 3 }]);
const returned = s.sortBy((x, y) => x.ts - y.ts);
ok('sortBy упорядочивает по возрастанию',
  s.state.messages.map((m) => m.id).join(',') === 'a,b,c');
ok('sortBy возвращает тот же массив (сортировка на месте, не копия)',
  returned === s.state.messages);
// ПОРЯДОК — ЧАСТЬ СОСТОЯНИЯ. Если бы sortBy возвращал копию, второй вызов
// сортировал бы копию, а state.messages остался бы раз sorted навсегда — и
// вызывающий получил бы «успех», не изменивший ничего.
ok('повторная сортировка по тому же правилу ничего не ломает',
  (s.sortBy((x, y) => x.ts - y.ts), s.state.messages.map((m) => m.id).join(',') === 'a,b,c'));

// ── Мутация элемента (patch) ──────────────────────────────────────────────
s.set([{ id: 'r1', reactions: ['👍'] }, { id: 'r2' }]);
ok('patch применяет функцию мутации', s.patch('r1', (m) => { m.reactions.push('❤️'); }) === true);
ok('patch изменил элемент', s.byId('r1').reactions.join(',') === '👍,❤️');
ok('patch на отсутствующем id — false, не исключение', s.patch('нет', () => {}) === false);
ok('patch не создаёт сообщение, если его нет', s.byId('нет') === null);
ok('patch(null) не падает', s.patch(null, () => {}) === false);

// ── Удаление ────────────────────────────────────────────────────────────
s.set([{ id: 'p' }, { id: 'q' }, { id: 'r' }]);
ok('removeById удаляет нужное', s.removeById('q') === true);
ok('и только нужное', s.state.messages.map((m) => m.id).join(',') === 'p,r');
ok('удаление отсутствующего — false, а не исключение', s.removeById('нет') === false);
ok('и массив не тронут', s.state.messages.length === 2);
// ПОЧЕМУ ПО ID, А НЕ ПО ИНДЕКСУ. Индекс протухает между поиском и удалением:
// фильтрация, сортировка или обновление между ними — и удалится не то.
ok('удаление не сдвигает удаление соседа',
  (s.set([{ id: 'x' }, { id: 'y' }, { id: 'z' }]),
   s.removeById('y'), s.removeById('z'), s.state.messages.map((m) => m.id).join(',') === 'x'));

// ── Поиск ───────────────────────────────────────────────────────────────
s.set([{ id: 'k1' }, { id: 'k2' }]);
ok('byId находит', s.byId('k2').id === 'k2');
ok('byId отсутствующего даёт null, не undefined и не исключение', s.byId('нет') === null);
ok('byId на пустом списке — null', (s.clear(), s.byId('k1') === null));

// ── Границы ─────────────────────────────────────────────────────────────
s.set([]);
s.append(null);
ok('append(null) не падает — в переписке бывают дыры, и их нельзя ронять',
  s.state.messages.length === 1);
ok('byId(null) не падает', s.byId(null) === null);
ok('removeById(null) не падает', s.removeById(null) === false);
s.set([{ id: 'u' }, null, { id: 'v' }]);
ok('removeById игнорирует битые элементы', s.removeById('v') === true && s.state.messages.length === 2);

// ── Независимость как требование, а не как пожелание ────────────────────
// ── unreadCounts (ADR-004 A11) ──
const u = createChatStore();
ok('unreadCounts стартует пустым', JSON.stringify(u.state.unreadCounts) === '{}');
ok('unreadOf несуществующего → 0', u.unreadOf('peer@x.ru') === 0);
ok('incUnread инкрементирует', u.incUnread('peer@x.ru') === 1 && u.incUnread('peer@x.ru') === 2);
ok('unreadOf читает после инкремента', u.unreadOf('peer@x.ru') === 2);
ok('incUnread чужого чата не трогает текущий', (u.incUnread('other@x.ru'), u.unreadOf('peer@x.ru') === 2 && u.unreadOf('other@x.ru') === 1));
ok('clearUnread удаляет ключ', (u.clearUnread('peer@x.ru'), u.unreadOf('peer@x.ru') === 0));
ok('setUnread заменяет бакет целиком', (u.setUnread({ a: 1, b: 2 }), u.unreadOf('a') === 1 && u.unreadOf('b') === 2 && u.unreadOf('peer@x.ru') === 0));
ok('clearAllUnread сбрасывает всё', (u.clearAllUnread(), JSON.stringify(u.state.unreadCounts) === '{}'));
ok('incUnread атомарен: 3-кратный вызов даёт 3', (u.incUnread('c'), u.incUnread('c'), u.incUnread('c'), u.unreadOf('c') === 3));

// ── newMessage / draft (ADR-004 A14) ──
const d = createChatStore();
ok('newMessage стартует пустым', d.state.newMessage === '');
ok('getDraft пустой → ""', d.getDraft() === '');
ok('setDraft пишет', d.setDraft('привет') === 'привет' && d.getDraft() === 'привет');
ok('setDraft(null) → "" (не краш)', d.setDraft(null) === '' && d.getDraft() === '');
ok('clearDraft сбрасывает', (d.setDraft('x'), d.clearDraft(), d.getDraft() === ''));

console.log('── гейт: владелец ни от чего снаружи не зависит ──');
const body = readFileSync(path.join(ROOT, 'src', 'chat-store.js'), 'utf8');
const imports = [...body.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
ok('нет НИ ОДНОГО импорта — модуль не зависит ни от чего, включая фреймворк',
  imports.length === 0, 'найдено: ' + JSON.stringify(imports));
ok('нет доступа к ctx', !/\bctx\b/.test(body.replace(/\/\/.*$/gm, '')));
ok('нет доступа к api, crypto, invoke', !/\b(api|crypto|invoke)\s*\./.test(body));

// ── Счётчики непрочитанных и черновик (владелец чата) ──────────────────
{
  const st = createChatStore();
  st.incUnread('c1');
  st.incUnread('c1');
  st.incUnread('c2');
  ok('incUnread: счётчик растёт', st.unreadOf('c1') === 2 && st.unreadOf('c2') === 1, st.state.unreadCounts);
  st.clearUnread('c1');
  ok('clearUnread: счётчик обнулён', st.unreadOf('c1') === 0 && st.unreadOf('c2') === 1, st.state.unreadCounts);
  // Ключ должен ИСЧЕЗНУТЬ, а не остаться с нулём: иначе карта счётчиков
  // растёт и «нулевые» чаты светятся в разметке.
  ok('clearUnread: ключ чата удалён из карты', !('c1' in st.state.unreadCounts), Object.keys(st.state.unreadCounts));
  st.clearAllUnread();
  ok('clearAllUnread: все счётчики обнулены', st.unreadOf('c2') === 0, st.state.unreadCounts);
  st.setUnread({ c3: 5 });
  ok('setUnread: карта заменена', st.unreadOf('c3') === 5, st.state.unreadCounts);
  st.setDraft('черновик');
  ok('setDraft/getDraft: черновик сохранён', st.getDraft() === 'черновик', st.getDraft());
  st.clearDraft();
  ok('clearDraft: черновик очищен', st.getDraft() === '', st.getDraft());
}

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
