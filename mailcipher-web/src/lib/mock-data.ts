import type { Chat, Message, Contact, User } from './types';

export const currentUser: User = {
	id: 'user-1',
	name: 'Alex',
	email: 'alex@whisper.vault',
	avatar: undefined,
	publicKey: 'x25519-pub...'
};

const contacts: Contact[] = [
	{
		id: 'contact-1',
		name: 'Alice Johnson',
		status: 'online'
	},
	{
		id: 'contact-2',
		name: 'Bob Smith',
		status: 'offline',
		lastSeen: new Date(Date.now() - 3600000)
	},
	{
		id: 'contact-3',
		name: 'Charlie Dev',
		status: 'typing'
	},
	{
		id: 'contact-4',
		name: 'Diana Ops',
		status: 'online'
	},
	{
		id: 'contact-5',
		name: 'Eve Security',
		status: 'offline',
		lastSeen: new Date(Date.now() - 86400000)
	}
];

function makeMessages(contactId: string): Message[] {
	const now = Date.now();
	return [
		{
			id: `${contactId}-msg-1`,
			senderId: contactId,
			content: 'Hey! How are you doing?',
			timestamp: new Date(now - 7200000),
			status: 'read',
			type: 'text',
			encrypted: true
		},
		{
			id: `${contactId}-msg-2`,
			senderId: 'user-1',
			content: 'Hi! I\'m great, thanks. Working on the new encryption protocol.',
			timestamp: new Date(now - 7000000),
			status: 'read',
			type: 'text',
			encrypted: true
		},
		{
			id: `${contactId}-msg-3`,
			senderId: contactId,
			content: 'That sounds interesting! Is it using post-quantum algorithms?',
			timestamp: new Date(now - 6800000),
			status: 'read',
			type: 'text',
			encrypted: true
		},
		{
			id: `${contactId}-msg-4`,
			senderId: 'user-1',
			content: 'Yes! ML-KEM-768 for key exchange and ML-DSA-65 for signatures. Full E2E.',
			timestamp: new Date(now - 6600000),
			status: 'delivered',
			type: 'text',
			encrypted: true
		},
		{
			id: `${contactId}-msg-5`,
			senderId: contactId,
			content: 'When can I test it?',
			timestamp: new Date(now - 3600000),
			status: 'read',
			type: 'text',
			encrypted: true
		}
	];
}

export const mockChats: Chat[] = contacts.map((contact, index) => {
	const messages = makeMessages(contact.id);
	return {
		id: `chat-${index + 1}`,
		contact,
		lastMessage: messages[messages.length - 1],
		unreadCount: contact.id === 'contact-3' ? 2 : contact.id === 'contact-1' ? 1 : 0,
		pinned: contact.id === 'contact-1',
		muted: false,
		encrypted: true
	};
});

export function getMessagesForChat(chatId: string): Message[] {
	const chatIndex = parseInt(chatId.replace('chat-', '')) - 1;
	if (chatIndex < 0 || chatIndex >= contacts.length) return [];
	return makeMessages(contacts[chatIndex].id);
}
