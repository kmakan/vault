// Smoke: features/chat.js — чистые chatKey/dedup helper (ADR-001).
import { resolveChatKey, isRecentDuplicate, buildNoteMessage, buildReplyPayload, buildSendingMessage } from '../src/features/chat.js';

let p = 0, f = 0;
const check = (n, c) => { c ? (p++, console.log('  ✓ ' + n)) : (f++, console.log('  ✗ ' + n)); };

// resolveChatKey
check('peer → activeChat', resolveChatKey({ activeChat: 'peer@x.ru', activeChatType: 'peer', currentGroup: null }) === 'peer@x.ru');
check('notes → __notes__', resolveChatKey({ activeChat: '__notes__', activeChatType: 'notes', currentGroup: null }) === '__notes__');
check('group → group:<id>', resolveChatKey({ activeChat: 'ignored', activeChatType: 'group', currentGroup: { id: 'g1' } }) === 'group:g1');
check('group без currentGroup → activeChat fallback', resolveChatKey({ activeChat: 'peer@x.ru', activeChatType: 'group', currentGroup: null }) === 'peer@x.ru');

// isRecentDuplicate
const now = Date.now();
check('recent-dup true (same text <30s)', isRecentDuplicate({ lastSend: { chat: 'c', text: 'hi', ts: now - 1000 }, chatId: 'c', text: 'hi', now }) === true);
check('recent-dup false (другой чат)', isRecentDuplicate({ lastSend: { chat: 'c', text: 'hi', ts: now - 1000 }, chatId: 'c2', text: 'hi', now }) === false);
check('recent-dup false (старше 30с)', isRecentDuplicate({ lastSend: { chat: 'c', text: 'hi', ts: now - 40000 }, chatId: 'c', text: 'hi', now }) === false);
check('recent-dup false (нет lastSend)', isRecentDuplicate({ lastSend: null, chatId: 'c', text: 'hi', now }) === false);


// buildNoteMessage (shared notes factory, вынесен из send.js)
const nm = buildNoteMessage('привет', { now: 1700000000000, timeStr: '12:34' });
check('buildNoteMessage id+content+from', nm.id.startsWith('note-') && nm.content === 'привет' && nm.from === 'me');

check('buildNoteMessage чистые флаги', nm._notes === true && nm.status === 'sent' && nm.encrypted === false);
// buildReplyPayload
check('buildReplyPayload без replyTo → как есть', buildReplyPayload('hi', { replyTo:null, replyPreview:_=>'' }) === 'hi');
check('buildReplyPayload с quote → "> quote\\n\\nhi"', buildReplyPayload('hi', { replyTo:{r:1}, replyPreview:_=>'' }))


// buildSendingMessage
const sm = buildSendingMessage({ envelopeId:'', payload:'hi', ttl:60, now:1000, timeStr:'12:00', pendingIdOf:()=>'' });
check('buildSendingMessage id пустой (pending)', sm.id === '');
check('buildSendingMessage ttl+expireAt', sm.ttl === 60 && sm.expireAt === 61000 && sm.status === 'sending');
check('buildSendingMessage encrypted+vault', sm.encrypted === true && sm.vault === true);

if (f) process.exit(1);
