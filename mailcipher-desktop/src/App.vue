<template>
  <div class="app-container">
    <div class="sidebar">
      <div class="sidebar-header">
        <h2>Whisper</h2>
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
          Chats
        </button>
        <button 
          :class="['nav-tab', { active: currentView === 'email' }]"
          @click="currentView = 'email'"
        >
          Email
        </button>
      </div>

      <div v-if="currentView === 'chats'" class="contacts-list">
        <div 
          v-for="contact in contacts" 
          :key="contact.email"
          :class="['contact-item', { active: activeChat === contact.email }]"
          @click="selectChat(contact.email)"
        >
          <span class="status-icon">{{ contact.online ? '🟢' : '⚪' }}</span>
          <div class="contact-info">
            <div class="contact-name">{{ contact.name }}</div>
            <div class="contact-email">{{ contact.email }}</div>
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
          <h3>{{ activeChat }}</h3>
          <div class="chat-actions">
            <button @click="showMembers = !showMembers">👥</button>
            <button @click="searchMessages">🔍</button>
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
          <input 
            v-model="newMessage" 
            @keyup.enter="sendMessage"
            placeholder="Type a message..."
          />
          <button @click="sendMessage">Send</button>
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
        <div v-else class="empty-email">
          Select an email to view
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
      peerKeysLoaded: {}
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
        // Validate the key
        if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
          alert('Invalid public key format');
          return;
        }
        
        // Add to peer keys
        this.peerKeys[publicKeyHex] = {
          added: new Date().toISOString(),
          source: 'qr-code'
        };
        
        // Save to storage
        await crypto.savePeerKeys(this.peerKeys);
        
        // Show success
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
          // In a real implementation, this would call an endpoint to fetch emails
          // For now, we'll use mock data or a future endpoint
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
.chat-container {
  display: flex;
  height: 100vh;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.sidebar {
  width: 300px;
  background: #1a1a2e;
  color: white;
  border-right: 1px solid #16213e;
}

.sidebar-header {
  padding: 20px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid #16213e;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.header-actions button {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
}

.contacts-list {
  overflow-y: auto;
}

.contact-item {
  display: flex;
  align-items: center;
  padding: 15px 20px;
  cursor: pointer;
  transition: background 0.2s;
}

.contact-item:hover {
  background: #16213e;
}

.contact-item.active {
  background: #0f3460;
}

.status-icon {
  margin-right: 12px;
  font-size: 12px;
}

.contact-info {
  flex: 1;
}

.contact-name {
  font-weight: 500;
  margin-bottom: 4px;
}

.contact-email {
  font-size: 12px;
  color: #888;
}

.chat-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #0f0f23;
}

.chat-header {
  padding: 20px;
  border-bottom: 1px solid #16213e;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.chat-actions button {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  margin-left: 10px;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.message {
  margin-bottom: 16px;
  max-width: 70%;
}

.message.own {
  margin-left: auto;
}

.message-content {
  background: #16213e;
  padding: 12px 16px;
  border-radius: 18px;
  color: white;
}

.message.own .message-content {
  background: #0f3460;
}

.message-time {
  font-size: 11px;
  color: #888;
  margin-top: 4px;
  text-align: right;
}

.message-input {
  padding: 20px;
  border-top: 1px solid #16213e;
  display: flex;
  gap: 12px;
}

.message-input input {
  flex: 1;
  padding: 12px 16px;
  border-radius: 24px;
  border: none;
  background: #16213e;
  color: white;
  font-size: 14px;
}

.message-input button {
  padding: 12px 24px;
  border-radius: 24px;
  border: none;
  background: #0f3460;
  color: white;
  cursor: pointer;
  font-weight: 500;
}

.message-input button:hover {
  background: #1a5276;
}

.key-manager {
  padding: 20px;
  background: #1a1a2e;
  border-bottom: 1px solid #16213e;
  color: white;
}

.key-manager h3 {
  margin: 0 0 16px 0;
  font-size: 16px;
}

.key-status {
  margin-bottom: 16px;
}

.status-ok {
  color: #4ade80;
}

.status-waiting {
  color: #fbbf24;
}

.key-info {
  margin-bottom: 16px;
}

.key-info label {
  display: block;
  font-size: 12px;
  color: #888;
  margin-bottom: 4px;
}

.key-info .fingerprint {
  display: block;
  padding: 8px;
  background: #0f0f23;
  border-radius: 4px;
  font-family: monospace;
  font-size: 14px;
  margin-bottom: 12px;
  word-break: break-all;
}

.key-info textarea {
  width: 100%;
  padding: 8px;
  background: #0f0f23;
  border: 1px solid #16213e;
  border-radius: 4px;
  color: white;
  font-family: monospace;
  font-size: 12px;
  resize: none;
  box-sizing: border-box;
}

.peer-key-section {
  margin-bottom: 16px;
}

.peer-key-section label {
  display: block;
  font-size: 12px;
  color: #888;
  margin-bottom: 4px;
}

.peer-key-section input {
  width: 100%;
  padding: 8px;
  background: #0f0f23;
  border: 1px solid #16213e;
  border-radius: 4px;
  color: white;
  font-family: monospace;
  font-size: 12px;
  margin-bottom: 8px;
  box-sizing: border-box;
}

.peer-key-section button {
  padding: 8px 16px;
  background: #0f3460;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
}

.peer-key-section button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.key-manager button:last-child {
  padding: 8px 16px;
  background: #16213e;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
}

.encrypted-badge {
  font-size: 10px;
  margin-left: 4px;
  opacity: 0.7;
}
</style>
