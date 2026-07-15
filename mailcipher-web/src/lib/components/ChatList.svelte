<script lang="ts">
	import type { Chat } from '$lib/types';

	interface Props {
		chats: Chat[];
		selectedChatId?: string;
		onSelect?: (chatId: string) => void;
	}

	let { chats, selectedChatId = $bindable(), onSelect }: Props = $props();

	function formatTime(date?: Date): string {
		if (!date) return '';
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const days = Math.floor(diff / 86400000);
		if (days === 0) {
			return date.toLocaleTimeString('en-US', {
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			});
		} else if (days === 1) {
			return 'Yesterday';
		} else if (days < 7) {
			return date.toLocaleDateString('en-US', { weekday: 'short' });
		}
		return date.toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric'
		});
	}

	function getInitials(name: string): string {
		return name
			.split(' ')
			.map((n) => n[0])
			.join('')
			.toUpperCase()
			.slice(0, 2);
	}

	const avatarColors = [
		'#e17076', '#7bc862', '#e5ca77', '#65aadd',
		'#a695e7', '#ee7aae', '#6ec9cb', '#faa774'
	];

	function getAvatarColor(name: string): string {
		let hash = 0;
		for (let i = 0; i < name.length; i++) {
			hash = name.charCodeAt(i) + ((hash << 5) - hash);
		}
		return avatarColors[Math.abs(hash) % avatarColors.length];
	}

	let sortedChats = $derived(
		[...chats].sort((a, b) => {
			if (a.pinned && !b.pinned) return -1;
			if (!a.pinned && b.pinned) return 1;
			const aTime = a.lastMessage?.timestamp?.getTime() ?? 0;
			const bTime = b.lastMessage?.timestamp?.getTime() ?? 0;
			return bTime - aTime;
		})
	);
</script>

<div class="chat-list">
	<div class="search-bar">
		<svg class="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<circle cx="11" cy="11" r="8"/>
			<path d="m21 21-4.3-4.3"/>
		</svg>
		<input type="text" placeholder="Search..." class="search-input" />
	</div>

	<div class="chats">
		{#each sortedChats as chat (chat.id)}
			<button
				class="chat-item"
				class:selected={selectedChatId === chat.id}
				onclick={() => {
					selectedChatId = chat.id;
					onSelect?.(chat.id);
				}}
			>
				<div class="avatar" style="background-color: {getAvatarColor(chat.contact.name)}">
					{getInitials(chat.contact.name)}
					{#if chat.contact.status === 'online'}
						<div class="online-dot"></div>
					{/if}
				</div>

				<div class="chat-info">
					<div class="chat-header">
						<span class="chat-name">
							{#if chat.encrypted}🔒{/if}
							{chat.contact.name}
						</span>
						<span class="chat-time">
							{formatTime(chat.lastMessage?.timestamp)}
						</span>
					</div>
					<div class="chat-preview">
						{#if chat.contact.status === 'typing'}
							<span class="typing">typing...</span>
						{:else if chat.lastMessage}
							<span class="last-message">{chat.lastMessage.content}</span>
						{:else}
							<span class="no-messages">No messages yet</span>
						{/if}
						{#if chat.unreadCount > 0}
							<span class="badge" class:muted={chat.muted}>{chat.unreadCount}</span>
						{/if}
					</div>
				</div>
			</button>
		{/each}
	</div>
</div>

<style>
	.chat-list {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-sidebar);
		border-right: 1px solid var(--border-color);
	}

	.search-bar {
		display: flex;
		align-items: center;
		padding: 8px 12px;
		gap: 8px;
		border-bottom: 1px solid var(--border-color);
	}

	.search-icon {
		color: var(--text-muted);
		flex-shrink: 0;
	}

	.search-input {
		flex: 1;
		background: var(--bg-input);
		border: none;
		border-radius: var(--radius-md);
		padding: 8px 12px;
		color: var(--text-primary);
		font-size: 14px;
		outline: none;
	}

	.search-input::placeholder {
		color: var(--text-muted);
	}

	.chats {
		flex: 1;
		overflow-y: auto;
	}

	.chat-item {
		display: flex;
		align-items: center;
		padding: 8px 12px;
		gap: 12px;
		cursor: pointer;
		border: none;
		background: transparent;
		color: var(--text-primary);
		text-align: left;
		width: 100%;
		transition: background-color 0.15s;
	}

	.chat-item:hover {
		background: var(--bg-hover);
	}

	.chat-item.selected {
		background: var(--bg-active);
	}

	.avatar {
		position: relative;
		width: 48px;
		height: 48px;
		border-radius: var(--radius-full);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 16px;
		font-weight: 600;
		color: white;
		flex-shrink: 0;
	}

	.online-dot {
		position: absolute;
		bottom: 1px;
		right: 1px;
		width: 12px;
		height: 12px;
		background: var(--accent-green);
		border-radius: 50%;
		border: 2px solid var(--bg-sidebar);
	}

	.chat-info {
		flex: 1;
		min-width: 0;
	}

	.chat-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 4px;
	}

	.chat-name {
		font-size: 14.5px;
		font-weight: 500;
		color: var(--text-primary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chat-time {
		font-size: 12px;
		color: var(--text-muted);
		flex-shrink: 0;
		margin-left: 8px;
	}

	.chat-preview {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.last-message {
		font-size: 13.5px;
		color: var(--text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		flex: 1;
	}

	.typing {
		font-size: 13.5px;
		color: var(--accent);
		font-style: italic;
	}

	.no-messages {
		font-size: 13.5px;
		color: var(--text-muted);
		font-style: italic;
	}

	.badge {
		background: var(--accent);
		color: white;
		font-size: 12px;
		font-weight: 600;
		min-width: 22px;
		height: 22px;
		border-radius: 11px;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 6px;
		flex-shrink: 0;
	}

	.badge.muted {
		background: var(--text-muted);
	}
</style>
