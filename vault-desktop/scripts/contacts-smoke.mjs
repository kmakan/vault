import { writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
const SRC='/home/maksim/whisper/vault-desktop/src/features/contacts.js';
const MOCKS='/tmp/contacts-smoke-mocks'; mkdirSync(`${MOCKS}/features`,{recursive:true});
writeFileSync(`${MOCKS}/features/contacts.js`, prepareModuleCopy(SRC,`${MOCKS}/features/contacts.js`,{},MOCKS));
const C = await import(`${MOCKS}/features/contacts.js`).then(m=>m.default||m);
let p=0,f=0; function check(l,c){if(c){p++;console.log('  ✓ '+l)}else{f++;console.log('  ✗ '+l)}}

// isIgnored
check('isIgnored пустой email → false', C.isIgnored({},{},'')===false);
check('isIgnored пустой ignoredUsers → false', C.isIgnored(null,{},'x@y.z')===false);
check('isIgnored по email', C.isIgnored({'x@y.z':Date.now()}, {}, 'x@y.z')===true);
check('isIgnored по peer-key alias (тот же pk)', C.isIgnored({'a@y.z':1}, {'a@y.z':'pk1','b@y.z':'pk1'}, 'b@y.z')===true);
check('isIgnored чужой peer key → false', C.isIgnored({'a@y.z':1}, {'a@y.z':'pk1','b@y.z':'pk2'}, 'b@y.z')===false);
check('isIgnored без peerKeys → false (empty email)', C.isIgnored({'x@y.z':1}, undefined, 'x@y.z')===true);

// isOwnSender
const aliases=(e)=>e==='me@x.y'?['me@x.y','old@x.y']:['x@y.z'];
check('isOwnSender own email', C.isOwnSender('Me <me@x.y>', 'me@x.y', aliases)===true);
check('isOwnSender старый адрес (alias)', C.isOwnSender('old@x.y', 'me@x.y', aliases)===true);
check('isOwnSender чужой → false', C.isOwnSender('peer@x.y', 'me@x.y', aliases)===false);
check('isOwnSender empty → false', C.isOwnSender('', 'me@x.y', aliases)===false);

// msgSenderEmail
const senderEmail=(raw)=>raw.replace(/^.*</,'').replace(/>$/,'');
check('msgSenderEmail строка', C.msgSenderEmail('peer@x.y', senderEmail)==='peer@x.y');
check('msgSenderEmail объект sender_id', C.msgSenderEmail({sender_id:'Name <p@x.y>'}, senderEmail)==='p@x.y');
check('msgSenderEmail null → ""', C.msgSenderEmail(null, senderEmail)==='');
check('msgSenderEmail без sender_id → ""', C.msgSenderEmail({content:'x'}, senderEmail)==='');

// findKnownPeerByKey (ADR-001: вынос из messages.js loadMessages knownByKey)
check('findKnownPeerByKey находит алиас по pubkey',
  C.findKnownPeerByKey({ 'a@x.y':'PK2','new@x.y':'PK2' }, 'PK2', 'new@x.y') === 'a@x.y');
check('findKnownPeerByKey self (sender == ключ) → null',
  C.findKnownPeerByKey({ 'a@x.y':'PK1' }, 'PK1', 'a@x.y') === null);
check('findKnownPeerByKey без совпадения → null',
  C.findKnownPeerByKey({ 'a@x.y':'PK1' }, 'PK9', 'new@x.y') === null);
check('findKnownPeerByKey без peerKeys → null (no throw)',
  C.findKnownPeerByKey(null, 'PK1', 'a@x.y') === null);

// isOutboundLetter / resolvePeerSender (ADR-001: вынос из messages.js)
check('isOutboundLetter From в own aliases', C.isOutboundLetter({ from: 'Me <OLD@x.y>' }, ['old@x.y','me@x.y']) === true);
check('isOutboundLetter чужой From → false', C.isOutboundLetter({ from: 'peer@x.y' }, ['me@x.y']) === false);
check('isOwnSender без m → false', C.isOutboundLetter(null, ['me@x.y']) === false);

check('resolvePeerSender in → peerEmail', C.resolvePeerSender(true, 'peer@x.y', 'me@x.y') === 'peer@x.y');
check('resolvePeerSender out → me', C.resolvePeerSender(false, 'peer@x.y', 'me@x.y') === 'me@x.y');

// isPeerEncrypted
check('isPeerEncrypted true (key present)', C.isPeerEncrypted({a:'k'}, true, 'a') === true);
check('isPeerEncrypted false (no key)', C.isPeerEncrypted({a:'k'}, true, 'b') === false);
check('isPeerEncrypted false (!cryptoReady)', C.isPeerEncrypted({a:'k'}, false, 'a') === false);

// resolveEventSender
check('resolveEventSender out → peerEmail', C.resolveEventSender(true, 'peer@x.y', 'me@x.y') === 'peer@x.y');
check('resolveEventSender in → fallback', C.resolveEventSender(false, 'peer@x.y', 'from@x.y') === 'from@x.y');
check('resolveEventSender in empty fallback → ""', C.resolveEventSender(false, 'peer@x.y', '') === '');

// addIgnored / removeIgnored (блокировка отправителя). Логика вынесена из
// App.vue после реальной поломки: в ignoreUser `map[key]` ссылался на `map` из
// соседнего unignoreUser → ReferenceError, блокировка не работала, а сборка и
// смоуки этого не видели (компонент смоуком не покрывается).
check('addIgnored пишет по нормализованному ключу',
  C.addIgnored({}, '  Peer@X.Y  ', 42)['peer@x.y'] === 42);
check('addIgnored не мутирует вход',
  (() => { const src = { 'a@x.y': 1 }; C.addIgnored(src, 'b@x.y', 2); return Object.keys(src).length === 1; })());
check('addIgnored без ключа → копия без записи',
  (() => { const r = C.addIgnored({ 'a@x.y': 1 }, '', 2); return r['a@x.y'] === 1 && Object.keys(r).length === 1; })());
check('addIgnored из null → одна запись',
  (() => { const r = C.addIgnored(null, 'a@x.y', 7); return r['a@x.y'] === 7 && Object.keys(r).length === 1; })());
check('removeIgnored снимает сам адрес',
  Object.keys(C.removeIgnored({ 'a@x.y': 1, 'b@x.y': 2 }, 'A@X.Y', {})).join(',') === 'b@x.y');
check('removeIgnored снимает алиас того же peer-ключа',
  Object.keys(C.removeIgnored({ 'a@x.y': 1, 'b@x.y': 2 }, 'b@x.y', { 'a@x.y': 'PK1', 'b@x.y': 'PK1' })).length === 0);
check('removeIgnored не трогает чужой ключ',
  Object.keys(C.removeIgnored({ 'a@x.y': 1, 'b@x.y': 2 }, 'b@x.y', { 'a@x.y': 'PK1', 'b@x.y': 'PK2' })).join(',') === 'a@x.y');
check('removeIgnored без peerKeys снимает только сам адрес',
  Object.keys(C.removeIgnored({ 'a@x.y': 1, 'b@x.y': 2 }, 'b@x.y', undefined)).join(',') === 'a@x.y');
check('removeIgnored не мутирует вход',
  (() => { const src = { 'a@x.y': 1 }; C.removeIgnored(src, 'a@x.y', {}); return Object.keys(src).length === 1; })());

console.log('=== ИТОГО: '+p+' pass, '+f+' fail ==='); if (f) process.exit(1);
