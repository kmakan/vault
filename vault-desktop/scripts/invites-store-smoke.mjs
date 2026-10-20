// Node-смоук features/invites-store.js — владелец очереди инвайтов.
//
// Владелец — единственное место, где живут данные очереди (ADR-004): поля
// писали ДВА модуля (invites.js и contacts.js), поэтому «список vs счётчик»
// и «кто сдвигает индекс» должны быть в одном месте. Смоук фиксирует
// СЕМАНТИКУ операций: что возвращается, что мутируется по месту, а что
// заменяется целиком.
import { createInvitesStore } from '../src/features/invites-store.js';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

const s = createInvitesStore();

// 1. Начальное состояние — пустое
check('изначально пусто',
  s.getPendingInvites().length === 0 && s.getPendingContacts().length === 0
  && s.state.handledInviteKeys.length === 0 && s.state.handledContactKeys.length === 0);

// 2. setPendingInvites ЗАМЕНЯЕТ очередь (не дописывает)
s.setPendingInvites([{ id: 1 }]);
s.setPendingInvites([{ id: 2 }]);
check('setPendingInvites заменяет очередь', s.getPendingInvites().length === 1
  && s.getPendingInvites()[0].id === 2, s.getPendingInvites());

// 3. pushPendingInvite дописывает
s.pushPendingInvite({ id: 3 });
check('pushPendingInvite дописывает', s.getPendingInvites().length === 2, s.getPendingInvites());

// 4. splicePendingInvite убирает по индексу (по месту, тот же массив)
const arr = s.getPendingInvites();
s.splicePendingInvite(0);
check('splicePendingInvite убирает по индексу', s.getPendingInvites().length === 1
  && s.getPendingInvites()[0].id === 3, s.getPendingInvites());
check('splice мутирует тот же массив (шаблон видит изменение)',
  arr === s.getPendingInvites());

// 5. Метки «в обработке»: без дублей, снятие работает
s.markInviteHandled('G1|1');
s.markInviteHandled('G1|1');
check('метка не дублируется', s.state.handledInviteKeys.length === 1, s.state.handledInviteKeys);
check('isInviteHandled видит метку', s.isInviteHandled('G1|1'));
s.unmarkInviteHandled('G1|1');
check('unmark снимает метку', !s.isInviteHandled('G1|1') && s.state.handledInviteKeys.length === 0);

// 6. Метки контактов — отдельное пространство
s.markContactHandled('c@x|5');
check('метка контакта не смешана с меткой инвайта',
  s.isContactHandled('c@x|5') && !s.isInviteHandled('c@x|5'));

// 7. reset() чистит очереди, но НЕ метки «в обработке»
//    (метки — про принятые/отклонённые, а не про показ: после логауна-логина
//    старые инвайты не должны всплыть заново)
s.setPendingInvites([{ id: 9 }]);
s.setPendingContacts([{ id: 8 }]);
s.reset();
check('reset чистит очереди',
  s.getPendingInvites().length === 0 && s.getPendingContacts().length === 0);
check('reset НЕ чистит метки «в обработке»', s.isContactHandled('c@x|5'));

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
