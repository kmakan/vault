import { invoke } from '@tauri-apps/api/core';

const API_BASE = 'http://localhost:8081/api';

export class ApiClient {
  constructor() {
    this.token = null;
  }

  async login(email, password) {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    
    if (!response.ok) throw new Error('Login failed');
    const data = await response.json();
    this.token = data.token;
    return data;
  }

  async getChats() {
    const response = await fetch(`${API_BASE}/chats`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    
    if (!response.ok) throw new Error('Failed to get chats');
    return await response.json();
  }

  async getMessages(chatId) {
    const response = await fetch(`${API_BASE}/chats/${chatId}/messages`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    
    if (!response.ok) throw new Error('Failed to get messages');
    return await response.json();
  }

  async sendMessage(chatId, content) {
    const response = await fetch(`${API_BASE}/chats/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ content })
    });
    
    if (!response.ok) throw new Error('Failed to send message');
    return await response.json();
  }

  async getContacts() {
    const response = await fetch(`${API_BASE}/contacts`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    
    if (!response.ok) throw new Error('Failed to get contacts');
    return await response.json();
  }

  async addContact(email) {
    const response = await fetch(`${API_BASE}/contacts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ email })
    });
    
    if (!response.ok) throw new Error('Failed to add contact');
    return await response.json();
  }

  async getEmailAccounts() {
    const response = await fetch(`${API_BASE}/email-accounts`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    
    if (!response.ok) throw new Error('Failed to get email accounts');
    return await response.json();
  }

  async createEmailAccount(accountData) {
    const response = await fetch(`${API_BASE}/email-accounts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(accountData)
    });
    
    if (!response.ok) throw new Error('Failed to create email account');
    return await response.json();
  }

  async deleteEmailAccount(accountId) {
    const response = await fetch(`${API_BASE}/email-accounts/${accountId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    
    if (!response.ok) throw new Error('Failed to delete email account');
    return response.ok;
  }

  async fetchEmails(accountId, params = {}) {
    const response = await fetch(`${API_BASE}/email-accounts/${accountId}/emails`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ limit: params.limit || 50, folder: params.folder || 'INBOX' })
    });
    
    if (!response.ok) throw new Error('Failed to fetch emails');
    return await response.json();
  }

  async fetchEmailBody(accountId, uid) {
    const response = await fetch(`${API_BASE}/email-accounts/${accountId}/emails/${uid}`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    
    if (!response.ok) throw new Error('Failed to fetch email body');
    return await response.json();
  }

  async sendEmail(accountId, emailData) {
    const response = await fetch(`${API_BASE}/email-accounts/${accountId}/emails/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(emailData)
    });
    
    if (!response.ok) throw new Error('Failed to send email');
    return await response.json();
  }

  async getKeys() {
    const response = await fetch(`${API_BASE}/keys`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    
    if (!response.ok) throw new Error('Failed to get keys');
    return await response.json();
  }

  async createKey(keyData) {
    const response = await fetch(`${API_BASE}/keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(keyData)
    });
    
    if (!response.ok) throw new Error('Failed to create key');
    return await response.json();
  }

  // --- Avatar ---
  async uploadAvatar(email, dataUrl) {
    const response = await fetch(`${API_BASE}/avatar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ email, avatar: dataUrl })
    });
    if (!response.ok) throw new Error('Failed to upload avatar');
    return await response.json();
  }

  async getAvatar(email) {
    try {
      const response = await fetch(`${API_BASE}/avatar/${encodeURIComponent(email)}`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      if (!response.ok) return null;
      const data = await response.json();
      return data.avatar_url || null;
    } catch {
      return null;
    }
  }

  async deleteAvatar(email) {
    const response = await fetch(`${API_BASE}/avatar/${encodeURIComponent(email)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    return response.ok;
  }

  // --- Group Avatar ---
  async uploadGroupAvatar(groupId, dataUrl) {
    const response = await fetch(`${API_BASE}/groups/${groupId}/avatar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ avatar: dataUrl })
    });
    if (!response.ok) throw new Error('Failed to upload group avatar');
    return await response.json();
  }

  async deleteGroupAvatar(groupId) {
    const response = await fetch(`${API_BASE}/groups/${groupId}/avatar`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    return response.ok;
  }
}

export default new ApiClient();
