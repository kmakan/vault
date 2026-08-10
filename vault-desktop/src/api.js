import { invoke } from '@tauri-apps/api/core';

// ═════════════════════════════════════════════════════════════════════════
// Vault Desktop — serverless email transport (phase 2)
//
// The desktop no longer talks to the backend at localhost:9443. Instead it
// talks to the user's mailbox DIRECTLY over IMAP/SMTP via the Tauri Rust
// commands from phase 1 (email_connect / email_fetch_messages / email_fetch_body
// / email_send / email_disconnect). Crypto keys live in the Tauri key_store
// (used from crypto.js); this file only keeps transport + compatibility.
// ═════════════════════════════════════════════════════════════════════════

const GMAIL_CONFIG = {
  imap_server: 'imap.gmail.com',
  imap_port: 993,
  smtp_server: 'smtp.gmail.com',
  smtp_port: 587,
};

export class ApiClient {
  constructor() {
    const saved = localStorage.getItem('vault-token');
    this.token = saved && saved !== 'undefined' && saved !== 'null' ? saved : null;
    const savedEmail = localStorage.getItem('vault-email');
    this.email = savedEmail || null;
    this.password = null; // in-memory ONLY — never persisted to localStorage
    // On page reload the Tauri Rust email session (EmailState) survives, so a
    // saved email means we can keep fetching without re-login.
    this.connected = !!savedEmail;
    this.emailConfig = null;
    // Local contact stubs added via addContact (serverless: no backend /contacts)
    this.contacts = [];
  }

  // --- internal: connect the mailbox over IMAP/SMTP ---
  async emailConnect({ email, password, imap_server, imap_port, smtp_server, smtp_port }) {
    const config = {
      email,
      password,
      imap_server: imap_server || GMAIL_CONFIG.imap_server,
      imap_port: imap_port || GMAIL_CONFIG.imap_port,
      smtp_server: smtp_server || GMAIL_CONFIG.smtp_server,
      smtp_port: smtp_port || GMAIL_CONFIG.smtp_port,
    };
    try {
      const ok = await invoke('email_connect', { config });
      if (!ok) throw new Error('Failed to connect to email');
      this.emailConfig = config;
      return true;
    } catch (e) {
      throw new Error((e && e.message) || 'Failed to connect to email');
    }
  }

  // --- Auth (serverless): login === connect the mailbox ---
  async login(email, password) {
    await this.emailConnect({ email, password });
    this.email = email;
    this.password = password; // memory only
    this.connected = true;
    this.token = `serverless-${email}`;
    localStorage.setItem('vault-token', this.token);
    localStorage.setItem('vault-email', email);
    return { ok: true, user_id: email, tokens: { access_token: this.token }, token: this.token };
  }

  async register(username, email, password) {
    // Serverless: no backend registration — the mailbox IS the identity.
    await this.emailConnect({ email, password });
    this.email = email;
    this.password = password;
    this.connected = true;
    this.token = `serverless-${email}`;
    localStorage.setItem('vault-token', this.token);
    localStorage.setItem('vault-email', email);
    return { ok: true, user_id: email, tokens: { access_token: this.token }, token: this.token };
  }

  async logout() {
    try { await invoke('email_disconnect'); } catch (e) { /* ignore disconnect errors */ }
    this.email = null;
    this.password = null;
    this.connected = false;
    this.emailConfig = null;
    this.token = null;
    localStorage.removeItem('vault-token');
    localStorage.removeItem('vault-email');
  }

  // --- Chats (TODO: serverless-chats via email) ---
  async getChats() { return []; } // TODO serverless-chats via email
  async getMessages(chatId) { return []; } // TODO serverless-chats via email
  async sendMessage(chatId, content, contentType) { return { ok: true }; } // TODO serverless-chats via email
  async getGroupMessages(groupId) { return []; } // TODO serverless-chats via email
  async sendGroupMessage(groupId, content) { return { ok: true }; } // TODO serverless-chats via email

  // --- Contacts (local: key_store peer keys + in-memory stubs) ---
  async getContacts() {
    const byEmail = new Map();
    for (const c of this.contacts) byEmail.set(c.email, c);
    try {
      const peers = await invoke('load_peer_keys');
      for (const pk of peers || []) {
        if (!byEmail.has(pk.email)) {
          byEmail.set(pk.email, {
            id: pk.email,
            email: pk.email,
            name: pk.label || pk.email,
            online: false,
            public_key: pk.public_key,
            added_at: pk.added_at,
          });
        }
      }
    } catch (e) { /* ignore — fall back to in-memory list */ }
    return Array.from(byEmail.values());
  }

  async addContact(email) {
    if (this.contacts.some(c => c.email === email)) return { ok: true };
    this.contacts.push({ id: email, email, name: email, online: false });
    return { ok: true, id: email, email };
  }

  // --- Email accounts (single local mailbox kept in memory) ---
  async getEmailAccounts() {
    if (!this.connected || !this.email) return [];
    const c = this.emailConfig || GMAIL_CONFIG;
    return [{
      id: 'local',
      email: this.email,
      username: this.email.split('@')[0],
      imap_server: c.imap_server,
      imap_port: c.imap_port,
      smtp_server: c.smtp_server,
      smtp_port: c.smtp_port,
      is_default: true,
      use_tls: true,
    }];
  }

  async createEmailAccount(accountData) {
    const data = accountData || {};
    const password = data.password || data.password_encrypted || this.password || '';
    await this.emailConnect({
      email: data.email || this.email,
      password,
      imap_server: data.imap_server,
      imap_port: data.imap_port,
      smtp_server: data.smtp_server,
      smtp_port: data.smtp_port,
    });
    if (data.email) this.email = data.email;
    if (password) this.password = password;
    this.connected = true;
    return { id: 'local', email: this.email };
  }

  async deleteEmailAccount(accountId) {
    try { await invoke('email_disconnect'); } catch (e) { /* ignore */ }
    this.email = null;
    this.password = null;
    this.connected = false;
    this.emailConfig = null;
    return true;
  }

  // --- Email fetch / send ---
  async fetchEmails(accountId, params = {}) {
    const msgs = await invoke('email_fetch_messages');
    return (msgs || []).map(m => ({
      uid: m.id,
      id: m.id,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date,
      is_read: m.is_read,
    }));
  }

  async fetchEmailBody(accountId, uid) {
    return await invoke('email_fetch_body', { uid: String(uid) });
  }

  async sendEmail(accountId, emailData = {}) {
    const data = emailData || {};
    const ok = await invoke('email_send', {
      to: data.to,
      subject: data.subject || '',
      body: data.body || '',
    });
    return { ok };
  }

  // --- Keys (real key material lives in the Tauri key_store — see crypto.js) ---
  async getKeys() { return []; } // TODO: surface crypto.js / key_store state
  async createKey(keyData) { return null; } // TODO: use generate_keypair / save_my_keypair

  // --- Avatars (TODO: local file storage) ---
  async uploadAvatar(email, dataUrl) { return null; }
  async getAvatar(email) { return null; }
  async deleteAvatar(email) { return true; }
  async uploadGroupAvatar(groupId, dataUrl) { return null; }
  async deleteGroupAvatar(groupId) { return true; }

  // --- Groups (TODO: serverless-chats via email) ---
  async getGroups() { return []; }
  async createGroup(name, description) { return null; }
  async getGroupMembers(groupId) { return []; }
  async addGroupMember(groupId, userId, role) { return { ok: true }; }
  async distributeGroupKey(groupId, userId, encryptedKey) { return { ok: true }; }
  async getMyGroupKey(groupId) { return null; }
  async getGroupKeys(groupId) { return []; }
}

export default new ApiClient();
