const API_BASE = 'http://localhost:9443/api';

class ApiClient {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.userId = null;
    this.email = null;
    this.username = null;
  }

  setTokens(accessToken, refreshToken) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
  }

  setUser(userId, email, username) {
    this.userId = userId;
    this.email = email;
    this.username = username;
  }

  async request(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (response.status === 401 && this.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${this.accessToken}`;
        const retryResponse = await fetch(`${API_BASE}${path}`, {
          ...options,
          headers,
        });
        if (!retryResponse.ok) {
          throw new Error(`Request failed: ${retryResponse.status}`);
        }
        return retryResponse.json();
      }
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `Request failed: ${response.status}`);
    }

    return response.json();
  }

  async refreshAccessToken() {
    try {
      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.refreshToken }),
      });

      if (!response.ok) {
        this.logout();
        return false;
      }

      const data = await response.json();
      this.setTokens(data.access_token, data.refresh_token || this.refreshToken);
      return true;
    } catch {
      this.logout();
      return false;
    }
  }

  async register(email, username, password) {
    const data = await this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, username, password }),
    });

    this.setTokens(data.tokens.access_token, data.tokens.refresh_token);
    this.setUser(data.user_id, data.email, data.username);
    this.saveSession();
    return data;
  }

  async login(email, password) {
    const data = await this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    this.setTokens(data.tokens.access_token, data.tokens.refresh_token);
    this.setUser(data.user_id, data.email, data.username);
    this.saveSession();
    return data;
  }

  logout() {
    this.accessToken = null;
    this.refreshToken = null;
    this.userId = null;
    this.email = null;
    this.username = null;
    localStorage.removeItem('vault_session');
  }

  saveSession() {
    const session = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      userId: this.userId,
      email: this.email,
      username: this.username,
    };
    localStorage.setItem('vault_session', JSON.stringify(session));
  }

  loadSession() {
    const saved = localStorage.getItem('vault_session');
    if (saved) {
      const session = JSON.parse(saved);
      this.setTokens(session.accessToken, session.refreshToken);
      this.setUser(session.userId, session.email, session.username);
      return true;
    }
    return false;
  }

  isAuthenticated() {
    return !!this.accessToken;
  }

  async getChats() {
    return this.request('/chats');
  }

  async createChat(userId) {
    return this.request('/chats', {
      method: 'POST',
      body: JSON.stringify({ user2_id: userId }),
    });
  }

  async getChat(chatId) {
    return this.request(`/chats/${chatId}`);
  }

  async getMessages(chatId) {
    return this.request(`/chats/${chatId}/messages`);
  }

  async sendMessage(chatId, content, subject = null) {
    const body = { content };
    if (subject) body.subject = subject;
    return this.request(`/chats/${chatId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getGroups() {
    return this.request('/groups');
  }

  async createGroup(name, description = null) {
    const body = { name };
    if (description) body.description = description;
    return this.request('/groups', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getGroup(groupId) {
    return this.request(`/groups/${groupId}`);
  }

  async addGroupMember(groupId, userId) {
    return this.request(`/groups/${groupId}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    });
  }

  async getGroupMessages(groupId) {
    return this.request(`/groups/${groupId}/messages`);
  }

  async sendGroupMessage(groupId, content, subject = null) {
    const body = { content };
    if (subject) body.subject = subject;
    return this.request(`/groups/${groupId}/messages`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async getContacts() {
    return this.request('/contacts');
  }

  async addContact(email) {
    return this.request('/contacts', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
  }

  async searchUsers(query) {
    return this.request(`/users/search?q=${encodeURIComponent(query)}`);
  }

  async getKeys() {
    return this.request('/keys');
  }

  async createKey(keyData) {
    return this.request('/keys', {
      method: 'POST',
      body: JSON.stringify(keyData),
    });
  }

  async deleteKey(keyId) {
    return this.request(`/keys/${keyId}`, {
      method: 'DELETE',
    });
  }

  async getEmailAccounts() {
    return this.request('/email-accounts');
  }

  async createEmailAccount(accountData) {
    return this.request('/email-accounts', {
      method: 'POST',
      body: JSON.stringify(accountData),
    });
  }

  async deleteEmailAccount(accountId) {
    return this.request(`/email-accounts/${accountId}`, {
      method: 'DELETE',
    });
  }

  async fetchEmails(accountId, params = {}) {
    return this.request(`/email-accounts/${accountId}/emails`, {
      method: 'POST',
      body: JSON.stringify({
        limit: params.limit || 50,
        folder: params.folder || 'INBOX',
      }),
    });
  }

  async fetchEmailBody(accountId, uid) {
    return this.request(`/email-accounts/${accountId}/emails/${uid}`);
  }

  async sendEmail(accountId, emailData) {
    return this.request(`/email-accounts/${accountId}/emails/send`, {
      method: 'POST',
      body: JSON.stringify(emailData),
    });
  }
}

const apiClient = new ApiClient();
export default apiClient;
