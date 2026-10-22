// Smoke-тест для sending-store.js (ADR-004, Этап A10).
// Проверяет: создание, изоляция, get/set/get-back, bulk merge, remove, clear,
// null-guard, zero-import gate, no-ctx gate. Без Vue/Tauri.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// Испортируем настоящий модуль из src — он framework-agnostic.
const MODULE_PATH = path.resolve(import.meta.dirname, '..', 'src', 'features', 'sending-store.js');
const src = readFileSync(MODULE_PATH, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

console.log('\nADR-004 Этап A10 · модуль-владелец состояния отправки');

// 1. Zero-import gate: модуль не импортирует ничего.
check('нет НИ ОДНОГО импорта — модуль не зависит ни от чего, включая фреймворк',
  !/^\s*import\s/m.test(src) && !/^\s*require\s*\(/m.test(src));

// 2. No-ctx gate: модуль не упоминает `ctx` в коде (только в комментариях допустимо, но мы проверим body).
// Строго: в коде (не комментариях) нет `ctx`.
const bodyNoCtx = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
check('нет доступа к ctx', !/\bctx\b/.test(bodyNoCtx));

// 3. State начинается пустым
const { createSendingStore } = await import('file://' + MODULE_PATH);
const s1 = createSendingStore();
check('состояние начинается sending=false', s1.state.sending === false);
check('состояние начинается pendingOutgoing={}', JSON.stringify(s1.state.pendingOutgoing) === '{}');

// 4. Изоляция: второй стор не видит первый
const s2 = createSendingStore();
s1.setPendingOutgoing('chat1', { id: 'm1', text: 'hello' });
check('изоляция — второй стор не видит первый', !s2.state.pendingOutgoing['chat1']);

// 5. setSending / getSending round-trip
s1.setSending(true);
check('setSending(true) → getSending() === true', s1.getSending() === true);
s1.setSending(false);
check('setSending(false) → getSending() === false', s1.getSending() === false);
// setSending coerce
s1.setSending(1);
check('setSending(1) → getSending() === true', s1.getSending() === true);

// 6. setPendingOutgoing с id → пишет по ключу
const store = createSendingStore();
const msg = { id: 'm1', text: 'hello', status: 'sending' };
const bucket = store.setPendingOutgoing('chat:1', msg);
check('setPendingOutgoing(id) записывает по ключу', bucket['m1'] === msg && store.state.pendingOutgoing['chat:1']['m1'] === msg);

// 7. getBucket для несуществующего чата создаёт fresh
const b2 = store.getBucket('chat:2');
check('getBucket несуществующего создаёт fresh {}', JSON.stringify(b2) === '{}');

// 8. mergePendingOutgoing — full bucket replace (not deep-merge)
store.mergePendingOutgoing('chat:1', { m1: { ...msg, status: 'sent' } });
check('mergePendingOutgoing обновил запись', store.state.pendingOutgoing['chat:1']['m1'].status === 'sent');

// 9. setPendingOutgoing без id → merge-mode
store.setPendingOutgoing('chat:1', { extra: 'field' });
check('setPendingOutgoing без id merge-ит в бакет', store.state.pendingOutgoing['chat:1'].extra === 'field');

// 10. removePendingOutgoing удаляет msg
store.setPendingOutgoing('chat:1', { id: 'm2', text: 'second' });
store.removePendingOutgoing('chat:1', 'm2');
check('removePendingOutgoing удаляет msg по id', !store.state.pendingOutgoing['chat:1']['m2']);
check('removePendingOutgoing сохраняет остальные', !!store.state.pendingOutgoing['chat:1']['m1']);

// 11. removePendingOutgoing для несуществующего не падает
check('removePendingOutgoing несуществующего не падает', store.removePendingOutgoing('chat:nope', 'x') === null);

// 12. clearPendingOutgoing сбрасывает всё
store.setSending(true);
store.clearPendingOutgoing();
check('clearPendingOutgoing сбрасывает pendingOutgoing', JSON.stringify(store.state.pendingOutgoing) === '{}');
check('clearPendingOutgoing не трогает sending (осталось true)', store.getSending() === true);

// 13. setSending возвращает значение для цепочки
const returned = s1.setSending(false);
check('setSending возвращает установленное значение', returned === false);

// 14. setPendingOutgoing возвращает bucket
const retBucket = store.setPendingOutgoing('c3', { id: 'm3', text: 'x' });
check('setPendingOutgoing возвращает bucket', retBucket === store.state.pendingOutgoing['c3']);

// 15. mergePendingOutgoing ЗАМЕЩАЕТ бакет (а не сливает): старые pending,
// которых нет в remaining, должны исчезнуть.
{
  const st = createSendingStore();
  st.setPendingOutgoing('c9', { id: 'old1' });
  st.setPendingOutgoing('c9', { id: 'old2' });
  st.mergePendingOutgoing('c9', { fresh: { id: 'fresh' } });
  check('mergePendingOutgoing: бакет ЗАМЕЩЁН (старые исчезли)',
    !!st.state.pendingOutgoing.c9.fresh && !st.state.pendingOutgoing.c9.old1 && !st.state.pendingOutgoing.c9.old2,
    Object.keys(st.state.pendingOutgoing.c9 || {}));
}

// 16. dropBucket: бакет чата удаляется целиком
{
  const st = createSendingStore();
  st.setPendingOutgoing('cA', { id: 'x' });
  st.setPendingOutgoing('cB', { id: 'y' });
  st.dropBucket('cA');
  check('dropBucket: бакет чата удалён, чужой не тронут',
    !st.state.pendingOutgoing.cA && !!st.state.pendingOutgoing.cB, Object.keys(st.state.pendingOutgoing));
}

// 17. Бакет — только запись. Строка/массив сюда попасть не могут: Object.assign
// по строке рассыпает её по символам, и поллинг подмешивает символы в чат как
// сообщения (жалоба 22.10 — «пустые пузыри» вместо переписки; случилось потому,
// что замыкание зависимости потеряло аргумент и передало ключ чата вместо msg).
{
  const st = createSendingStore();
  st.setPendingOutgoing('peer@x.com', 'peer@x.com');
  const b = st.state.pendingOutgoing['peer@x.com'];
  check('setPendingOutgoing: строка вместо pending не рассыпается по символам',
    !!b && typeof b === 'object' && Object.keys(b).length === 0, b && Object.keys(b));
  st.setPendingOutgoing('peer@x.com', ['m5', 'm6']);
  check('setPendingOutgoing: массив вместо pending не пишет числовые ключи',
    Object.keys(st.state.pendingOutgoing['peer@x.com']).length === 0);
  st.setPendingOutgoing('peer@x.com', { id: 'm7', text: 'ok' });
  st.mergePendingOutgoing('peer@x.com', 'peer@x.com');
  check('mergePendingOutgoing: строка не затирает бакет целиком',
    !!st.state.pendingOutgoing['peer@x.com'].m7, st.state.pendingOutgoing['peer@x.com']);
  check('setPendingOutgoing(null) — не падает и не пишет',
    st.setPendingOutgoing('peer@x.com', null) !== undefined);
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
