// Smoke: features/chat.js — чистые chatKey/dedup helper (ADR-001).
import { resolveChatKey, isRecentDuplicate } from '../src/features/chat.js';

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

console.log('\nИТОГО: ' + p + ' pass, ' + f + ' fail');
if (f) process.exit(1);
