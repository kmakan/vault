<template>
  <div class="app-container">
    <div class="sidebar">
      <div class="sidebar-header">
        <div class="logo">
          <span class="logo-icon">🔒</span>
          <span class="logo-text">Whisper</span>
        </div>
        <div class="header-actions">
          <button @click="showKeyManager = !showKeyManager" :title="cryptoReady ? 'Keys ready' : 'Generating keys...'">
            {{ cryptoReady ? '🔑' : '⏳' }}
          </button>
          <button @click="showQRCode = !showQRCode" title="QR Code">
            📱
          </button>
          <button @click="showSettings = !showSettings">⚙️</button>
        </div>
      </div>
      
      <div class="nav-tabs">
        <button 
          :class="['nav-tab', { active: currentView === 'chats' }]"
          @click="currentView = 'chats'"
        >
          <span class="nav-icon">💬</span>
          Chats
        </button>
        <button 
          :class="['nav-tab', { active: currentView === 'email' }]"
          @click="currentView = 'email'"
        >
          <span class="nav-icon">📧</span>
          Email
        </button>
      </div>

      <div v-if="currentView === 'chats'" class="contacts-list">
        <div class="search-box">
          <input type="text" placeholder="Search contacts..." v-model="searchQuery" />
        </div>
        <div 
          v-for="contact in filteredContacts" 
          :key="contact.email"
          :class="['contact-item', { active: activeChat === contact.email }]"
          @click="selectChat(contact.email)"
        >
          <div class="contact-avatar">
            <span class="avatar-initial">{{ contact.name.charAt(0).toUpperCase() }}</span>
          </div>
          <div class="contact-info">
            <div class="contact-name">{{ contact.name }}</div>
            <div class="contact-email">{{ contact.email }}</div>
          </div>
          <div class="contact-status">
            <span class="status-dot" :class="{ online: contact.online }"></span>
          </div>
        </div>
      </div>

      <div v-else class="email-list">
        <EmailInbox 
          :emails="emails" 
          :loading="emailsLoading"
          @open-email="openEmail"
        />
      </div>
    </div>
    
    <div class="main-area">
      <div v-if="showKeyManager" class="key-manager">
        <KeyManager @close="showKeyManager = false" @keys-changed="onKeysChanged" />
      </div>
    
      <div v-if="showQRCode" class="qr-code-overlay">
        <QRCodePanel 
          :publicKey="publicKey" 
          @close="showQRCode = false"
          @key-scanned="addPeerKey"
        />
      </div>

      <div v-if="showSettings" class="settings-panel">
        <EmailSettings />
      </div>
      
      <div v-else-if="currentView === 'chats'" class="chat-area">
        <div class="chat-header" v-if="activeChat">
          <div class="chat-header-info">
            <div class="chat-avatar">
              <span class="avatar-initial">{{ activeChat.charAt(0).toUpperCase() }}</span>
            </div>
            <div>
              <h3>{{ activeChat }}</h3>
              <div class="chat-status">{{ peerKeys[activeChat] ? '🔒 Encrypted' : '⚠️ No key' }}</div>
            </div>
          </div>
          <div class="chat-actions">
            <button @click="showMembers = !showMembers" title="Members">👥</button>
            <button @click="searchMessages" title="Search">🔍</button>
          </div>
        </div>
        
        <div class="messages" ref="messagesContainer">
          <div 
            v-for="msg in messages" 
            :key="msg.id"
            :class="['message', { own: msg.from === 'me' }]"
          >
            <div class="message-content">
              {{ msg.content }}
              <span v-if="msg.encrypted" class="encrypted-badge" title="End-to-end encrypted">🔒</span>
            </div>
            <div class="message-time">{{ msg.time }}</div>
          </div>
        </div>
        
        <div class="message-input" v-if="activeChat">
          <button class="attach-btn" title="Attach file">📎</button>
          <input 
            v-model="newMessage" 
            @keyup.enter="sendMessage"
            placeholder="Type a message..."
          />
          <button class="send-btn" @click="sendMessage">
            <span class="send-icon">➤</span>
          </button>
        </div>
      </div>

      <div v-else class="email-view">
        <div v-if="selectedEmail" class="email-detail">
          <div class="email-detail-header">
            <button @click="selectedEmail = null" class="back-btn">← Back</button>
            <h3>{{ selectedEmail.subject || '(no subject)' }}</h3>
          </div>
          <div class="email-detail-meta">
            <div>From: {{ selectedEmail.from }}</div>
            <div>Date: {{ selectedEmail.date }}</div>
          </div>
          <div class="email-detail-body">
            {{ selectedEmail.body || 'Loading...' }}
          </div>
        </div>
        <div v-else class="empty-state">
          <div class="empty-icon">📬</div>
          <div class="empty-text">Select an email to view</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import api from './api.js';
import crypto from './crypto.js';
import EmailSettings from './components/EmailSettings.vue';
import EmailInbox from './components/EmailInbox.vue';
import KeyManager from './components/KeyManager.vue';

export default {
  name: 'ChatApp',
  components: {
    EmailSettings,
    EmailInbox,
    KeyManager
  },
  data() {
    return {
      currentView: 'chats',
      contacts: [],
      activeChat: null,
      messages: [],
      newMessage: '',
      showSettings: false,
      showMembers: false,
      isLoggedIn: false,
      email: '',
      password: '',
      emails: [],
      emailsLoading: false,
      selectedEmail: null,
      cryptoReady: false,
      publicKey: null,
      fingerprint: null,
      peerKeys: {},
      peerKeyInput: '',
      showKeyManager: false,
      showQRCode: false,
      peerKeysLoaded: {},
      searchQuery: ''
    }
  },
  computed: {
    filteredContacts() {
      if (!this.searchQuery) return this.contacts;
      const q = this.searchQuery.toLowerCase();
      return this.contacts.filter(c => 
        c.name.toLowerCase().includes(q) || 
        c.email.toLowerCase().includes(q)
      );
    }
  },
  async mounted() {
    await this.initCrypto();
  },
  methods: {
    async initCrypto() {
      try {
        const result = await crypto.initFromStorage();
        if (result.loaded) {
          this.publicKey = result.keypair.public_key;
        } else {
          const keypair = await crypto.generateKeypair();
          this.publicKey = keypair.public_key;
          await crypto.saveToStorage();
        }
        this.fingerprint = await crypto.fingerprint();
        this.cryptoReady = true;
        await this.loadStoredPeerKeys();
      } catch (error) {
        console.error('Crypto init failed:', error);
      }
    },
    async loadStoredPeerKeys() {
      try {
        const stored = await crypto.loadPeerKeys();
        for (const pk of stored) {
          this.peerKeys[pk.email] = pk.public_key;
          this.peerKeysLoaded[pk.email] = true;
        }
      } catch (error) {
        console.error('Failed to load peer keys:', error);
      }
    },
    async login() {
      try {
        await api.login(this.email, this.password);
        this.isLoggedIn = true;
        await this.loadContacts();
        await this.loadEmails();
      } catch (error) {
        alert('Login failed: ' + error.message);
      }
    },
    async loadContacts() {
      try {
        this.contacts = await api.getContacts();
      } catch (error) {
        console.error('Failed to load contacts:', error);
      }
    },
    setPeerKey(email, key) {
      this.peerKeys[email] = key;
      crypto.setPeerPublicKey(key);
      crypto.savePeerKey(email, key, null).catch(err => {
        console.error('Failed to save peer key:', err);
      });
    },
    setPeerKeyFromInput() {
      if (!this.peerKeyInput || !this.activeChat) return;
      this.setPeerKey(this.activeChat, this.peerKeyInput);
      this.peerKeyInput = '';
    },
    async selectChat(email) {
      this.activeChat = email;
      if (this.peerKeys[email]) {
        crypto.setPeerPublicKey(this.peerKeys[email]);
      }
      await this.loadMessages(email);
    },
    async loadMessages(email) {
      try {
        const raw = await api.getMessages(email);
        if (this.cryptoReady && this.peerKeys[email]) {
          crypto.setPeerPublicKey(this.peerKeys[email]);
          this.messages = await Promise.all(
            raw.map(async (msg) => {
              if (crypto.isEncrypted(msg.content)) {
                try {
                  const decrypted = await crypto.decrypt(msg.content);
                  return { ...msg, content: decrypted, encrypted: true };
                } catch {
                  return { ...msg, encrypted: false };
                }
              }
              return { ...msg, encrypted: false };
            })
          );
        } else {
          this.messages = raw;
        }
      } catch (error) {
        console.error('Failed to load messages:', error);
        this.messages = [];
      }
    },
    async sendMessage() {
      if (!this.newMessage.trim()) return;
      
      try {
        let content = this.newMessage;
        if (this.cryptoReady && this.peerKeys[this.activeChat]) {
          crypto.setPeerPublicKey(this.peerKeys[this.activeChat]);
          content = await crypto.encrypt(this.newMessage);
        }

        await api.sendMessage(this.activeChat, content);
        this.messages.push({
          id: Date.now(),
          from: 'me',
          content: this.newMessage,
          time: new Date().toLocaleTimeString(),
          encrypted: this.cryptoReady && !!this.peerKeys[this.activeChat]
        });
        
        this.newMessage = '';
        this.$nextTick(() => {
          this.$refs.messagesContainer.scrollTop = this.$refs.messagesContainer.scrollHeight;
        });
      } catch (error) {
        alert('Failed to send message: ' + error.message);
      }
    },
    searchMessages() {
      alert('Search coming soon!');
    },
    async onKeysChanged() {
      if (this.cryptoReady) {
        this.fingerprint = await crypto.fingerprint();
      }
      await this.loadStoredPeerKeys();
    },
    async addPeerKey(publicKeyHex) {
      try {
        if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
          alert('Invalid public key format');
          return;
        }
        
        this.peerKeys[publicKeyHex] = {
          added: new Date().toISOString(),
          source: 'qr-code'
        };
        
        await crypto.savePeerKeys(this.peerKeys);
        alert('Public key added successfully!');
        this.showQRCode = false;
        
      } catch (error) {
        alert('Failed to add peer key: ' + error.message);
      }
    },
    async loadEmails() {
      this.emailsLoading = true;
      try {
        const accounts = await api.getEmailAccounts();
        this.emails = [];
        for (const account of accounts) {
          // Future: fetch emails per account
        }
      } catch (error) {
        console.error('Failed to load emails:', error);
      } finally {
        this.emailsLoading = false;
      }
    },
    openEmail(email) {
      this.selectedEmail = email;
    }
  }
}
</script>

<style>
/* ═══════════════════════════════════════════════════════════════
   Whisper — Professional Design System
   ═══════════════════════════════════════════════════════════════ */

:root {
  /* Primary palette */
  --bg-primary: #0a0a1a;
  --bg-secondary: #12122a;
  --bg-tertiary: #1a1a3e;
  --bg-hover: #1e1e4a;
  --bg-active: #252560;
  
  /* Accent colors */
  --accent-primary: #6366f1;
  --accent-secondary: #818cf8;
  --accent-glow: rgba(99, 102, 241, 0.3);
  
  /* Text colors */
  --text-primary: #f1f5f9;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  
  /* Status colors */
  --status-online: #22c55e;
  --status-encrypted: #6366f1;
  --status-warning: #f59e0b;
  
  /* Borders */
  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-hover: rgba(255, 255, 255, 0.1);
  
  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.5);
  
  /* Transitions */
  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
  
  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  
  /* Spacing */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-full: 9999px;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  background: var(--bg-primary);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}

.app-container {
  display: flex;
  height: 100vh;
  overflow: hidden;
}

/* ═══════════════════════════════════════════════════════════════
   Sidebar
   ═══════════════════════════════════════════════════════════════ */

.sidebar {
  width: 320px;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo-icon {
  font-size: 24px;
}

.logo-text {
  font-size: 20px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.header-actions {
  display: flex;
  gap: 4px;
}

.header-actions button {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 18px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.header-actions button:hover {
  background: var(--bg-hover);
}

/* ═══════════════════════════════════════════════════════════════
   Navigation Tabs
   ═══════════════════════════════════════════════════════════════ */

.nav-tabs {
  display: flex;
  padding: 8px;
  gap: 4px;
  border-bottom: 1px solid var(--border-subtle);
}

.nav-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 16px;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.nav-tab:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-tab.active {
  background: var(--accent-primary);
  color: white;
}

.nav-icon {
  font-size: 14px;
}

/* ═══════════════════════════════════════════════════════════════
   Search Box
   ═══════════════════════════════════════════════════════════════ */

.search-box {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.search-box input {
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: all var(--transition-fast);
}

.search-box input::placeholder {
  color: var(--text-muted);
}

.search-box input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

/* ═══════════════════════════════════════════════════════════════
   Contacts List
   ═══════════════════════════════════════════════════════════════ */

.contacts-list {
  flex: 1;
  overflow-y: auto;
}

.contact-item {
  display: flex;
  align-items: center;
  padding: 14px 20px;
  cursor: pointer;
  transition: all var(--transition-fast);
  border-left: 3px solid transparent;
}

.contact-item:hover {
  background: var(--bg-hover);
}

.contact-item.active {
  background: var(--bg-active);
  border-left-color: var(--accent-primary);
}

.contact-avatar {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 14px;
  flex-shrink: 0;
}

.avatar-initial {
  font-size: 18px;
  font-weight: 600;
  color: white;
}

.contact-info {
  flex: 1;
  min-width: 0;
}

.contact-name {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.contact-email {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.contact-status {
  margin-left: 12px;
}

.status-dot {
  display: block;
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  background: var(--text-muted);
}

.status-dot.online {
  background: var(--status-online);
  box-shadow: 0 0 8px var(--status-online);
}

/* ═══════════════════════════════════════════════════════════════
   Main Chat Area
   ═══════════════════════════════════════════════════════════════ */

.main-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
}

.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.chat-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-secondary);
}

.chat-header-info {
  display: flex;
  align-items: center;
  gap: 14px;
}

.chat-avatar {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  display: flex;
  align-items: center;
  justify-content: center;
}

.chat-header-info h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 2px;
}

.chat-status {
  font-size: 12px;
  color: var(--text-muted);
}

.chat-actions {
  display: flex;
  gap: 4px;
}

.chat-actions button {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 18px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast);
}

.chat-actions button:hover {
  background: var(--bg-hover);
}

/* ═══════════════════════════════════════════════════════════════
   Messages
   ═══════════════════════════════════════════════════════════════ */

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.message {
  max-width: 70%;
  animation: messageIn 0.2s ease;
}

@keyframes messageIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message.own {
  margin-left: auto;
}

.message-content {
  background: var(--bg-tertiary);
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  border-bottom-left-radius: 4px;
  color: var(--text-primary);
  line-height: 1.5;
  box-shadow: var(--shadow-sm);
}

.message.own .message-content {
  background: linear-gradient(135deg, var(--accent-primary), #4f46e5);
  border-bottom-left-radius: var(--radius-lg);
  border-bottom-right-radius: 4px;
}

.encrypted-badge {
  margin-left: 6px;
  font-size: 12px;
}

.message-time {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  text-align: right;
}

/* ═══════════════════════════════════════════════════════════════
   Message Input
   ═══════════════════════════════════════════════════════════════ */

.message-input {
  padding: 16px 24px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--bg-secondary);
}

.attach-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 20px;
  padding: 8px;
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);
}

.attach-btn:hover {
  background: var(--bg-hover);
}

.message-input input {
  flex: 1;
  padding: 12px 18px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: all var(--transition-fast);
}

.message-input input::placeholder {
  color: var(--text-muted);
}

.message-input input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px var(--accent-glow);
}

.send-btn {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-full);
  background: linear-gradient(135deg, var(--accent-primary), #4f46e5);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--transition-fast);
  box-shadow: var(--shadow-md);
}

.send-btn:hover {
  transform: scale(1.05);
  box-shadow: 0 0 20px var(--accent-glow);
}

.send-icon {
  font-size: 18px;
  color: white;
}

/* ═══════════════════════════════════════════════════════════════
   Empty State
   ═══════════════════════════════════════════════════════════════ */

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 64px;
  margin-bottom: 16px;
  opacity: 0.5;
}

.empty-text {
  font-size: 16px;
}

/* ═══════════════════════════════════════════════════════════════
   Key Manager
   ═══════════════════════════════════════════════════════════════ */

.key-manager {
  padding: 24px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-subtle);
}

.key-manager h3 {
  margin: 0 0 20px 0;
  font-size: 18px;
  font-weight: 600;
}

/* ═══════════════════════════════════════════════════════════════
   Email View
   ═══════════════════════════════════════════════════════════════ */

.email-view {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.email-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px;
}

.email-detail-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.back-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-subtle);
  padding: 8px 16px;
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.back-btn:hover {
  background: var(--bg-hover);
}

.email-detail-header h3 {
  font-size: 20px;
  font-weight: 600;
}

.email-detail-meta {
  display: flex;
  gap: 24px;
  color: var(--text-secondary);
  font-size: 14px;
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.email-detail-body {
  flex: 1;
  line-height: 1.7;
  color: var(--text-primary);
}

/* ═══════════════════════════════════════════════════════════════
   Scrollbar Styling
   ═══════════════════════════════════════════════════════════════ */

::-webkit-scrollbar {
  width: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
}

::-webkit-scrollbar-thumb:hover {
  background: var(--text-muted);
}

/* ═══════════════════════════════════════════════════════════════
   Responsive (for future use)
   ═══════════════════════════════════════════════════════════════ */

@media (max-width: 768px) {
  .sidebar {
    width: 100%;
  }
  
  .main-area {
    display: none;
  }
}
</style>
