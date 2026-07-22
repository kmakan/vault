use anyhow::{Context, Result};
use rusqlite::{params, Connection};
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
                home.join("vault").join("vault.db")
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
}

// ─── Data Types ──────────────────────────────────────────────

#[derive(Debug, Clone)]
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
