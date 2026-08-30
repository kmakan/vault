use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct Storage {
    conn: Connection,
}

impl Storage {
    /// Open or create the local database
    pub fn open(db_path: Option<&PathBuf>) -> Result<Self> {
        let path = match db_path {
            Some(p) => p.clone(),
            None => {
                let home =
                    dirs::data_local_dir().context("Cannot determine local data directory")?;
                // Same root as history_store: ~/.local/share/com.vault.vault/vault.db
                // (NOT ~/.local/share/vault/ — that dir holds the keystore).
                // Per-HOME isolation works because data_local_dir() resolves
                // under the test HOME (vault-test/<acc>-home) too.
                home.join("com.vault.vault").join("vault.db")
            }
        };

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&path)
            .with_context(|| format!("Failed to open database at {:?}", path))?;

        // Enable WAL mode for better concurrent performance
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        let storage = Self { conn };
        storage.init_tables()?;
        Ok(storage)
    }

    fn init_tables(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                username TEXT NOT NULL,
                created_at TEXT NOT NULL,
                is_self INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                user1_id TEXT NOT NULL,
                user2_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                sender_id TEXT NOT NULL,
                chat_id TEXT,
                group_id TEXT,
                subject TEXT,
                content TEXT,
                content_type TEXT DEFAULT 'text',
                is_read INTEGER NOT NULL DEFAULT 0,
                is_sent INTEGER NOT NULL DEFAULT 0,
                sent_at TEXT,
                received_at TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (chat_id) REFERENCES chats(id)
            );

            CREATE TABLE IF NOT EXISTS contacts (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                contact_user_id TEXT NOT NULL,
                display_name TEXT,
                added_at TEXT NOT NULL,
                UNIQUE(user_id, contact_user_id)
            );

            CREATE TABLE IF NOT EXISTS encryption_keys (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                key_type TEXT NOT NULL,
                public_key TEXT NOT NULL,
                private_key TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
            CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id);
            CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

            -- Vault local persistence (Delta Chat-style disk DB, replaces
            -- localStorage/IndexedDB for durable state):
            -- 1) chat history — the single source of truth for chats
            CREATE TABLE IF NOT EXISTS chat_history (
                account TEXT NOT NULL,
                chat_key TEXT NOT NULL,
                messages_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (account, chat_key)
            );
            -- 2) tombstones — deleted messages never resurrect. msg_id = local
            --    message id (mid='' for pure Message-ID entries), mid = mail
            --    Message-ID (rfc724_mid analog, msg_id='' for mid-only entries).
            CREATE TABLE IF NOT EXISTS tombstones (
                account TEXT NOT NULL,
                msg_id TEXT NOT NULL DEFAULT '',
                mid TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (account, msg_id, mid)
            );
            -- 3) IMAP UID cursors — per-account per-folder high-water marks
            CREATE TABLE IF NOT EXISTS imap_cursors (
                account TEXT NOT NULL,
                folder TEXT NOT NULL,
                uid INTEGER NOT NULL,
                PRIMARY KEY (account, folder)
            );
            -- 4) encrypted mail body cache (can reach several MB — must NOT
            --    live in localStorage, which caps at ~5 MB)
            CREATE TABLE IF NOT EXISTS body_cache (
                account TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                body TEXT NOT NULL,
                PRIMARY KEY (account, cache_key)
            );
            -- 5) generic per-account key/value (edits, reactions, pinned,
            --    avatars, profiles, accepted/declined invites, ...)
            CREATE TABLE IF NOT EXISTS kv_store (
                account TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (account, key)
            );
            -- 6) envelope cache (Delta Chat-style): the fetched mail list per
            --    account. this.emails is in-memory only — on restart it was
            --    empty while UID cursors were already advanced, so old mails
            --    (below the cursor) never came back and chats looked empty
            --    (20.08 icemaksim: «сообщение не появилось»). Persisting the
            --    envelope list keeps cursors and mails consistent across
            --    restarts without a full IMAP rescan.
            CREATE TABLE IF NOT EXISTS emails (
                account TEXT NOT NULL,
                uid TEXT NOT NULL,
                folder TEXT NOT NULL,
                from_addr TEXT NOT NULL DEFAULT '',
                to_addr TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL DEFAULT '',
                date TEXT NOT NULL DEFAULT '',
                is_read INTEGER NOT NULL DEFAULT 0,
                message_id TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (account, folder, uid)
            );
            ",
        )?;
        Ok(())
    }

    // ─── Users ───────────────────────────────────────────────

    pub fn save_user(&self, user: &UserRecord) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO users (id, email, username, created_at, is_self) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![user.id, user.email, user.username, user.created_at, user.is_self],
        )?;
        Ok(())
    }

    pub fn get_user(&self, id: &str) -> Result<Option<UserRecord>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, email, username, created_at, is_self FROM users WHERE id = ?1")?;
        let mut rows = stmt.query_map(params![id], |row| {
            Ok(UserRecord {
                id: row.get(0)?,
                email: row.get(1)?,
                username: row.get(2)?,
                created_at: row.get(3)?,
                is_self: row.get(4)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    pub fn get_self_user(&self) -> Result<Option<UserRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, email, username, created_at, is_self FROM users WHERE is_self = 1 LIMIT 1",
        )?;
        let mut rows = stmt.query_map([], |row| {
            Ok(UserRecord {
                id: row.get(0)?,
                email: row.get(1)?,
                username: row.get(2)?,
                created_at: row.get(3)?,
                is_self: row.get(4)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    // ─── Chats ───────────────────────────────────────────────

    pub fn save_chat(&self, chat: &ChatRecord) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO chats (id, user1_id, user2_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                chat.id,
                chat.user1_id,
                chat.user2_id,
                chat.created_at,
                chat.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn list_chats(&self) -> Result<Vec<ChatRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, user1_id, user2_id, created_at, updated_at FROM chats ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ChatRecord {
                id: row.get(0)?,
                user1_id: row.get(1)?,
                user2_id: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ─── Messages ────────────────────────────────────────────

    pub fn save_message(&self, msg: &MessageRecord) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO messages (id, sender_id, chat_id, group_id, subject, content, content_type, is_read, is_sent, sent_at, received_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                msg.id,
                msg.sender_id,
                msg.chat_id,
                msg.group_id,
                msg.subject,
                msg.content,
                msg.content_type,
                msg.is_read,
                msg.is_sent,
                msg.sent_at,
                msg.received_at,
                msg.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_messages(&self, chat_id: &str, limit: i64) -> Result<Vec<MessageRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, sender_id, chat_id, group_id, subject, content, content_type, is_read, is_sent, sent_at, received_at, created_at FROM messages WHERE chat_id = ?1 ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![chat_id, limit], |row| {
            Ok(MessageRecord {
                id: row.get(0)?,
                sender_id: row.get(1)?,
                chat_id: row.get(2)?,
                group_id: row.get(3)?,
                subject: row.get(4)?,
                content: row.get(5)?,
                content_type: row.get(6)?,
                is_read: row.get(7)?,
                is_sent: row.get(8)?,
                sent_at: row.get(9)?,
                received_at: row.get(10)?,
                created_at: row.get(11)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn mark_message_read(&self, id: &str) -> Result<()> {
        self.conn
            .execute("UPDATE messages SET is_read = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ─── Contacts ────────────────────────────────────────────

    pub fn save_contact(&self, contact: &ContactRecord) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO contacts (id, user_id, contact_user_id, display_name, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                contact.id,
                contact.user_id,
                contact.contact_user_id,
                contact.display_name,
                contact.added_at
            ],
        )?;
        Ok(())
    }

    pub fn list_contacts(&self, user_id: &str) -> Result<Vec<ContactRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, user_id, contact_user_id, display_name, added_at FROM contacts WHERE user_id = ?1 ORDER BY added_at DESC",
        )?;
        let rows = stmt.query_map(params![user_id], |row| {
            Ok(ContactRecord {
                id: row.get(0)?,
                user_id: row.get(1)?,
                contact_user_id: row.get(2)?,
                display_name: row.get(3)?,
                added_at: row.get(4)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // ─── Encryption Keys ─────────────────────────────────────

    pub fn save_key(&self, key: &KeyRecord) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO encryption_keys (id, user_id, key_type, public_key, private_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                key.id,
                key.user_id,
                key.key_type,
                key.public_key,
                key.private_key,
                key.created_at
            ],
        )?;
        Ok(())
    }

    pub fn get_private_key(&self, user_id: &str, key_type: &str) -> Result<Option<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT private_key FROM encryption_keys WHERE user_id = ?1 AND key_type = ?2 LIMIT 1",
        )?;
        let mut rows = stmt.query_map(params![user_id, key_type], |row| row.get(0))?;
        Ok(rows.next().transpose()?)
    }

    // ─── Settings ────────────────────────────────────────────

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM settings WHERE key = ?1")?;
        let mut rows = stmt.query_map(params![key], |row| row.get(0))?;
        Ok(rows.next().transpose()?)
    }

    // ─── Stats ───────────────────────────────────────────────

    pub fn stats(&self) -> Result<StorageStats> {
        let chats: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM chats", [], |row| row.get(0))?;
        let messages: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
        let contacts: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM contacts", [], |row| row.get(0))?;
        let unread: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE is_read = 0",
            [],
            |row| row.get(0),
        )?;
        Ok(StorageStats {
            chats,
            messages,
            contacts,
            unread,
        })
    }

    // ─── Vault persistence (Delta Chat-style disk DB) ─────────────

    // Chat history: full JSON dump per (account, chat_key). Atomic upsert.
    pub fn save_history(&self, account: &str, chat_key: &str, messages_json: &str) -> Result<()> {
        let ts = chrono::Utc::now().to_rfc3339();
        self.conn.execute(
        "INSERT INTO chat_history (account, chat_key, messages_json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(account, chat_key) DO UPDATE SET messages_json=excluded.messages_json, updated_at=excluded.updated_at",
        params![account, chat_key, messages_json, ts],
    )?;
        Ok(())
    }

    pub fn load_history(&self, account: &str, chat_key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT messages_json FROM chat_history WHERE account=?1 AND chat_key=?2")?;
        let mut rows = stmt.query_map(params![account, chat_key], |row| row.get(0))?;
        Ok(rows.next().transpose()?)
    }

    pub fn clear_history(&self, account: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM chat_history WHERE account=?1",
            params![account],
        )?;
        Ok(())
    }

    // Tombstones: deleted messages must never resurrect (DC rfc724_mid analog).
    pub fn add_tombstone(&self, account: &str, msg_id: &str, mid: &str) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO tombstones (account, msg_id, mid) VALUES (?1, ?2, ?3)",
            params![account, msg_id, mid],
        )?;
        Ok(())
    }

    pub fn load_tombstones(&self, account: &str) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT msg_id, mid FROM tombstones WHERE account=?1")?;
        let rows = stmt.query_map(params![account], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn clear_tombstones(&self, account: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM tombstones WHERE account=?1", params![account])?;
        Ok(())
    }

    // IMAP UID cursors: per-account high-water marks; an empty fetch must not
    // advance a cursor (throttling would poison the folder).
    pub fn save_cursors(&self, account: &str, cursors_json: &str) -> Result<()> {
        let parsed: HashMap<String, u32> = serde_json::from_str(cursors_json).unwrap_or_default();
        for (folder, uid) in parsed {
            self.conn.execute(
                "INSERT INTO imap_cursors (account, folder, uid) VALUES (?1, ?2, ?3)
             ON CONFLICT(account, folder) DO UPDATE SET uid=excluded.uid",
                params![account, folder, uid],
            )?;
        }
        Ok(())
    }

    pub fn load_cursors(&self, account: &str) -> Result<HashMap<String, u32>> {
        let mut stmt = self
            .conn
            .prepare("SELECT folder, uid FROM imap_cursors WHERE account=?1")?;
        let rows = stmt.query_map(params![account], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    // Body cache: encrypted mail bodies by "folder:uid". Can grow to several MB,
    // must NOT live in localStorage (5 MB cap).
    pub fn body_cache_set(&self, account: &str, cache_key: &str, body: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO body_cache (account, cache_key, body) VALUES (?1, ?2, ?3)
         ON CONFLICT(account, cache_key) DO UPDATE SET body=excluded.body",
            params![account, cache_key, body],
        )?;
        Ok(())
    }

    pub fn body_cache_get(&self, account: &str, cache_key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT body FROM body_cache WHERE account=?1 AND cache_key=?2")?;
        let mut rows = stmt.query_map(params![account, cache_key], |row| row.get(0))?;
        Ok(rows.next().transpose()?)
    }

    pub fn body_cache_clear(&self, account: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM body_cache WHERE account=?1", params![account])?;
        Ok(())
    }

    pub fn body_cache_load_all(&self, account: &str) -> Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT cache_key, body FROM body_cache WHERE account=?1")?;
        let rows = stmt.query_map(params![account], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    /// N6 (28.08, паритет Delta Chat «Автоочистка»): удалить с устройства
    /// перечисленные письма. Ключи — JSON-массив "folder:uid" (список считает
    /// фронт через new Date(): колонка date — сырой заголовок Date (RFC 2822),
    /// лексикографическое сравнение с ISO в SQL НЕРАБОТО, поэтому даты не
    /// сравниваем здесь). Чистит три слоя:
    ///  - body_cache (тела) по ключу;
    ///  - emails (конверты) по (folder, uid);
    ///  - kv_store chat-cache:* — сбрасываем полностью (пересоберётся из emails;
    ///    выборочная чистка по ts внутри JSON не стоит своей сложности).
    /// Возвращает число удалённых тел. IMAP-курсоры НЕ трогаем: письма с сервера
    /// не удаляются, при возврате в чат они догрузятся по UID (модель DC
    /// «удалять с устройства», а не «удалять везде»).
    pub fn autoclean_purge(&self, account: &str, keys_json: &str) -> Result<usize> {
        let keys: Vec<String> = serde_json::from_str(keys_json).unwrap_or_default();
        let mut deleted = 0usize;
        for k in &keys {
            let (folder, uid) = match k.split_once(':') {
                Some((f, u)) => (f.to_string(), u.to_string()),
                None => continue,
            };
            deleted += self.conn.execute(
                "DELETE FROM body_cache WHERE account=?1 AND cache_key=?2",
                params![account, k],
            )?;
            self.conn.execute(
                "DELETE FROM emails WHERE account=?1 AND folder=?2 AND uid=?3",
                params![account, folder, uid],
            )?;
        }
        if !keys.is_empty() {
            self.conn.execute(
                "DELETE FROM kv_store WHERE account=?1 AND key LIKE 'chat-cache:%'",
                params![account],
            )?;
        }
        Ok(deleted)
    }

    // Generic per-account key/value store (edits, reactions, pinned, avatars...).
    pub fn kv_set(&self, account: &str, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO kv_store (account, key, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(account, key) DO UPDATE SET value=excluded.value",
            params![account, key, value],
        )?;
        Ok(())
    }

    pub fn kv_get(&self, account: &str, key: &str) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM kv_store WHERE account=?1 AND key=?2")?;
        let mut rows = stmt.query_map(params![account, key], |row| row.get(0))?;
        Ok(rows.next().transpose()?)
    }

    pub fn kv_delete(&self, account: &str, key: &str) -> Result<()> {
        self.conn.execute(
            "DELETE FROM kv_store WHERE account=?1 AND key=?2",
            params![account, key],
        )?;
        Ok(())
    }

    pub fn kv_get_all(&self) -> Result<Vec<(String, String, String)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT account, key, value FROM kv_store")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn kv_set_all(&self, entries: &[(String, String, String)]) -> Result<()> {
        self.conn.execute("DELETE FROM kv_store", [])?;
        self.conn.execute("BEGIN TRANSACTION", [])?;
        for (account, key, value) in entries {
            self.conn.execute(
                "INSERT INTO kv_store (account, key, value) VALUES (?1, ?2, ?3)",
                params![account, key, value],
            )?;
        }
        self.conn.execute("COMMIT", [])?;
        Ok(())
    }

    // Email envelope cache: persists this.emails across restarts so UID cursors
    // and the mail list stay consistent (no full IMAP rescan needed).
    pub fn save_emails(&self, account: &str, emails_json: &str) -> Result<()> {
        let parsed: Vec<EmailRow> = serde_json::from_str(emails_json).unwrap_or_default();
        let mut stmt = self.conn.prepare(
        "INSERT OR REPLACE INTO emails (account, uid, folder, from_addr, to_addr, subject, date, is_read, message_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
    )?;
        for e in parsed {
            stmt.execute(params![
                account,
                e.uid,
                e.folder,
                e.from,
                e.to,
                e.subject,
                e.date,
                e.is_read as i32,
                e.message_id
            ])?;
        }
        Ok(())
    }

    pub fn load_emails(&self, account: &str) -> Result<Vec<EmailRow>> {
        let mut stmt = self.conn.prepare(
        "SELECT uid, folder, from_addr, to_addr, subject, date, is_read, message_id FROM emails WHERE account=?1 ORDER BY date DESC LIMIT 2000"
    )?;
        let rows = stmt.query_map(params![account], |row| {
            Ok(EmailRow {
                uid: row.get(0)?,
                folder: row.get(1)?,
                from: row.get(2)?,
                to: row.get(3)?,
                subject: row.get(4)?,
                date: row.get(5)?,
                is_read: row.get::<_, i32>(6)? != 0,
                message_id: row.get(7)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn clear_emails(&self, account: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM emails WHERE account=?1", params![account])?;
        Ok(())
    }
}

// ─── Data Types ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmailRow {
    pub uid: String,
    pub folder: String,
    pub from: String,
    pub to: String,
    pub subject: String,
    pub date: String,
    pub is_read: bool,
    pub message_id: String,
}
pub struct UserRecord {
    pub id: String,
    pub email: String,
    pub username: String,
    pub created_at: String,
    pub is_self: bool,
}

#[derive(Debug, Clone)]
pub struct ChatRecord {
    pub id: String,
    pub user1_id: String,
    pub user2_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct MessageRecord {
    pub id: String,
    pub sender_id: String,
    pub chat_id: Option<String>,
    pub group_id: Option<String>,
    pub subject: Option<String>,
    pub content: Option<String>,
    pub content_type: Option<String>,
    pub is_read: bool,
    pub is_sent: bool,
    pub sent_at: Option<String>,
    pub received_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct ContactRecord {
    pub id: String,
    pub user_id: String,
    pub contact_user_id: String,
    pub display_name: Option<String>,
    pub added_at: String,
}

#[derive(Debug, Clone)]
pub struct KeyRecord {
    pub id: String,
    pub user_id: String,
    pub key_type: String,
    pub public_key: String,
    pub private_key: Option<String>,
    pub created_at: String,
}

#[derive(Debug)]
pub struct StorageStats {
    pub chats: i64,
    pub messages: i64,
    pub contacts: i64,
    pub unread: i64,
}
