<script lang="ts">
	import type { Message } from '$lib/types';
	import { currentUser } from '$lib/mock-data';

	interface Props {
		message: Message;
	}

	let { message }: Props = $props();

	let isOwn = $derived(message.senderId === currentUser.id);

	function formatTime(date: Date): string {
		return date.toLocaleTimeString('en-US', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		});
	}

	function getStatusIcon(status: string): string {
		switch (status) {
			case 'sent': return '✓';
			case 'delivered': return '✓✓';
			case 'read': return '✓✓';
			default: return '✓';
		}
	}
</script>

<div class="message" class:own={isOwn} class:incoming={!isOwn}>
	<div class="bubble">
		<p class="content">{message.content}</p>
		<div class="meta">
			<span class="time">{formatTime(message.timestamp)}</span>
			{#if isOwn}
				<span class="status" class:read={message.status === 'read'}>
					{getStatusIcon(message.status)}
				</span>
			{/if}
			{#if message.encrypted}
				<span class="encrypted" title="End-to-end encrypted">🔒</span>
			{/if}
		</div>
	</div>
</div>

<style>
	.message {
		display: flex;
		margin: 2px 0;
		padding: 0 16px;
	}

	.message.own {
		justify-content: flex-end;
	}

	.message.incoming {
		justify-content: flex-start;
	}

	.bubble {
		max-width: 65%;
		padding: 6px 10px 4px;
		border-radius: var(--radius-lg);
		position: relative;
		word-wrap: break-word;
	}

	.own .bubble {
		background: var(--bg-message-out);
		border-bottom-right-radius: var(--radius-sm);
	}

	.incoming .bubble {
		background: var(--bg-message-in);
		border-bottom-left-radius: var(--radius-sm);
	}

	.content {
		font-size: 14.5px;
		line-height: 1.4;
		color: var(--text-primary);
		margin: 0;
	}

	.meta {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 4px;
		margin-top: 2px;
	}

	.time {
		font-size: 11px;
		color: var(--text-muted);
	}

	.status {
		font-size: 12px;
		color: var(--text-muted);
	}

	.status.read {
		color: var(--accent);
	}

	.encrypted {
		font-size: 10px;
		opacity: 0.6;
	}
</style>
