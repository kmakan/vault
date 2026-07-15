<script lang="ts">
	import { currentUser } from '$lib/mock-data';

	interface Props {
		collapsed?: boolean;
		onToggle?: () => void;
	}

	let { collapsed = false, onToggle }: Props = $props();

	let menuItems = [
		{ icon: '💬', label: 'Chats', active: true },
		{ icon: '👥', label: 'Contacts', active: false },
		{ icon: '📁', label: 'Files', active: false },
		{ icon: '⚙️', label: 'Settings', active: false }
	];
</script>

<aside class="sidebar" class:collapsed>
	<div class="sidebar-header">
		<div class="logo">
			<span class="logo-icon">🔐</span>
			{#if !collapsed}
				<span class="logo-text">Whisper</span>
			{/if}
		</div>
		<button class="toggle-btn" onclick={onToggle} title={collapsed ? 'Expand' : 'Collapse'}>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				{#if collapsed}
					<path d="M9 18l6-6-6-6"/>
				{:else}
					<path d="M15 18l-6-6 6-6"/>
				{/if}
			</svg>
		</button>
	</div>

	<nav class="nav">
		{#each menuItems as item}
			<button class="nav-item" class:active={item.active} title={collapsed ? item.label : ''}>
				<span class="nav-icon">{item.icon}</span>
				{#if !collapsed}
					<span class="nav-label">{item.label}</span>
				{/if}
			</button>
		{/each}
	</nav>

	<div class="sidebar-footer">
		<div class="user-info">
			<div class="user-avatar">
				{currentUser.name[0]}
			</div>
			{#if !collapsed}
				<div class="user-details">
					<span class="user-name">{currentUser.name}</span>
					<span class="user-key">{currentUser.publicKey}</span>
				</div>
			{/if}
		</div>
	</div>
</aside>

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		width: 240px;
		height: 100%;
		background: var(--bg-primary);
		border-right: 1px solid var(--border-color);
		transition: width 0.2s ease;
		flex-shrink: 0;
	}

	.sidebar.collapsed {
		width: 60px;
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px;
		border-bottom: 1px solid var(--border-color);
		min-height: 56px;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.logo-icon {
		font-size: 24px;
	}

	.logo-text {
		font-size: 18px;
		font-weight: 700;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.toggle-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: background-color 0.15s;
	}

	.toggle-btn:hover {
		background: var(--bg-hover);
	}

	.nav {
		flex: 1;
		padding: 8px;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 12px;
		border: none;
		background: transparent;
		color: var(--text-secondary);
		border-radius: var(--radius-md);
		cursor: pointer;
		transition: background-color 0.15s, color 0.15s;
		width: 100%;
		text-align: left;
	}

	.nav-item:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.nav-item.active {
		background: var(--bg-active);
		color: var(--text-primary);
	}

	.nav-icon {
		font-size: 18px;
		width: 24px;
		text-align: center;
		flex-shrink: 0;
	}

	.nav-label {
		font-size: 14px;
		font-weight: 500;
		white-space: nowrap;
	}

	.sidebar-footer {
		padding: 12px;
		border-top: 1px solid var(--border-color);
	}

	.user-info {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.user-avatar {
		width: 36px;
		height: 36px;
		border-radius: var(--radius-full);
		background: var(--accent);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 14px;
		font-weight: 600;
		color: white;
		flex-shrink: 0;
	}

	.user-details {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.user-name {
		font-size: 13px;
		font-weight: 500;
		color: var(--text-primary);
	}

	.user-key {
		font-size: 11px;
		color: var(--text-muted);
		font-family: var(--font-mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
