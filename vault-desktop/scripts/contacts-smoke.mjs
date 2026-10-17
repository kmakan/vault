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

console.log('=== ИТОГО: '+p+' pass, '+f+' fail ==='); if (f) process.exit(1);
