<script lang="ts">
	import type { Chat, Message } from '$lib/types';
	import MessageBubble from './MessageBubble.svelte';
	import { getMessagesForChat } from '$lib/mock-data';

	interface Props {
		chat?: Chat;
	}

	let { chat }: Props = $props();

	let messages: Message[] = $derived(chat ? getMessagesForChat(chat.id) : []);
	let inputText = $state('');

	function getInitials(name: string): string {
		return name
			.split(' ')
			.map((n) => n[0])
			.join('')
			.toUpperCase()
			.slice(0, 2);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	}

	function sendMessage() {
		if (!inputText.trim()) return;
		// Mock send - just clear input
		inputText = '';
	}
</script>

{#if chat}
	<div class="chat-window">
		<!-- Header -->
		<div class="header">
			<div class="header-info">
				<div class="header-avatar">
					{getInitials(chat.contact.name)}
					{#if chat.contact.status === 'online'}
						<div class="online-dot"></div>
					{/if}
				</div>
				<div class="header-text">
					<h2 class="header-name">{chat.contact.name}</h2>
					<span class="header-status">
						{#if chat.contact.status === 'online'}
							Online
						{:else if chat.contact.status === 'typing'}
							<span class="typing-text">typing...</span>
						{:else if chat.contact.lastSeen}
							Last seen {chat.contact.lastSeen.toLocaleString()}
						{:else}
							Offline
						{/if}
					</span>
				</div>
			</div>

			<div class="header-actions">
				<button class="icon-btn" title="Search">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="11" cy="11" r="8"/>
						<path d="m21 21-4.3-4.3"/>
					</svg>
				</button>
				<button class="icon-btn" title="Call">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
					</svg>
				</button>
				<button class="icon-btn" title="More">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>
					</svg>
				</button>
			</div>
		</div>

		<!-- Encryption Banner -->
		<div class="encryption-banner">
			🔒 Messages are end-to-end encrypted. No one outside of this chat can read them.
		</div>

		<!-- Messages -->
		<div class="messages">
			{#each messages as message (message.id)}
				<MessageBubble {message} />
			{/each}
		</div>

		<!-- Input -->
		<div class="input-area">
			<button class="icon-btn attach-btn" title="Attach file">
				<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
				</svg>
			</button>

			<div class="input-wrapper">
				<textarea
					class="message-input"
					placeholder="Write a message..."
					bind:value={inputText}
					onkeydown={handleKeydown}
					rows="1"
				></textarea>
			</div>

			{#if inputText.trim()}
				<button class="send-btn" onclick={sendMessage} title="Send">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
						<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
					</svg>
				</button>
			{:else}
				<button class="icon-btn" title="Voice message">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
						<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
						<line x1="12" y1="19" x2="12" y2="23"/>
						<line x1="8" y1="23" x2="16" y2="23"/>
					</svg>
				</button>
			{/if}
		</div>
	</div>
{:else}
	<div class="empty-state">
		<div class="empty-icon">
			<svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
			</svg>
		</div>
		<h3>Whisper/Vault</h3>
		<p>Select a chat to start messaging</p>
		<span class="encryption-note">🔒 All messages are end-to-end encrypted</span>
	</div>
{/if}

<style>
	.chat-window {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--bg-chat);
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 16px;
		background: var(--bg-primary);
		border-bottom: 1px solid var(--border-color);
		min-height: 56px;
	}

	.header-info {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.header-avatar {
		position: relative;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-full);
		background: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 14px;
		font-weight: 600;
		color: white;
	}

	.online-dot {
		position: absolute;
		bottom: 0;
		right: 0;
		width: 10px;
		height: 10px;
		background: var(--accent-green);
		border-radius: 50%;
		border: 2px solid var(--bg-primary);
	}

	.header-text {
		display: flex;
		flex-direction: column;
	}

	.header-name {
		font-size: 15px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.header-status {
		font-size: 13px;
		color: var(--text-secondary);
	}

	.typing-text {
		color: var(--accent);
	}

	.header-actions {
		display: flex;
		gap: 4px;
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		border-radius: var(--radius-full);
		cursor: pointer;
		transition: background-color 0.15s, color 0.15s;
	}

	.icon-btn:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.encryption-banner {
		text-align: center;
		padding: 6px 16px;
		font-size: 12px;
		color: var(--text-muted);
		background: rgba(106, 178, 242, 0.08);
		border-bottom: 1px solid var(--border-color);
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		padding: 8px 0;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
	}

	.input-area {
		display: flex;
		align-items: flex-end;
		padding: 8px 12px;
		gap: 8px;
		background: var(--bg-primary);
		border-top: 1px solid var(--border-color);
	}

	.attach-btn {
		margin-bottom: 4px;
	}

	.input-wrapper {
		flex: 1;
		background: var(--bg-input);
		border-radius: var(--radius-lg);
		padding: 0;
		display: flex;
		align-items: center;
	}

	.message-input {
		width: 100%;
		background: transparent;
		border: none;
		color: var(--text-primary);
		font-size: 14.5px;
		padding: 10px 14px;
		outline: none;
		resize: none;
		font-family: var(--font-sans);
		line-height: 1.4;
		max-height: 150px;
	}

	.message-input::placeholder {
		color: var(--text-muted);
	}

	.send-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: none;
		background: var(--accent);
		color: white;
		border-radius: var(--radius-full);
		cursor: pointer;
		transition: background-color 0.15s;
		flex-shrink: 0;
		margin-bottom: 2px;
	}

	.send-btn:hover {
		background: var(--accent-hover);
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--text-secondary);
		gap: 8px;
	}

	.empty-state h3 {
		font-size: 24px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.empty-state p {
		font-size: 15px;
		margin: 0;
	}

	.encryption-note {
		font-size: 13px;
		color: var(--text-muted);
		margin-top: 8px;
	}
</style>
