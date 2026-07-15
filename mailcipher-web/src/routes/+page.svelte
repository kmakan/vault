<script lang="ts">
	import Sidebar from '$lib/components/Sidebar.svelte';
	import ChatList from '$lib/components/ChatList.svelte';
	import ChatWindow from '$lib/components/ChatWindow.svelte';
	import { mockChats } from '$lib/mock-data';
	import type { Chat } from '$lib/types';

	let selectedChatId = $state<string | undefined>();
	let sidebarCollapsed = $state(false);

	let selectedChat: Chat | undefined = $derived(
		selectedChatId ? mockChats.find((c) => c.id === selectedChatId) : undefined
	);

	function handleChatSelect(chatId: string) {
		selectedChatId = chatId;
	}
</script>

<svelte:head>
	<title>Whisper/Vault — Secure Messenger</title>
	<meta name="description" content="E2E encrypted messenger powered by post-quantum cryptography" />
</svelte:head>

<div class="app">
	<Sidebar collapsed={sidebarCollapsed} onToggle={() => (sidebarCollapsed = !sidebarCollapsed)} />

	<ChatList
		chats={mockChats}
		bind:selectedChatId
		onSelect={handleChatSelect}
	/>

	<main class="main">
		<ChatWindow chat={selectedChat} />
	</main>
</div>

<style>
	.app {
		display: flex;
		height: 100vh;
		overflow: hidden;
		background: var(--bg-chat);
	}

	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
</style>
