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
    // Диагностика авто-входа: 'auth' | 'network' | 'none' (ставит restoreSession).
    this.lastRestoreError = null;
    // Сохранённые серверные настройки (из credentials) — для предзаполнения
    // формы входа, если провайдер сменил IMAP/SMTP и пользователь их правит.
    this.savedConfig = null;
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
  async login(email, password, { remember = true, config = null } = {}) {
    await this.emailConnect({ email, password, ...(config || {}) });
    this.email = email;
    this.password = password; // memory only
    this.connected = true;
    this.token = `serverless-${email}`;
    localStorage.setItem('vault-token', this.token);
    localStorage.setItem('vault-email', email);
    // «Запомнить меня»: учётные данные шифруются device-ключом и пишутся в
    // ~/.vault/credentials/ — при следующем запуске вход автоматический.
    if (remember) {
      try {
        const c = this.emailConfig || {};
        await invoke('save_credentials', {
          email,
          password,
          imapServer: c.imap_server || GMAIL_CONFIG.imap_server,
          imapPort: c.imap_port || GMAIL_CONFIG.imap_port,
          smtpServer: c.smtp_server || GMAIL_CONFIG.smtp_server,
          smtpPort: c.smtp_port || GMAIL_CONFIG.smtp_port,
        });
      } catch (e) {
        console.error('Failed to save credentials:', e);
      }
    }
    return { ok: true, user_id: email, tokens: { access_token: this.token }, token: this.token };
  }

  // --- Auto-login: restore the saved (device-encrypted) mailbox credentials
  // and reconnect IMAP. Returns true on success; false when nothing is saved
  // or the saved password no longer works (caller shows the login screen).
  async restoreSession() {
    this.lastRestoreError = null;
    let creds = null;
    try {
      creds = await invoke('load_credentials');
    } catch (e) {
      console.error('Failed to load saved credentials:', e);
      this.lastRestoreError = 'none';
      return false;
    }
    if (!creds || !creds.email || !creds.password) return false;
    // Запоминаем серверные настройки для предзаполнения формы входа: провайдер
    // мог сменить IMAP/SMTP, пользователь должен мочь их исправить.
    this.savedConfig = {
      imap_server: creds.imap_server || '',
      imap_port: creds.imap_port || '',
      smtp_server: creds.smtp_server || '',
      smtp_port: creds.smtp_port || '',
    };
    try {
      await this.emailConnect({
        email: creds.email,
        password: creds.password,
        imap_server: creds.imap_server,
        imap_port: creds.imap_port,
        smtp_server: creds.smtp_server,
        smtp_port: creds.smtp_port,
      });
    } catch (e) {
      const msg = String((e && e.message) || e).toLowerCase();
      // Стирать сохранённые учётные данные можно ТОЛЬКО при отказе
      // аутентификации (пароль сменён/отозван). Сетевая ошибка при старте
      // (нет интернета) не должна терять пароль — иначе авто-вход сломается.
      if (msg.includes('login failed') || msg.includes('authentication')) {
        console.error('Auto-login: saved password rejected, clearing it:', e);
        try { await invoke('delete_credentials'); } catch (_) { /* ignore */ }
        this.lastRestoreError = 'auth';
      } else {
        console.error('Auto-login: connection failed (credentials kept):', e);
        this.lastRestoreError = 'network';
      }
      return false;
    }
    this.email = creds.email;
    this.password = creds.password; // memory only
    this.connected = true;
    this.token = `serverless-${creds.email}`;
    localStorage.setItem('vault-token', this.token);
    localStorage.setItem('vault-email', creds.email);
    return true;
  }

  async logout() {
    try { await invoke('email_disconnect'); } catch (e) { /* ignore disconnect errors */ }
    // Выход = «забыть меня»: стираем сохранённые учётные данные с устройства.
    try { await invoke('delete_credentials'); } catch (e) { /* ignore */ }
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
  async sendMessage(chatId, content, contentType) {
    // Serverless: a chat message IS an encrypted vault email to the peer — the
    // chat id is the peer's email address.
    //
    // STEALTH: the subject is intentionally EMPTY. The old "Vault: <peer>"
    // subject leaked the very fact that this is a Vault/secure-messenger
    // conversation to the mail provider (inbox lists, push notifications,
    // provider logs). Receive does NOT depend on the subject: loadMessages()
    // locates mail by from/to and authenticates it as a vault message via
    // AAD-authenticated decryption (decryptVault, AAD="VAULT"). So an empty
    // subject is safe and removes the transport-level marker.
    const to = chatId;
    const subject = '';
    const res = await this.sendEmail('local', { to, subject, body: content });
    if (!res || !res.ok) throw new Error('Failed to send vault email');
    return { ok: true };
  }
  async getGroupMessages(groupId) {
    const msgs = await this.fetchEmails('local');
    const mine = msgs.filter(m => (m.subject || '').startsWith('VaultGroup: ' + groupId));
    const out = [];
    for (const m of mine) {
      const body = await this.fetchEmailBody('local', m.uid, m.folder);
      out.push({ id: m.uid, content: body, sender_id: m.from, created_at: new Date(m.date), is_read: m.is_read, is_sent: false });
    }
    // Инвайт-письма (VaultGroupInvite) не попадают в список сообщений группы —
    // они обрабатываются отдельно через попап согласия (fetchPendingInvites).
    return out;
  }
  // Письма-реакции группы (VaultGroupReact: <id>) — транспорт реакций,
  // не сообщения. Возвращаем тела для расшифровки групповым ключом.
  async getGroupReactEmails(groupId) {
    const msgs = await this.fetchEmails('local');
    const react = msgs.filter(m => (m.subject || '').startsWith('VaultGroupReact: ' + groupId));
    const out = [];
    for (const m of react) {
      try {
        const body = await this.fetchEmailBody('local', m.uid, m.folder);
        out.push({ id: m.uid, content: body, sender_id: m.from, created_at: new Date(m.date) });
      } catch (e) { /* тело не прочиталось — пропускаем */ }
    }
    return out;
  }
  async sendGroupMessage(groupId, content) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      await this.sendEmail('local', { to: member.email, subject: 'VaultGroup: ' + g.id, body: content });
    }
    return { ok: true };
  }
  // Реакция в 1-на-1 чат: зашифрованное письмо с ПУСТОЙ темой (stealth).
  // Тело — encryptVault(JSON {react:1, msg_id, emoji, action}); приём
  // классифицирует по содержимому, а не по теме.
  async sendReaction(peerEmail, encryptedContent) {
    const subject = '';
    const res = await this.sendEmail('local', { to: peerEmail, subject, body: encryptedContent });
    if (!res || !res.ok) throw new Error('Failed to send reaction email');
    return { ok: true };
  }
  // Реакция в группу: каждому участнику (кроме себя) письмо VaultGroupReact: <id>.
  async sendGroupReact(groupId, encryptedContent) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      await this.sendEmail('local', { to: member.email, subject: 'VaultGroupReact: ' + g.id, body: encryptedContent });
    }
    return { ok: true };
  }
  // Редактирование/удаление сообщения в 1-на-1 чат: зашифрованное письмо
  // с ПУСТОЙ темой (stealth). Тело — encryptVault(JSON {edit:1, msg_id,
  // text?, action:'edit'|'delete'}); приём классифицирует по содержимому.
  async sendEdit(peerEmail, encryptedContent) {
    const subject = '';
    const res = await this.sendEmail('local', { to: peerEmail, subject, body: encryptedContent });
    if (!res || !res.ok) throw new Error('Failed to send edit email');
    return { ok: true };
  }
  // Редактирование/удаление в группе: каждому участнику (кроме себя)
  // письмо VaultGroupEdit: <id> с шифром групповым ключом.
  async sendGroupEdit(groupId, encryptedContent) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      await this.sendEmail('local', { to: member.email, subject: 'VaultGroupEdit: ' + g.id, body: encryptedContent });
    }
    return { ok: true };
  }
  // Письма правок группы (VaultGroupEdit: <id>) — транспорт edit/delete,
  // не сообщения. Возвращаем тела для расшифровки групповым ключом.
  async getGroupEditEmails(groupId) {
    const msgs = await this.fetchEmails('local');
    const edits = msgs.filter(m => (m.subject || '').startsWith('VaultGroupEdit: ' + groupId));
    const out = [];
    for (const m of edits) {
      try {
        const body = await this.fetchEmailBody('local', m.uid, m.folder);
        out.push({ id: m.uid, content: body, sender_id: m.from, created_at: new Date(m.date) });
      } catch (e) { /* тело не прочиталось — пропускаем */ }
    }
    return out;
  }
  // Мета-обновление группы (аватар и т.п.): каждому участнику письмо
  // VaultGroupMeta: <id> с зашифрованным групповым ключом payload {meta:1,...}.
  async sendGroupMeta(groupId, encryptedContent) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      await this.sendEmail('local', { to: member.email, subject: 'VaultGroupMeta: ' + g.id, body: encryptedContent });
    }
    return { ok: true };
  }
  // Письма мета-обновлений группы (VaultGroupMeta: <id>) — транспорт аватара,
  // не сообщения. Возвращаем тела для расшифровки групповым ключом.
  async getGroupMetaEmails(groupId) {
    const msgs = await this.fetchEmails('local');
    const meta = msgs.filter(m => (m.subject || '').startsWith('VaultGroupMeta: ' + groupId));
    const out = [];
    for (const m of meta) {
      try {
        const body = await this.fetchEmailBody('local', m.uid, m.folder);
        out.push({ id: m.uid, content: body, sender_id: m.from, created_at: new Date(m.date) });
      } catch (e) { /* тело не прочиталось — пропускаем */ }
    }
    return out;
  }

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

  // --- Контакты 1-на-1: приглашение по id участника (как Session: ID/QR → запрос → принятие) ---
  async loadPeerKeyEmails() {
    const set = new Set();
    try {
      const peers = await invoke('load_peer_keys');
      for (const pk of peers || []) set.add(pk.email);
    } catch (e) { /* ignore */ }
    return set;
  }
  getDeclinedContacts() {
    try {
      return JSON.parse(localStorage.getItem('vault-declined-contacts') || '[]');
    } catch (e) {
      return [];
    }
  }
  async sendContactInvite(email, publicKey) {
    // Письмо-запрос: получатель увидит попап «Принять/Отклонить» и после
    // согласия сохранит наш публичный ключ (контакт появится у обоих).
    const name = localStorage.getItem('vault-display-name') || this.email;
    const avatar = localStorage.getItem('vault-avatar-' + this.email) || '';
    const payload = urlSafeB64({
      sender: this.email,
      sender_name: name,
      sender_avatar: avatar,
      public_key: publicKey,
    });
    await this.sendEmail('local', { to: email, subject: 'VaultContactInvite: ' + this.email, body: payload });
    return { ok: true, invited: true, email };
  }
  async fetchPendingContactInvites() {
    const msgs = await this.fetchEmails('local');
    const invites = msgs.filter(m => (m.subject || '').startsWith('VaultContactInvite: '));
    const declined = this.getDeclinedContacts();
    const peers = await this.loadPeerKeyEmails();
    const out = [];
    for (const m of invites) {
      const sender = (m.subject || '').slice('VaultContactInvite: '.length).trim();
      if (!sender || sender === this.email) continue; // себе не предлагаем
      if (declined.includes(`${sender}|${m.uid}`)) continue;
      let parsed;
      try {
        parsed = urlSafeB64Decode(await this.fetchEmailBody('local', m.uid, m.folder));
      } catch (e) {
        continue;
      }
      if (!parsed || !parsed.public_key) continue;
      // Профиль/аватар сохраняем ВСЕГДА — даже если это уже контакт.
      // Иначе аватар из инвайта никогда не дойдёт до существующего контакта
      // (раньше здесь был continue до парсинга — корень асимметрии аватаров).
      this.saveProfile(sender, parsed.sender_name, parsed.sender_avatar);
      if (peers.has(sender)) continue; // уже контакт — попап не показываем
      out.push({
        sender,
        sender_name: parsed.sender_name || sender,
        sender_avatar: parsed.sender_avatar || '',
        public_key: parsed.public_key,
        uid: m.uid,
        date: m.date,
      });
    }
    return out;
  }
  async sendContactAccept(email, publicKey) {
    const name = localStorage.getItem('vault-display-name') || this.email;
    const avatar = localStorage.getItem('vault-avatar-' + this.email) || '';
    const payload = urlSafeB64({
      sender: this.email,
      sender_name: name,
      sender_avatar: avatar,
      public_key: publicKey,
    });
    await this.sendEmail('local', { to: email, subject: 'VaultContactAccept: ' + this.email, body: payload });
    return { ok: true };
  }
  async fetchPendingContactAccepts() {
    const msgs = await this.fetchEmails('local');
    const accepts = msgs.filter(m => (m.subject || '').startsWith('VaultContactAccept: '));
    const peers = await this.loadPeerKeyEmails();
    const out = [];
    for (const m of accepts) {
      const sender = (m.subject || '').slice('VaultContactAccept: '.length).trim();
      if (!sender || sender === this.email) continue;
      let parsed;
      try {
        parsed = urlSafeB64Decode(await this.fetchEmailBody('local', m.uid, m.folder));
      } catch (e) {
        continue;
      }
      if (!parsed || !parsed.public_key) continue;
      // Профиль/аватар обновляем ВСЕГДА (даже если ключ уже сохранён) —
      // иначе аватар, загруженный после принятия контакта, никогда не дойдёт.
      this.saveProfile(sender, parsed.sender_name, parsed.sender_avatar);
      if (peers.has(sender)) continue; // ключ уже сохранён — только профиль обновили
      try {
        await invoke('save_peer_key', { email: sender, publicKey: parsed.public_key, label: parsed.sender_name || null });
      } catch (e) {
        continue;
      }
      if (!this.contacts.some(c => c.email === sender)) {
        this.contacts.push({ id: sender, email: sender, name: parsed.sender_name || sender, online: false });
      }
      out.push({ sender });
    }
    return out;
  }

  // --- Window/app icon (set the native window icon shown in waybar/dock) ---
  async setAppIcon(iconId) {
    return invoke('set_app_icon', { iconId });
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
    // Обновляем сохранённые учётные данные (смена пароля/сервера в настройках),
    // чтобы авто-вход после перезапуска использовал свежие данные.
    if (password) {
      try {
        const c = this.emailConfig || {};
        await invoke('save_credentials', {
          email: this.email,
          password,
          imapServer: c.imap_server || GMAIL_CONFIG.imap_server,
          imapPort: c.imap_port || GMAIL_CONFIG.imap_port,
          smtpServer: c.smtp_server || GMAIL_CONFIG.smtp_server,
          smtpPort: c.smtp_port || GMAIL_CONFIG.smtp_port,
        });
      } catch (e) {
        console.error('Failed to update saved credentials:', e);
      }
    }
    return { id: 'local', email: this.email };
  }

  async deleteEmailAccount(accountId) {
    try { await invoke('email_disconnect'); } catch (e) { /* ignore */ }
    try { await invoke('delete_credentials'); } catch (e) { /* ignore */ }
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
      folder: m.folder || 'INBOX',
    }));
  }

  async fetchEmailBody(accountId, uid, folder) {
    return await invoke('email_fetch_body', { uid: String(uid), folder: folder || 'INBOX' });
  }

  async fetchEmailBodies(folder, uids) {
    // Батч-фетч тел одной папки (Rust выбирает папку один раз) —
    // без него чат фетчил каждое тело отдельным round-trip'ом.
    const list = await invoke('email_fetch_bodies', { uids: uids.map(String), folder: folder || 'INBOX' });
    const out = {};
    for (const [uid, body] of list || []) out[String(uid)] = body;
    return out;
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

  // --- Groups (serverless via email) ---
  async getGroups() {
    try {
      return await invoke('groups_load');
    } catch (e) {
      return [];
    }
  }
  async createGroup(name, description) {
    return await invoke('groups_create', { name, creator: this.email || '' });
  }
  async getGroupMembers(groupId) {
    const g = await invoke('groups_get', { groupId });
    return (g && g.members) || [];
  }
  async inviteGroupMember(groupId, email, groupKeyEnc, senderPublicKey) {
    // Инвайт участника: НЕ добавляем мгновенно через groups_add_member — вместо
    // этого отправляем письмо VaultGroupInvite. Участник попадёт в группу только
    // после того, как примет приглашение (fetchPendingAccepts → groups_add_member).
    // Ключ группы НИКОГДА не уходит открытым текстом: groupKeyEnc — это group_key,
    // зашифрованный на публичном ключе ПОЛУЧАТЕЛЯ (ECDH X25519 + XChaCha20,
    // см. crypto.encryptGroupKeyForUser). Прочитав письмо в почтовом клиенте,
    // расшифровать его невозможно без приватного ключа получателя.
    const g = await invoke('groups_get', { groupId });
    if (!g || !g.group_key) throw new Error('Group not found');
    const name = localStorage.getItem('vault-display-name') || this.email;
    const avatar = localStorage.getItem('vault-avatar-' + this.email) || '';
    const payload = urlSafeB64({
      group_id: g.id,
      group_name: g.name,
      group_key_enc: groupKeyEnc || '',
      sender: this.email,
      sender_name: name,
      sender_avatar: avatar,
      // Публичный ключ отправителя — не секрет; нужен принимающему для ECDH.
      sender_public_key: senderPublicKey || '',
      // Состав группы на момент инвайта: создатель + участники с ролями.
      // Принимающий импортирует их через groups_import — роли авторитетны.
      created_by: g.created_by || '',
      members: (g.members || [])
        .filter(m => m && m.email)
        .map(m => ({ email: m.email, role: m.role || 'Member' })),
      // Аватар группы (если установлен админом) — новый участник увидит его сразу.
      group_avatar: localStorage.getItem('vault-group-avatar-' + g.id) || '',
    });
    await this.sendEmail('local', { to: email, subject: 'VaultGroupInvite: ' + g.id, body: payload });
    return { ok: true, invited: true, email };
  }
  // Alias для обратной совместимости — не добавляет мгновенно, а шлёт инвайт.
  // Требует зашифрованный group key (см. inviteGroupMember).
  async addGroupMember(groupId, email) {
    throw new Error('addGroupMember: приглашение требует зашифрованный ключ группы — используйте inviteGroupMember через UI');
  }
  async acceptGroupInvite(groupId, invitePayload) {
    const payload = invitePayload || {};
    // Импортируем группу с ключом из инвайта. Роли и создатель приходят из
    // инвайта (created_by + members) — Rust сливает их с локальными.
    // Роли нормализуем к валидным значениям enum GroupRole.
    const validRoles = ['Admin', 'Moderator', 'Member'];
    const inviteMembers = Array.isArray(payload.members)
      ? payload.members
          .filter(m => m && m.email)
          .map(m => ({ email: m.email, role: validRoles.includes(m.role) ? m.role : 'Member' }))
      : null;
    await invoke('groups_import', {
      groupId,
      name: payload.group_name,
      groupKey: payload.group_key,
      sender: payload.sender,
      createdBy: payload.created_by || null,
      members: inviteMembers,
    });
    // Добавляем СЕБЯ как участника (роль Member) — import_group добавляет
    // только отправителя, а принимающий иначе не попадёт в members.
    try {
      await invoke('groups_add_member', { groupId, email: this.email });
    } catch (e) { /* уже участник или временная ошибка — не блокируем */ }
    // Отправляем пригласившему письмо VaultGroupAccept (подтверждение согласия).
    const name = localStorage.getItem('vault-display-name') || this.email;
    const avatar = localStorage.getItem('vault-avatar-' + this.email) || '';
    const body = urlSafeB64({
      group_id: groupId,
      sender: this.email,
      sender_name: name,
      sender_avatar: avatar,
    });
    // Письмо-подтверждение шлём ВСЕМ участникам группы (кроме себя), а не
    // только пригласившему: так каждый участник локально добавит новичка
    // (fetchPendingAccepts → groups_add_member идемпотентно). Раньше accept
    // уходил одному инвайтеру — у остальных groups.json никогда не обновлялся
    // (рассинхрон ростера: участник есть у одного, отсутствует у другого).
    const roster = new Set();
    try {
      const g = await invoke('groups_get', { groupId });
      for (const m of (g && g.members) || []) {
        if (m && m.email && m.email !== this.email) roster.add(m.email);
      }
    } catch (e) { /* группа ещё не импортирована — отправим хотя бы инвайтеру */ }
    if (payload.sender && payload.sender !== this.email) roster.add(payload.sender);
    for (const to of roster) {
      try {
        await this.sendEmail('local', { to, subject: 'VaultGroupAccept: ' + groupId, body });
      } catch (e) {
        console.error('accept mail failed for', to, e);
      }
    }
    if (payload.sender) {
      // Сохраняем профиль пригласившего в кэш.
      this.saveProfile(payload.sender, payload.sender_name, payload.sender_avatar);
    }
    return { ok: true, group_id: groupId };
  }
  async declineGroupInvite(groupId, msgUid, senderEmail) {
    // Ничего не отправляем — просто помечаем инвайт как отклонённый, чтобы при
    // следующем поллинге он больше не предлагался.
    const key = `${groupId}|${msgUid}`;
    const declined = this.getDeclinedInvites();
    if (!declined.includes(key)) {
      declined.push(key);
      localStorage.setItem('vault-declined-invites', JSON.stringify(declined));
    }
    return { ok: true };
  }
  getDeclinedInvites() {
    try {
      return JSON.parse(localStorage.getItem('vault-declined-invites') || '[]');
    } catch (e) {
      return [];
    }
  }
  async setGroupMemberRole(groupId, email, role) {
    return await invoke('groups_set_member_role', { groupId, email, role });
  }
  async removeGroupMember(groupId, email) {
    return await invoke('groups_remove_member', { groupId, email });
  }
  async leaveGroup(groupId) {
    // Покинуть группу: удаляем себя из members (~/.vault/groups.json).
    return await invoke('groups_leave', { groupId, email: this.email });
  }
  async deleteGroup(groupId) {
    // Удалить группу полностью (только создатель, UI блокирует остальных).
    return await invoke('groups_delete', { groupId });
  }
  async distributeGroupKey(groupId, userId, encryptedKey) { return { ok: true }; }
  async getMyGroupKey(groupId) {
    const g = await invoke('groups_get', { groupId });
    return (g && g.group_key) ? { group_key: g.group_key } : null;
  }
  async getGroupKeys(groupId) {
    const g = await invoke('groups_get', { groupId });
    return (g && g.group_key) ? [g.group_key] : [];
  }

  // --- Profile cache (имя/аватар из настроек, кэш для отображения в чатах) ---
  saveProfile(email, name, avatar) {
    if (!email) return;
    let profiles = {};
    try {
      profiles = JSON.parse(localStorage.getItem('vault-profiles') || '{}');
    } catch (e) {
      profiles = {};
    }
    const p = profiles[email] || {};
    if (name) p.name = name;
    if (avatar) p.avatar = avatar;
    if (name || avatar) profiles[email] = p;
    localStorage.setItem('vault-profiles', JSON.stringify(profiles));
    // Синхронизируем быстрый кэш UserAvatar (vault-avatar-<email>),
    // чтобы 1-на-1 чат и список контактов видели аватар без getProfile.
    if (avatar) {
      localStorage.setItem('vault-avatar-' + email, avatar);
    }
  }
  getProfile(email) {
    if (!email) return null;
    // Для самого пользователя профиль = displayName + vault-avatar-<email>.
    if (email === this.email) {
      return {
        name: localStorage.getItem('vault-display-name') || this.email,
        avatar: localStorage.getItem('vault-avatar-' + this.email) || '',
      };
    }
    try {
      const profiles = JSON.parse(localStorage.getItem('vault-profiles') || '{}');
      return profiles[email] || null;
    } catch (e) {
      return null;
    }
  }

  // --- Групповые инвайты: ожидающие подтверждения ---
  async fetchPendingInvites() {
    const msgs = await this.fetchEmails('local');
    const invites = msgs.filter(m => (m.subject || '').startsWith('VaultGroupInvite: '));
    const declined = this.getDeclinedInvites();
    const out = [];
    for (const m of invites) {
      let parsed;
      try {
        parsed = urlSafeB64Decode(await this.fetchEmailBody('local', m.uid, m.folder));
      } catch (e) {
        // Раньше молчаливый continue — инвайт пропадал без следа.
        console.warn('[invites] body fetch failed for uid', m.uid, 'folder', m.folder, e);
        continue;
      }
      if (!parsed || !parsed.group_id) {
        console.warn('[invites] unparseable invite body, uid', m.uid);
        continue;
      }
      // Пропускаем, если уже отклонён.
      if (declined.includes(`${parsed.group_id}|${m.uid}`)) continue;
      // Группу пропускаем, только если МЫ уже участник/создатель.
      // (groups.json общий на машину — сама по себе существующая группа не
      // означает, что инвайт принят этим аккаунтом.)
      try {
        const g = await invoke('groups_get', { groupId: parsed.group_id });
        if (g && (g.created_by === this.email || (g.members || []).some(mm => mm.email === this.email))) {
          continue;
        }
      } catch (e) { /* группа ещё не импортирована */ }
      out.push({
        group_id: parsed.group_id,
        group_name: parsed.group_name,
        // Новый формат: group_key зашифрован на нашем публичном ключе.
        group_key_enc: parsed.group_key_enc || null,
        sender_public_key: parsed.sender_public_key || null,
        // Legacy-инвайты (до шифрования ключей) — открытый group_key.
        group_key: parsed.group_key || null,
        sender: parsed.sender,
        sender_name: parsed.sender_name,
        sender_avatar: parsed.sender_avatar,
        // Состав группы с ролями на момент инвайта (для groups_import).
        created_by: parsed.created_by || null,
        members: Array.isArray(parsed.members) ? parsed.members : null,
        // Аватар группы на момент инвайта.
        group_avatar: parsed.group_avatar || null,
        uid: m.uid,
        date: m.date,
      });
    }
    return out;
  }

  // --- Групповые accept-письма: добавить принявших участников ---
  async fetchPendingAccepts() {
    const msgs = await this.fetchEmails('local');
    const accepts = msgs.filter(m => (m.subject || '').startsWith('VaultGroupAccept: '));
    const out = [];
    for (const m of accepts) {
      let payload;
      try {
        payload = urlSafeB64Decode(await this.fetchEmailBody('local', m.uid, m.folder));
      } catch (e) {
        continue;
      }
      if (!payload || !payload.group_id) continue;
      // Идемпотентно добавляем принявшего участника (обёртка не падает, если уже участник).
      try {
        await invoke('groups_add_member', { groupId: payload.group_id, email: payload.sender });
      } catch (e) {
        // уже участник или временная ошибка — игнорируем
      }
      this.saveProfile(payload.sender, payload.sender_name, payload.sender_avatar);
      out.push({ group_id: payload.group_id, sender: payload.sender });
    }
    return out;
  }
}

export default new ApiClient();

// --- url-safe base64 helpers (CLI group protocol uses URL_SAFE_NO_PAD) ---
function urlSafeB64(obj) {
  const json = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function urlSafeB64Decode(str) {
  // Приём ОБЯЗАН убирать whitespace перед base64-декодом: отправка фолдит
  // строки ≤76 (fold_lines в email.rs), SMTP-хопы тоже могут перекодировать —
  // без этого atob падает на '\n' и инвайт молча пропускается. Тот же урок,
  // что в CLI (7b6b978: strip whitespace before base64 decode).
  const clean = (str || '').replace(/\s+/g, '');
  const b64 = clean.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return JSON.parse(decodeURIComponent(escape(atob(b64 + pad))));
}
