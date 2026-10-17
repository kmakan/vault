// Node-смоук features/identity-store.js — владелец peer-ключей (ADR-004 J.6).
// Проверяет: set/get/remove/load/clear, нормализацию email (нижний регистр),
// pq не затирается null, markLoaded/hasPeerKey.
// Запуск: node scripts/identity-store-smoke.mjs
import { createIdentityStore, identityStore } from '../src/features/identity-store.js';

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

console.log('identity-store (singleton):');
identityStore.clearPeerKeys();
identityStore.setPeerKey('Peer@X.ru', 'PUB1', 'PQ1');
ok('set+get (нормализация регистра)', identityStore.getPeerKey('peer@x.ru') === 'PUB1');
ok('getPq', identityStore.getPeerPqKey('PEER@X.RU') === 'PQ1');
ok('hasPeerKey', identityStore.hasPeerKey('peer@x.ru') === true);
ok('hasPeerKey чужого false', identityStore.hasPeerKey('other@x.ru') === false);
// pq=null не трогает существующий pq.
identityStore.setPeerKey('peer@x.ru', 'PUB2', null);
ok('pq не затёрт null', identityStore.getPeerPqKey('peer@x.ru') === 'PQ1');
ok('ключ обновлён', identityStore.getPeerKey('peer@x.ru') === 'PUB2');
// remove чистит все три хранилища.
identityStore.markLoaded('peer@x.ru');
ok('remove вернул true', identityStore.removePeerKey('PEER@x.ru') === true);
ok('после remove ключ пуст', identityStore.getPeerKey('peer@x.ru') == null);
ok('после remove pq пуст', identityStore.getPeerPqKey('peer@x.ru') == null);
ok('после remove hasPeerKey false', identityStore.hasPeerKey('peer@x.ru') === false);
ok('remove отсутствующего false', identityStore.removePeerKey('nobody@x.ru') === false);
// bulk load.
identityStore.loadPeerKeys([
  { email: 'a@x.ru', public_key: 'PA', pq_public_key: 'PQA' },
  { email: 'b@x.ru', public_key: 'PB' },
]);
ok('load: a123', identityStore.getPeerKey('a@x.ru') === 'PA' && identityStore.getPeerPqKey('a@x.ru') === 'PQA');
ok('load: b без pq', identityStore.getPeerKey('b@x.ru') === 'PB' && identityStore.getPeerPqKey('b@x.ru') == null);
identityStore.clearPeerKeys();
ok('clear чистит всё', identityStore.getPeerKey('a@x.ru') == null && identityStore.getPeerKey('b@x.ru') == null);

console.log('\nidentity-store (фабрика createIdentityStore):');
const s = createIdentityStore();
s.setPeerKey('f@x.ru', 'PF');
// Фабрика делит модульные объекты с singleton (общее хранилище модуля) —
// это сознательно: владелец один на приложение. Проверяем API, а не изоляцию.
ok('фабрика пишет через тот же API', s.getPeerKey('f@x.ru') === 'PF');
s.removePeerKey('f@x.ru');
ok('фабрика чистит за собой', s.getPeerKey('f@x.ru') == null);

console.log(`\n=== ИТОГ: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
