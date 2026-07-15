export interface Contact {
	id: string;
	name: string;
	avatar?: string;
	status: 'online' | 'offline' | 'typing';
	lastSeen?: Date;
}

export interface Message {
	id: string;
	senderId: string;
	content: string;
	timestamp: Date;
	status: 'sent' | 'delivered' | 'read';
	type: 'text' | 'image' | 'file';
	encrypted: boolean;
}

export interface Chat {
	id: string;
	contact: Contact;
	lastMessage?: Message;
	unreadCount: number;
	pinned: boolean;
	muted: boolean;
	encrypted: boolean;
}

export interface User {
	id: string;
	name: string;
	email: string;
	avatar?: string;
	publicKey?: string;
}
