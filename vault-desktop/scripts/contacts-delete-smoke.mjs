// Удаление контакта: порядок шагов и состояние (ADR-003 Этап 3, партия 14).
//
// Удаление необратимо, поэтому здесь проверяется не «вызвал ли он четыре
// функции», а ПОРЯДОК и что происходит при отказе на любом шаге.
//
// Самый тонкий шаг — второй: пометить старые handshake письма обработанными по
// uid. Логика обратна ожидаемой. Старые письма должны перестать воскрешать
// контакт, а НОВЫЕ приглашения после удаления обязаны дойти (их uid не
// помечен) — иначе удалённый человек не сможет добавиться снова. Проверки ниже
// фиксируют, что порядок именно такой.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/contacts-delete-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const calls = [];
globalThis.__calls = calls;
writeFileSync(MOCKS + '/api.js', `
const c = globalThis.__calls;
const mk = (name) => async (email) => {
  c.push(name);
  if (globalThis.__failAt === name) throw new Error(name + ' отказал');
};
const api = {
  markContactHandshakeDone: mk('markContactHandshakeDone'),
  removeInvitedSender: mk('removeInvitedSender'),
  removeContact: mk('removeContact'),
};
export { api };
export default api;
`);
writeFileSync(MOCKS + '/crypto.js', `
const c = globalThis.__calls;
export default {
  removePeerKey: async (email) => {
    c.push('removePeerKey');
    if (globalThis.__failAt === 'removePeerKey') throw new Error('removePeerKey отказал');
  },
};
`);

let src = readFileSync(path.join(ROOT, 'src', 'features', 'contacts-delete.js'), 'utf8');
src = src.replace("from '../api.js'", `from "${MOCKS}/api.js"`);
src = src.replace("from '../crypto.js'", `from "${MOCKS}/crypto.js"`);
writeFileSync(MOCKS + '/cd.mjs', src, 'utf8');
const D = await import(MOCKS + '/cd.mjs');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ ПРОВАЛ:', name); } };
const reset = () => { calls.length = 0; globalThis.__failAt = null; };

console.log('\nADR-003 Этап 3, партия 14 · удаление контакта');

// ── Порядок шагов ──────────────────────────────────────────────────────
reset();
await D.deleteContactLocally('a@b.ru');
ok('ровно четыре шага', calls.length === 4);
ok('ПОРЯДОК: ключ → пометка handshake → снятие приглашения → stub',
  calls.join(',') === 'removePeerKey,markContactHandshakeDone,removeInvitedSender,removeContact');

// ── Отказ любого шага останавливает остальные ───────────────────────────
for (const step of ['removePeerKey', 'markContactHandshakeDone', 'removeInvitedSender', 'removeContact']) {
  reset();
  globalThis.__failAt = step;
  let threw = false, msg = '';
  try { await D.deleteContactLocally('a@b.ru'); } catch (e) { threw = true; msg = String(e.message || e); }
  const idx = calls.indexOf(step);
  ok('отказ на «' + step + '»: остальные шаги НЕ выполняются',
    threw === true && idx === calls.length - 1);
  ok('отказ на «' + step + '»: причина дошла до вызывающего', msg.includes(step));
}

// Почему это важно: полуудалённый контакт хуже неудалённого. Ключ снесён, а
// запись оставлена — следующая попытка удаления уже ничего не снесёт.
reset();
globalThis.__failAt = 'markContactHandshakeDone';
try { await D.deleteContactLocally('a@b.ru'); } catch (e) { /* ожидаемо */ }
ok('ключ снесён, но stub НЕ убран — ровно то состояние «полуудалён»',
  calls.join(',') === 'removePeerKey,markContactHandshakeDone');

// ── Состояние после удаления ───────────────────────────────────────────
let st = D.contactRemovalState('a@b.ru', { activeChat: 'a@b.ru', activeChatType: 'chat' });
ok('открытый чат удалённого контакта закрывается', st.closeChat === true);
ok('и тип возвращается в chat', st.activeChatType === 'chat');

st = D.contactRemovalState('a@b.ru', { activeChat: 'c@d.ru', activeChatType: 'group' });
ok('чужой открытый чат не трогается', st.closeChat === false);
ok('и его тип не сбрасывается', st.activeChatType === 'group');

st = D.contactRemovalState('a@b.ru', {});
ok('при отсутствии состояния — не падает, closeChat = false',
  st.closeChat === false && st.activeChatType === undefined);
ok('перечитать контакты требуется всегда', st.reload === true);

// НЕ ЧТО ЗДЕСЬ ВАЖНО: у открытого КАНАЛА activeChatType может быть не 'chat'.
// Сброс типа нужен именно для этого случая — иначе после закрытия активным
// остался бы канал по несуществующему адресу.
st = D.contactRemovalState('a@b.ru', { activeChat: 'a@b.ru', activeChatType: 'channel' });
ok('при сбросе чата тип принудительно становится chat, а не сохраняется',
  st.activeChatType === 'chat');

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);