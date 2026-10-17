// Node-смоук features/contacts-store.js — владелец contacts/ignoredUsers (ADR-004 J.5a/J.7).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
const ROOT = '/home/maksim/whisper/vault-desktop';
const MOCKS = '/tmp/contacts-store-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });
const apiMok = 'export default { getContacts: async () => [], getEmailBody: async () => null, saveCursors: async () => {} };\n';
const orig = readFileSync(ROOT + '/src/features/contacts-load.js', 'utf8');
try {
  writeFileSync(MOCKS + '/api.js', apiMok);
  const patched = orig.replace("from '../api.js'", `from "${MOCKS}/api.js"`);
  writeFileSync(ROOT + '/src/features/contacts-load.js', patched);
  const mod = await import('../src/features/contacts-store.js');
  const createContactsStore = mod.createContactsStore;
  const contactsStore = mod.contactsStore;
  let pass = 0, fail = 0;
  const ok = (l, c, x) => { if (c) { pass++; console.log('  ' + '✓ ' + l); } else { fail++; console.log('  ' + '✗ ' + l + (x !== undefined ? ' :: ' + JSON.stringify(x) : '')); } };
  console.log('contacts-store (singleton):');
  contactsStore.reset();
  contactsStore.setIgnored({ 'a@x.ru': 1700000000000, 'b@x.ru': 1700000001000 });
  ok('setIgnored', Object.keys(contactsStore.state.ignoredUsers).length === 2);
  ok('ignoredUsers читается', contactsStore.state.ignoredUsers['a@x.ru'] === 1700000000000);
  contactsStore.clearIgnored();
  ok('clearIgnored', Object.keys(contactsStore.state.ignoredUsers).length === 0);
  contactsStore.setIgnored(null);
  ok('setIgnored(null) -> {}', Object.keys(contactsStore.state.ignoredUsers).length === 0);
  contactsStore.setLastSeen('c@x.ru', 123);
  ok('setLastSeen', contactsStore.getLastSeen('c@x.ru') === 123);
  ok('getLastSeen отсутствующего = 0', contactsStore.getLastSeen('nobody@x.ru') === 0);
  contactsStore.reset();
  ok('reset чистит ignoredUsers', Object.keys(contactsStore.state.ignoredUsers).length === 0);
  ok('reset чистит lastSeenMap', Object.keys(contactsStore.state.lastSeenMap).length === 0);
  console.log('\ncontacts-store (фабрика createContactsStore):');
  const s = createContactsStore();
  s.setIgnored({ 'f@x.ru': 1 });
  ok('фабрика пишет через тот же API', s.state.ignoredUsers['f@x.ru'] === 1);
  s.clearIgnored();
  ok('фабрика чистит за собой', Object.keys(s.state.ignoredUsers).length === 0);
  console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
} finally {
  writeFileSync(ROOT + '/src/features/contacts-load.js', orig);
}
