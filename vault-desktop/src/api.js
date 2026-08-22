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

export { db };

// ── Local persistence: sqlite via Rust (Delta Chat-style disk DB) ─────────
// Всё локальное состояние Vault (история, tombstones, курсоры, кэш тел,
// kv) живёт в sqlite (~/.local/share/com.vault.vault/vault.db). localStorage
// больше НЕ источник истины: квота ~5 МБ (body-cache уже 3–7 МБ) и он
// ненадёжен в WebKitGTK. Все db_* методы — thin invoke-обёртки.

const db = {
  historySave: (account, chatKey, messagesJson) =>
    invoke('db_history_save', { account, chatKey, messagesJson }),
  historyLoad: (account, chatKey) =>
    invoke('db_history_load', { account, chatKey }),
  historyClear: (account) =>
    invoke('db_history_clear', { account }),
  tombstoneAdd: (account, msgId, mid) =>
    invoke('db_tombstone_add', { account, msgId, mid }),
  tombstonesLoad: (account) =>
    invoke('db_tombstones_load', { account }),
  tombstonesClear: (account) =>
    invoke('db_tombstones_clear', { account }),
  cursorsSave: (account, cursorsJson) =>
    invoke('db_cursors_save', { account, cursorsJson }),
  cursorsLoad: (account) =>
    invoke('db_cursors_load', { account }),
  bodyCacheSet: (account, cacheKey, body) =>
    invoke('db_body_cache_set', { account, cacheKey, body }),
  bodyCacheGet: (account, cacheKey) =>
    invoke('db_body_cache_get', { account, cacheKey }),
  bodyCacheLoadAll: (account) =>
    invoke('db_body_cache_load_all', { account }),
  bodyCacheClear: (account) =>
    invoke('db_body_cache_clear', { account }),
  kvSet: (account, key, value) =>
    invoke('db_kv_set', { account, key, value }),
  kvGet: (account, key) =>
    invoke('db_kv_get', { account, key }),
  kvDelete: (account, key) =>
    invoke('db_kv_delete', { account, key }),
  emailsSave: (account, emailsJson) =>
    invoke('db_emails_save', { account, emailsJson }),
  emailsLoad: (account) =>
    invoke('db_emails_load', { account }),
  emailsClear: (account) =>
    invoke('db_emails_clear', { account }),
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
    // In-memory кэш аватаров (данные — в sqlite kv_store, НЕ localStorage).
    this._avatarCache = new Map();
    // Кэш handshake-писем на один тик поллинга (см. fetchAllHandshake).
    this._handshakeCache = null;
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
      // Tauri на Android бросает ошибки команд как строку (не Error) — тогда
      // e.message === undefined и пользователь видит бесполезный фолбэк.
      // Извлекаем реальный текст из любого вида ошибки.
      const raw = (e && e.message) || (typeof e === 'string' ? e : (e && String(e)));
      throw new Error(raw || 'Failed to connect to email');
    }
  }

  // --- Auth (serverless): login === connect the mailbox ---
  async login(email, password, { remember = true, config = null } = {}) {
    await this.emailConnect({ email, password, ...(config || {}) });
    this.email = email;
    this.password = password; // memory only
    this.connected = true;
    this.token = `serverless-${email}`;
    this._displayName = undefined; // кэш имени привязан к аккаунту
    localStorage.setItem('vault-token', this.token);
    localStorage.setItem('vault-email', email);
    // Одноразовая миграция localStorage → kv_store (21.08): старые пометки/
    // аватары живы в webview-localStorage, а код читает kv_store.
    this.migrateLegacyLocalStorage().catch(() => {});
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
    this._displayName = undefined; // кэш имени привязан к аккаунту
    localStorage.setItem('vault-token', this.token);
    localStorage.setItem('vault-email', creds.email);
    // Одноразовая миграция localStorage → kv_store (21.08).
    this.migrateLegacyLocalStorage().catch(() => {});
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
    this._displayName = undefined; // кэш имени привязан к аккаунту
    localStorage.removeItem('vault-token');
    localStorage.removeItem('vault-email');
  }

  // --- Одноразовая миграция localStorage → kv_store (21.08) ---
  // Коммиты af77c15–c0a834b перенесли МЕСТО хранения handshake-пометок,
  // профилей и аватаров из localStorage в sqlite kv_store, но НЕ перенесли
  // сами данные: старые пометки остались в webview-localStorage, а код читает
  // пустой kv_store. Отсюда фантомные инвайты, «воскресшие» удаления (замки)
  // и пропавшие аватары. Метод вызывается при входе, переносит данные один
  // раз (маркер vault-kv-migrated) и чистит localStorage (квота ~5МБ).
  async migrateLegacyLocalStorage() {
    const acc = this.email || 'anon';
    try {
      if (localStorage.getItem('vault-kv-migrated')) return;
      // 1. Профили/аватары (namespace 'anon', как в getProfilesAll).
      const kvProfiles = await this.getProfilesAll();
      let migrated = false;
      try {
        const lsProfiles = JSON.parse(localStorage.getItem('vault-profiles') || '{}');
        for (const [email, p] of Object.entries(lsProfiles || {})) {
          if (!kvProfiles[email]) kvProfiles[email] = {};
          if (p && p.name && !kvProfiles[email].name) kvProfiles[email].name = p.name;
          if (p && p.avatar && !kvProfiles[email].avatar) kvProfiles[email].avatar = p.avatar;
        }
        if (Object.keys(lsProfiles || {}).length) migrated = true;
      } catch (e) { /* ignore broken JSON */ }
      // Отдельные ключи vault-avatar-<email> (старый формат до vault-profiles).
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('vault-avatar-')) {
          const email = key.slice('vault-avatar-'.length);
          const avatar = localStorage.getItem(key);
          if (email && avatar) {
            if (!kvProfiles[email]) kvProfiles[email] = {};
            if (!kvProfiles[email].avatar) kvProfiles[email].avatar = avatar;
            migrated = true;
          }
        }
      }
      if (migrated) await db.kvSet('anon', 'profiles', JSON.stringify(kvProfiles));
      // 2. Handshake-пометки (per-account): переносим, только если в kv пусто
      // (свежие данные в kv — авторитетнее старого localStorage).
      const pairs = [
        ['vault-accepted-contacts', 'accepted-contacts'],
        ['vault-declined-contacts', 'declined-contacts'],
        ['vault-accepted-invites', 'accepted-invites'],
        ['vault-declined-invites', 'declined-invites'],
      ];
      for (const [lsKey, kvKey] of pairs) {
        const ls = localStorage.getItem(lsKey);
        if (!ls) continue;
        const kv = await db.kvGet(acc, kvKey);
        if (kv && kv !== '[]') continue; // в kv уже есть данные — не затираем
        await db.kvSet(acc, kvKey, ls);
      }
      // 2b. Display-name (строка, не массив): vault-display-name → kv.
      try {
        const dn = localStorage.getItem('vault-display-name');
        if (dn && !(await db.kvGet(acc, 'display-name'))) {
          await db.kvSet(acc, 'display-name', dn);
        }
      } catch (e) { /* ignore */ }
      // 3. Чистим перенесённое и ставим маркер.
      localStorage.removeItem('vault-profiles');
      localStorage.removeItem('vault-display-name');
      for (const [lsKey] of pairs) localStorage.removeItem(lsKey);
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        // vault-avatar-* перенесены в kv; vault-hist:* — легаси-копия
        // истории (источник — sqlite chat_history, копию больше не ведём).
        if (key && (key.startsWith('vault-avatar-') || key.startsWith('vault-hist:'))) toRemove.push(key);
      }
      for (const k of toRemove) localStorage.removeItem(k);
      localStorage.setItem('vault-kv-migrated', '1');
      console.log('[migrate] localStorage → kv_store done');
    } catch (e) {
      console.warn('migrateLegacyLocalStorage failed:', e);
    }
  }

  // --- Отображаемое имя (display-name) → kv_store (21.08) ---
  // Раньше — localStorage 'vault-display-name'. Имя — настройка аккаунта,
  // а не UI-предпочтение: хранится в kv (namespace = account), кэшируется.
  async getDisplayName() {
    if (this._displayName !== undefined) return this._displayName;
    try {
      this._displayName = (await db.kvGet(this.email || 'anon', 'display-name')) || null;
    } catch (e) {
      this._displayName = null;
    }
    return this._displayName;
  }
  async setDisplayName(name) {
    this._displayName = name || null;
    try { await db.kvSet(this.email || 'anon', 'display-name', name || ''); } catch (e) { /* ignore */ }
  }

  // --- Модель контактов Delta Chat (22.08) ---
  // Удаление контакта — СТРОГО ЛОКАЛЬНОЕ (как Contact::delete в deltachat-core):
  // удаляется ключ + старые handshake-письма помечаются tombstone по uid
  // (markContactHandshakeDone). Никаких писем-уведомлений второй стороне,
  // никаких списков «удалён мной»/«удалил меня» — они только создавали
  // фантомные замки и спам повторными отправками. Повторное добавление
  // тривиально: новое приглашение (новый uid) проходит всегда.

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
  async getGroupMessages(groupId, emails) {
    // STEALTH-ГРУППЫ (18.08): темы у групповых писем ПУСТЫЕ (как в 1:1), так
    // что фильтрация по subject невозможна. Возвращаем ВСЕ письма, чей
    // отправитель — участник группы; классификация по содержимому после
    // расшифровки групповым ключом происходит в loadGroupMessages
    // (расшифровка не пройдёт для 1:1-писем/чужих — криптография фильтрует).
    //
    // ВАЖНО (регрессия 18.08, 124ac4d): тела фетчим БАТЧЕМ по папкам
    // (fetchEmailBodies — один round-trip на папку), а НЕ по одному письму:
    // при фильтре «все письма участников» сюда попадают и 1:1-письма
    // (десятки!), и по-писемный фетч вызывал IMAP-троттлинг Gmail → фетчи
    // тихо падали и групповой чат не загружался вовсе.
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    const memberEmails = (g.members || [])
      .map(m => String(m.email || '').toLowerCase())
      .filter(Boolean);
    // ФИКС 20.08: поллинг группы (каждые 30с) НЕ должен делать полный
    // IMAP-скан (fetchEmails) — это был триггер Gmail-троттлинга: при
    // открытой группе × несколько окон аккаунт упирался в rate limit,
    // SMTP-отправки начинали падать («метка красная», письмо одному из
    // участников не уходило). Поллинг передаёт актуальный this.emails
    // (loadEmails обновляет его инкрементально); полный скан остаётся
    // только как fallback, когда список ещё пуст (первый вход).
    const msgs = emails && emails.length ? emails : await this.fetchEmails('local');
    const mine = msgs.filter(m => {
      const from = String(m.from || '').toLowerCase();
      return memberEmails.some(e => from.includes(e));
    });
    // Группируем по папке → по одному батч-фетчу тел на папку.
    const byFolder = {};
    for (const m of mine) {
      const f = m.folder || 'INBOX';
      (byFolder[f] = byFolder[f] || []).push(m);
    }
    const bodiesByFolder = {};
    for (const [folder, list] of Object.entries(byFolder)) {
      const uids = list.map(m => m.uid || m.id);
      try {
        bodiesByFolder[folder] = await this.fetchEmailBodies(folder, uids);
      } catch (e) {
        console.log('[getGroupMessages] batch failed folder=' + folder + ' n=' + uids.length + ' err=' + (e && e.message || e));
      }
    }
    const out = [];
    for (const m of mine) {
      const folder = m.folder || 'INBOX';
      const body = bodiesByFolder[folder] && bodiesByFolder[folder][String(m.uid || m.id)];
      // Пропускаем письма без тела (батч упал/тело пустое) — они перефетчатся
      // в следующий поллинг; одно плохое письмо не роняет весь чат.
      if (!body) continue;
      out.push({ id: m.uid, content: body, sender_id: m.from, created_at: new Date(m.date), is_read: m.is_read, is_sent: false, message_id: m.message_id || '' });
    }
    // Инвайт-письма (VaultGroupInvite) не попадают в список сообщений группы —
    // они обрабатываются отдельно через попап согласия (fetchPendingInvites).
    return out;
  }
  async sendGroupMessage(groupId, content) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    // STEALTH: пустая тема (как 1:1). Получатель классифицирует по
    // содержимому (расшифровка групповым ключом), а не по теме.
    // Per-member try/catch: сбой SMTP одного адресата (троттлинг, таймаут)
    // не должен рвать цикл и лишать письма остальных участников.
    const failed = [];
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      try {
        await this.sendEmail('local', { to: member.email, subject: '', body: content });
      } catch (e) {
        console.error(`sendGroupMessage: ${member.email} failed:`, e);
        failed.push(member.email);
      }
    }
    if (failed.length) {
      // ФИКС 20.08: не бросаем целиком — письма успешным участникам уже
      // ушли, а UI помечает сообщение 'failed' («не доставлено: ...»).
      // Раньше throw оставлял статус 'sending' (красный) навсегда, а через
      // 10 минут mergePending-страховка молча удаляла сообщение.
      return { ok: false, failed };
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
  // Реакция в группу: каждому участнику (кроме себя) письмо с ПУСТОЙ темой
  // (stealth, как 1:1) — классификация по содержимому после расшифровки.
  async sendGroupReact(groupId, encryptedContent) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    const failed = [];
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      try {
        await this.sendEmail('local', { to: member.email, subject: '', body: encryptedContent });
      } catch (e) {
        console.error(`sendGroupReact: ${member.email} failed:`, e);
        failed.push(member.email);
      }
    }
    if (failed.length) throw new Error('React: SMTP failed for: ' + failed.join(', '));
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
  // Квитанция «просмотрено» в 1-на-1: зашифрованное письмо с ПУСТОЙ темой
  // (stealth). Тело — encryptVault(JSON {read:1, msg_ids:[...]}); отправитель
  // классифицирует по содержимому как квитанцию чтения и ставит синий кружок.
  async sendReadReceipt(peerEmail, encryptedContent) {
    const subject = '';
    const res = await this.sendEmail('local', { to: peerEmail, subject, body: encryptedContent });
    if (!res || !res.ok) throw new Error('Failed to send read receipt');
    return { ok: true };
  }
  // Редактирование/удаление в группе: каждому участнику (кроме себя)
  // письмо с ПУСТОЙ темой (stealth) — классификация по содержимому.
  async sendGroupEdit(groupId, encryptedContent) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    const failed = [];
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      try {
        await this.sendEmail('local', { to: member.email, subject: '', body: encryptedContent });
      } catch (e) {
        console.error(`sendGroupEdit: ${member.email} failed:`, e);
        failed.push(member.email);
      }
    }
    if (failed.length) throw new Error('Edit: SMTP failed for: ' + failed.join(', '));
    return { ok: true };
  }
  // Квитанции чтения группы (stealth-письмо с пустой темой): получатель при
  // открытии чата шлёт одно письмо со списком прочитанных msg_id (шифр
  // групповым ключом). Классификация — по содержимому {read:1,...}.
  async sendGroupRead(groupId, encryptedContent) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    const failed = [];
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      try {
        await this.sendEmail('local', { to: member.email, subject: '', body: encryptedContent });
      } catch (e) {
        console.error(`sendGroupRead: ${member.email} failed:`, e);
        failed.push(member.email);
      }
    }
    if (failed.length) throw new Error('Read: SMTP failed for: ' + failed.join(', '));
    return { ok: true };
  }
  // Мета-обновление группы (аватар и т.п.): каждому участнику письмо
  // с ПУСТОЙ темой (stealth) с зашифрованным групповым ключом payload
  // {meta:1,...}; классификация — по содержимому.
  async sendGroupMeta(groupId, encryptedContent) {
    const g = await invoke('groups_get', { groupId });
    if (!g) throw new Error('Group not found');
    const failed = [];
    for (const member of g.members || []) {
      if (member.email === this.email) continue;
      try {
        await this.sendEmail('local', { to: member.email, subject: '', body: encryptedContent });
      } catch (e) {
        console.error(`sendGroupMeta: ${member.email} failed:`, e);
        failed.push(member.email);
      }
    }
    if (failed.length) throw new Error('Meta: SMTP failed for: ' + failed.join(', '));
    return { ok: true };
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

  // Полное удаление контакта: диск (peer_keys) чистит crypto.removePeerKey,
  // а здесь убираем in-memory stubs — иначе getContacts() вернёт удалённый
  // контакт из this.contacts и он «не удалится» до перезапуска приложения.
  async removeContact(email) {
    this.contacts = this.contacts.filter(c => c.email !== email);
    return { ok: true };
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
  // ── Handshake-пометки: sqlite kv_store (localStorage НЕ источник истины) ──
  // Персистентные списки обработанных handshake-писем (invite/accept/delete).
  // Ключ = `${sender}|${uid}` (как tombstones): письма навсегда остаются в
  // ящике, и без пометки после удаления контакта снова «активируются».
  async getDeclinedContacts() {
    try {
      return JSON.parse((await db.kvGet(this.email || 'anon', 'declined-contacts')) || '[]');
    } catch (e) {
      return [];
    }
  }
  async markDeclinedContact(key) {
    try {
      const arr = await this.getDeclinedContacts();
      if (!arr.includes(key)) {
        arr.push(key);
        await db.kvSet(this.email || 'anon', 'declined-contacts', JSON.stringify(arr));
      }
    } catch (e) { /* ignore */ }
  }
  async getAcceptedContacts() {
    try {
      return JSON.parse((await db.kvGet(this.email || 'anon', 'accepted-contacts')) || '[]');
    } catch (e) {
      return [];
    }
  }
  async markAcceptedContact(key) {
    try {
      const arr = await this.getAcceptedContacts();
      if (!arr.includes(key)) {
        arr.push(key);
        await db.kvSet(this.email || 'anon', 'accepted-contacts', JSON.stringify(arr));
      }
    } catch (e) { /* ignore */ }
  }
  // --- Отправленные НАМИ приглашения (invited-senders) ---
  // Защита авто-принятия (модель Delta Chat, 22.08): accept-письмо добавляет
  // контакт автоматически ТОЛЬКО если мы сами приглашали этого отправителя.
  // Иначе любое стороннее accept-письмо со своим ключом молча попало бы в
  // контакты без согласия, а СТАРЫЕ accept-письма (обработанные ещё до
  // uid-пометок) «воскрешали» бы удалённый контакт (баг v0.1.8: kmakan на
  // android появился без принятия — UID 278, legacy-accept без пометки).
  async getInvitedSenders() {
    try {
      return JSON.parse((await db.kvGet(this.email || 'anon', 'invited-senders')) || '[]');
    } catch (e) {
      return [];
    }
  }
  async addInvitedSender(email) {
    try {
      const arr = await this.getInvitedSenders();
      if (!arr.includes(email)) {
        arr.push(email);
        await db.kvSet(this.email || 'anon', 'invited-senders', JSON.stringify(arr));
      }
    } catch (e) { /* ignore */ }
  }
  async removeInvitedSender(email) {
    try {
      const arr = (await this.getInvitedSenders()).filter(e => e !== email);
      await db.kvSet(this.email || 'anon', 'invited-senders', JSON.stringify(arr));
    } catch (e) { /* ignore */ }
  }
  // --- Одноразовый sweep старых handshake-писем (v0.1.9, модель Delta Chat) ---
  // Корень «призрачных» инвайтов: handshake-письма живут в ящике ВЕЧНО, а до
  // v0.1.7 не было uid-пометок. В v0.1.8 их подавлял список deleted-senders,
  // в v0.1.9 он удалён (удаление локально) — и СТАРЫЕ инвайты/accept'ы без
  // пометки всплыли заново («пришёл инвайт от kmakan, хотя я не отправлял»).
  // Фикс: ОДИН РАЗ на аккаунт помечаем ВСЕ текущие непокрытые handshake-письма
  // (invites → declined, accepts → accepted), чтобы они больше не всплывали.
  async sweepStaleHandshake() {
    try {
      const done = await db.kvGet(this.email || 'anon', 'handshake-sweep-done');
      if (done) return; // уже сделано для этого аккаунта — не повторяем
      const all = await this.fetchAllHandshake();
      const declined = await this.getDeclinedContacts();
      const accepted = await this.getAcceptedContacts();
      let changed = false;
      for (const m of all.invites) {
        const sender = m.parsed ? m.parsed.sender : (m.subject || '').slice('VaultContactInvite: '.length).trim();
        if (!sender || sender === this.email) continue;
        const key = `${sender}|${m.uid}`;
        if (!declined.includes(key)) { declined.push(key); changed = true; }
      }
      for (const m of all.accepts) {
        const sender = m.parsed ? m.parsed.sender : (m.subject || '').slice('VaultContactAccept: '.length).trim();
        if (!sender || sender === this.email) continue;
        const key = `${sender}|${m.uid}`;
        if (!accepted.includes(key)) { accepted.push(key); changed = true; }
      }
      if (changed) {
        await db.kvSet(this.email || 'anon', 'declined-contacts', JSON.stringify(declined));
        await db.kvSet(this.email || 'anon', 'accepted-contacts', JSON.stringify(accepted));
      }
      await db.kvSet(this.email || 'anon', 'handshake-sweep-done', '1');
    } catch (e) { /* ignore */ }
  }
  async sendContactInvite(email, publicKey) {
    // Письмо-запрос: получатель увидит попап «Принять/Отклонить» и после
    // согласия сохранит наш публичный ключ (контакт появится у обоих).
    // СТЕЛС (21.08, правка юзера): тема ПУСТАЯ — никаких видимых Vault*
    // маркеров в заголовках; тип письма — метка kind внутри base64-тела.
    const name = (await this.getDisplayName()) || this.email;
    const avatar = (await this.getAvatar(this.email)) || '';
    const payload = urlSafeB64({
      kind: 'invite',
      sender: this.email,
      sender_name: name,
      sender_avatar: avatar,
      public_key: publicKey,
    });
    await this.sendEmail('local', { to: email, subject: '', body: payload });
    // Запоминаем, что МЫ пригласили этого отправителя: его accept-письмо
    // будет авто-принято (fetchPendingContactAccepts). Модель Delta Chat.
    await this.addInvitedSender(email);
    return { ok: true, invited: true, email };
  }
  // Единый классификатор handshake-писем (стелс, 21.08): ВСЕ письма ходят с
  // ПУСТОЙ темой, тип письма — метка kind внутри base64-тела. Классифицирует
  // письма один раз за тик поллинга (кэш _handshakeCache сбрасывается в
  // processInvites), чтобы fetch-методы не делали несколько полных IMAP-сканов.
  // Старые письма (до стелс-фикса) распознаются по legacy subject-маркерам.
  // Возвращает { invites, accepts, deletes, groupInvites, groupAccepts } —
  // массивы записей { uid, id, date, folder, subject, parsed|null }.
  // Примечание (22.08): deletes классифицируются для полноты wire-формата,
  // но НЕ обрабатываются — удаление контакта строго локальное (модель DC).
  async fetchAllHandshake() {
    if (this._handshakeCache) return this._handshakeCache;
    const out = { invites: [], accepts: [], deletes: [], groupInvites: [], groupAccepts: [] };
    try {
      const msgs = await this.fetchEmails('local');
      // Кандидаты: пустая тема (новый стелс-формат) ИЛИ legacy-маркер в теме.
      const candidates = msgs.filter(m => {
        const s = m.subject || '';
        return !s
          || s.startsWith('VaultContactInvite: ')
          || s.startsWith('VaultContactAccept: ')
          || s.startsWith('VaultContactDelete: ')
          || s.startsWith('VaultGroupInvite: ')
          || s.startsWith('VaultGroupAccept: ');
      });
      const bodies = await this.batchFetchBodies(candidates);
      for (const m of candidates) {
        const subject = m.subject || '';
        const body = bodies[String(m.uid || m.id)] || '';
        let parsed = null;
        if (body) {
          try { parsed = urlSafeB64Decode(body); } catch (e) { parsed = null; }
        }
        let kind = parsed && parsed.kind || null;
        if (!kind) {
          if (subject.startsWith('VaultContactInvite: ')) kind = 'invite';
          else if (subject.startsWith('VaultContactAccept: ')) kind = 'accept';
          else if (subject.startsWith('VaultContactDelete: ')) kind = 'delete';
          else if (subject.startsWith('VaultGroupInvite: ')) kind = 'group-invite';
          else if (subject.startsWith('VaultGroupAccept: ')) kind = 'group-accept';
        }
        if (!kind) continue;
        const item = {
          uid: m.uid || m.id,
          id: m.uid || m.id,
          date: m.date,
          folder: m.folder || 'INBOX',
          subject,
          parsed,
        };
        if (kind === 'invite') out.invites.push(item);
        else if (kind === 'accept') out.accepts.push(item);
        else if (kind === 'delete') out.deletes.push(item);
        else if (kind === 'group-invite') out.groupInvites.push(item);
        else if (kind === 'group-accept') out.groupAccepts.push(item);
      }
    } catch (e) {
      console.error('fetchAllHandshake failed:', e);
    }
    this._handshakeCache = out;
    return out;
  }
  async fetchPendingContactInvites() {
    const { invites } = await this.fetchAllHandshake();
    const declined = await this.getDeclinedContacts();
    const accepted = await this.getAcceptedContacts();
    const peers = await this.loadPeerKeyEmails();
    const out = [];
    for (const m of invites) {
      const sender = m.parsed ? m.parsed.sender : (m.subject || '').slice('VaultContactInvite: '.length).trim();
      if (!sender || sender === this.email) continue;
      if (declined.includes(`${sender}|${m.uid}`)) continue;
      if (accepted.includes(`${sender}|${m.uid}`)) continue;
      // Примечание: фильтра «удалён МНОЙ/удалил меня» здесь НЕТ — новые
      // приглашения от бывших контактов должны доходить (юзер, 21.08).
      // Старые письма от удалённых контактов помечаются declined/accepted
      // по uid в markContactHandshakeDone() при удалении.
      const parsed = m.parsed || {};
      if (!parsed.sender && !parsed.public_key) continue;
      if (!parsed.public_key) continue;
      await this.saveProfile(sender, parsed.sender_name, parsed.sender_avatar);
      if (peers.has(sender)) continue;
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
  // Пометить ВСЕ старые handshake-письма от email как обработанные
  // (invite → declined, accept → accepted по uid). Вызывается при ЛОКАЛЬНОМ
  // удалении контакта (модель Delta Chat): старые письма не должны воскрешать
  // контакт, а НОВЫЕ приглашения (после удаления) проходят — их uid ещё не помечен.
  async markContactHandshakeDone(email) {
    try {
      // Кэш сбрасываем: метод вызывается из deleteContact вне поллинга,
      // кэш может быть устаревшим (письма пришли после последнего тика).
      this._handshakeCache = null;
      const all = await this.fetchAllHandshake();
      const declined = await this.getDeclinedContacts();
      for (const m of all.invites) {
        const sender = m.parsed ? m.parsed.sender : (m.subject || '').slice('VaultContactInvite: '.length).trim();
        if (sender !== email) continue;
        const key = `${sender}|${m.uid}`;
        if (!declined.includes(key)) {
          declined.push(key);
          await db.kvSet(this.email || 'anon', 'declined-contacts', JSON.stringify(declined));
        }
      }
      const accepted = await this.getAcceptedContacts();
      for (const m of all.accepts) {
        const sender = m.parsed ? m.parsed.sender : (m.subject || '').slice('VaultContactAccept: '.length).trim();
        if (sender !== email) continue;
        const key = `${sender}|${m.uid}`;
        if (!accepted.includes(key)) {
          accepted.push(key);
          await db.kvSet(this.email || 'anon', 'accepted-contacts', JSON.stringify(accepted));
        }
      }
    } catch (e) {
      console.warn('markContactHandshakeDone failed:', e);
    }
  }
  // Батч-фетч тел писем по папкам (один IMAP-вызов на папку) — обёртка над
  // fetchEmailBodies, возвращает {uid: body}. Пустые тела пропускаются.
  async batchFetchBodies(list) {
    const out = {};
    const byFolder = {};
    for (const m of list) {
      const f = m.folder || 'INBOX';
      (byFolder[f] = byFolder[f] || []).push(m);
    }
    for (const [folder, msgs] of Object.entries(byFolder)) {
      try {
        const bodies = await this.fetchEmailBodies(folder, msgs.map(m => m.uid || m.id));
        Object.assign(out, bodies);
      } catch (e) {
        console.warn('[batchFetchBodies] failed folder=' + folder + ' n=' + msgs.length + ' err=' + (e && e.message || e));
      }
    }
    return out;
  }
  async sendContactAccept(email, publicKey) {
    const name = (await this.getDisplayName()) || this.email;
    const avatar = (await this.getAvatar(this.email)) || '';
    const payload = urlSafeB64({
      kind: 'accept',
      sender: this.email,
      sender_name: name,
      sender_avatar: avatar,
      public_key: publicKey,
    });
    await this.sendEmail('local', { to: email, subject: '', body: payload });
    return { ok: true };
  }
  async fetchPendingContactAccepts() {
    const { accepts } = await this.fetchAllHandshake();
    const peers = await this.loadPeerKeyEmails();
    const accepted = await this.getAcceptedContacts();
    const invited = await this.getInvitedSenders();
    const out = [];
    for (const m of accepts) {
      const sender = m.parsed ? m.parsed.sender : (m.subject || '').slice('VaultContactAccept: '.length).trim();
      if (!sender || sender === this.email) continue;
      if (accepted.includes(`${sender}|${m.uid}`)) continue;
      const parsed = m.parsed || {};
      if (!parsed.sender && !parsed.public_key) continue;
      if (!parsed.public_key) continue;
      // МОДЕЛЬ DELTA CHAT (22.08): авто-принятие ТОЛЬКО от отправителей, которых
      // МЫ сами пригласили (invited-senders). Иначе ЛЮБОЕ accept-письмо со своим
      // ключом молча попало бы в контакты без согласия, а СТАРЫЕ accept-письма,
      // обработанные ещё до uid-пометок, «воскрешали» бы удалённый контакт.
      // (Баг v0.1.8: на android появился kmakan без принятия — UID 278,
      // legacy-accept от kmakan без пометки, авто-добавлен.)
      if (!invited.includes(sender)) {
        // Не наше приглашение — tombstone письмо, чтобы не обрабатывалось вечно.
        this.markAcceptedContact(`${sender}|${m.uid}`);
        continue;
      }
      // Профиль/аватар обновляем ВСЕГДА (даже если ключ уже сохранён) —
      // иначе аватар, загруженный после принятия контакта, никогда не дойдёт.
      await this.saveProfile(sender, parsed.sender_name, parsed.sender_avatar);
      if (peers.has(sender)) {
        // Ключ уже сохранён — обновили профиль, пометили письмо, приглашение исполнено.
        this.markAcceptedContact(`${sender}|${m.uid}`);
        await this.removeInvitedSender(sender);
        continue;
      }
      try {
        await invoke('save_peer_key', { email: sender, publicKey: parsed.public_key, label: parsed.sender_name || null });
        // Пометка вечная (как tombstones): без неё после удаления контакта
        // это accept-письмо молча вернёт контакт со старым ключом.
        this.markAcceptedContact(`${sender}|${m.uid}`);
        // Приглашение исполнено — снимаем отправителя из invited.
        await this.removeInvitedSender(sender);
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

  // Инкрементальный фетч: только письма новее per-folder UID-курсоров.
  // Возвращает { messages, cursors }; пустые курсоры = первый полный скан.
  async fetchEmailsIncremental(accountId, cursors = {}) {
    const res = await invoke('email_fetch_incremental', { cursors });
    const mapped = (res && res.messages || []).map(m => ({
      uid: m.id,
      id: m.id,
      from: m.from,
      to: m.to,
      subject: m.subject,
      date: m.date,
      is_read: m.is_read,
      folder: m.folder || 'INBOX',
      message_id: m.message_id || '',
    }));
    return { messages: mapped, cursors: (res && res.cursors) || {} };
  }

  // IMAP IDLE (Фаза 1.5 звонков): серверный push — блокируется до появления
  // нового письма в папке или таймаута. { changed: true } = есть новое.
  async idleWait(timeoutMs = 2000, folder = 'INBOX') {
    return await invoke('email_idle_wait', { folder, timeoutMs });
  }

  // ── Calls (M3, Фаза 2): WebRTC media backend (webrtc-rs) ────────────────
  // startOutgoing → SDP offer (JSON RTCSessionDescription); acceptIncoming →
  // SDP answer; setRemote — вторая половина рукопожатия; close — teardown.
  async mediaStartOutgoing(callId) {
    return await invoke('media_start_outgoing', { callId });
  }
  async mediaAcceptIncoming(callId, offerSdp) {
    return await invoke('media_accept_incoming', { callId, offerSdp });
  }
  async mediaSetRemote(callId, sdp) {
    return await invoke('media_set_remote', { callId, sdp });
  }
  async mediaClose(callId) {
    return await invoke('media_close', { callId });
  }
  async mediaSetMuted(callId, muted) {
    return await invoke('media_set_muted', { callId, muted });
  }
  async mediaSetIceServers(urls) {
    return await invoke('media_set_ice_servers', { urls });
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

  // --- Avatars (данные — sqlite kv_store 'profiles', см. getAvatar ниже) ---
  async uploadAvatar(email, dataUrl) { return this.setAvatar(email, dataUrl); }
  async deleteAvatar(email) { return this.removeAvatar(email); }
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
    const name = (await this.getDisplayName()) || this.email;
    const avatar = (await this.getAvatar(this.email)) || '';
    const payload = urlSafeB64({
      kind: 'group-invite',
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
      group_avatar: (await db.kvGet('anon', 'group-avatar:' + g.id)) || '',
    });
    await this.sendEmail('local', { to: email, subject: '', body: payload });
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
    // Роли нормализуем к модели Admin/Member (legacy Moderator → Member).
    const validRoles = ['Admin', 'Member'];
    const inviteMembers = Array.isArray(payload.members)
      ? payload.members
          .filter(m => m && m.email)
          .map(m => ({ email: m.email, role: m.role === 'Moderator' ? 'Member' : (validRoles.includes(m.role) ? m.role : 'Member') }))
      : null;
    await invoke('groups_import', {
      groupId,
      name: payload.group_name,
      groupKey: payload.group_key,
      sender: payload.sender,
      createdBy: payload.created_by || null,
      members: inviteMembers,
    });
    // Персистим ключ принятого инвайта («group_id|uid»). handledInviteKeys в
    // App.vue — только in-memory и сбрасывается при перезапуске; без этой
    // записи fetchPendingInvites после рестарта снова найдёт письмо-инвайт
    // (оно всё ещё в ящике) и попап согласия всплывёт повторно, даже если
    // группа уже импортирована. Принятые инвайты больше не показываем.
    if (payload.uid != null) {
      const accepted = await this.getAcceptedInvites();
      const akey = `${groupId}|${payload.uid}`;
      if (!accepted.includes(akey)) {
        accepted.push(akey);
        await db.kvSet(this.email || 'anon', 'accepted-invites', JSON.stringify(accepted));
      }
    }
    // Добавляем СЕБЯ как участника (роль Member) — import_group добавляет
    // только отправителя, а принимающий иначе не попадёт в members.
    try {
      await invoke('groups_add_member', { groupId, email: this.email });
    } catch (e) { /* уже участник или временная ошибка — не блокируем */ }
    // Отправляем пригласившему письмо VaultGroupAccept (подтверждение согласия).
    const name = (await this.getDisplayName()) || this.email;
    const avatar = (await this.getAvatar(this.email)) || '';
    const body = urlSafeB64({
      kind: 'group-accept',
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
        await this.sendEmail('local', { to, subject: '', body });
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
    const declined = await this.getDeclinedInvites();
    if (!declined.includes(key)) {
      declined.push(key);
      await db.kvSet(this.email || 'anon', 'declined-invites', JSON.stringify(declined));
    }
    return { ok: true };
  }
  async getDeclinedInvites() {
    try {
      return JSON.parse((await db.kvGet(this.email || 'anon', 'declined-invites')) || '[]');
    } catch (e) {
      return [];
    }
  }
  async getAcceptedInvites() {
    try {
      return JSON.parse((await db.kvGet(this.email || 'anon', 'accepted-invites')) || '[]');
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

  // --- Profile cache (имя/аватар из настроек/инвайтов — sqlite kv_store) ---
  // Один объект {email: {name, avatar}} в kv_store (namespace 'anon'):
  // профиль контакта не зависит от аккаунта (email — ключ). In-memory Map
  // для быстрых повторных чтений (UserAvatar/шапка рендерят часто).
  async getProfilesAll() {
    try {
      return JSON.parse((await db.kvGet('anon', 'profiles')) || '{}');
    } catch (e) {
      return {};
    }
  }
  async saveProfile(email, name, avatar) {
    if (!email) return;
    try {
      const profiles = await this.getProfilesAll();
      const p = profiles[email] || {};
      if (name) p.name = name;
      if (avatar) p.avatar = avatar;
      if (name || avatar) profiles[email] = p;
      await db.kvSet('anon', 'profiles', JSON.stringify(profiles));
      if (avatar) this._avatarCache.set(email, avatar);
    } catch (e) { /* ignore */ }
  }
  async getProfile(email) {
    if (!email) return null;
    if (email === this.email) {
      // Свой профиль = displayName (настройка аккаунта, kv) + аватар из kv.
      return {
        name: (await this.getDisplayName()) || this.email,
        avatar: ((await this.getProfilesAll())[this.email] || {}).avatar || '',
      };
    }
    const profiles = await this.getProfilesAll();
    return profiles[email] || null;
  }
  async getAvatar(email) {
    if (!email) return null;
    if (this._avatarCache.has(email)) return this._avatarCache.get(email);
    const profiles = await this.getProfilesAll();
    const url = (profiles[email] || {}).avatar || null;
    if (url) this._avatarCache.set(email, url);
    return url;
  }
  async setAvatar(email, dataUrl) {
    if (!email) return;
    await this.saveProfile(email, null, dataUrl || undefined);
    if (!dataUrl) this._avatarCache.delete(email);
  }
  async removeAvatar(email) {
    if (!email) return;
    try {
      const profiles = await this.getProfilesAll();
      if (profiles[email]) {
        delete profiles[email].avatar;
        if (!profiles[email].name) delete profiles[email];
      }
      await db.kvSet('anon', 'profiles', JSON.stringify(profiles));
      this._avatarCache.delete(email);
    } catch (e) { /* ignore */ }
  }

  // --- Групповые инвайты: ожидающие подтверждения ---
  async fetchPendingInvites() {
    const { groupInvites } = await this.fetchAllHandshake();
    const declined = await this.getDeclinedInvites();
    const accepted = await this.getAcceptedInvites();
    const out = [];
    for (const m of groupInvites) {
      const parsed = m.parsed || {};
      // Legacy-письма без kind: пробуем распарсить тело (fetchAllHandshake
      // уже сделал это; parsed может быть null, если тело не прочиталось).
      if (!parsed.group_id) {
        console.warn('[invites] unparseable invite body, uid', m.uid);
        continue;
      }
      // Пропускаем, если уже отклонён.
      if (declined.includes(`${parsed.group_id}|${m.uid}`)) continue;
      // Пропускаем, если уже принят (персистится в acceptGroupInvite).
      if (accepted.includes(`${parsed.group_id}|${m.uid}`)) continue;
      try {
        const g = await invoke('groups_get', { groupId: parsed.group_id });
        if (g && (g.created_by === this.email || (g.members || []).some(mm => mm.email === this.email))) {
          continue;
        }
      } catch (e) { /* группа ещё не импортирована */ }
      out.push({
        group_id: parsed.group_id,
        group_name: parsed.group_name,
        group_key_enc: parsed.group_key_enc || null,
        sender_public_key: parsed.sender_public_key || null,
        group_key: parsed.group_key || null,
        sender: parsed.sender,
        sender_name: parsed.sender_name,
        sender_avatar: parsed.sender_avatar,
        created_by: parsed.created_by || null,
        members: Array.isArray(parsed.members) ? parsed.members : null,
        group_avatar: parsed.group_avatar || null,
        uid: m.uid,
        date: m.date,
      });
    }
    return out;
  }

  // --- Групповые accept-письма: добавить принявших участников ---
  async fetchPendingAccepts() {
    const { groupAccepts } = await this.fetchAllHandshake();
    const out = [];
    for (const m of groupAccepts) {
      const payload = m.parsed || {};
      if (!payload.group_id) continue;
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
