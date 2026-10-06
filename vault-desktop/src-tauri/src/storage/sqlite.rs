use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub struct Storage {
    conn: Connection,
}

/// Путь к файлу БД по умолчанию.
/// Same root as history_store: ~/.local/share/com.vault.vault/vault.db
/// (NOT ~/.local/share/vault/ — that dir holds the keystore).
/// Per-HOME isolation works because data_local_dir() resolves
/// under the test HOME (vault-test/<acc>-home) too.
fn default_db_path() -> Result<PathBuf> {
    let home = dirs::data_local_dir().context("Cannot determine local data directory")?;
    Ok(home.join("com.vault.vault").join("vault.db"))
}

#[allow(dead_code)]
impl Storage {
    /// Open or create the local database
    pub fn open(db_path: Option<&PathBuf>) -> Result<Self> {
        let path = match db_path {
            Some(p) => p.clone(),
            None => default_db_path()?,
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

            -- Vault local persistence (durable state, replaces
            -- localStorage/IndexedDB):
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
            -- 6) envelope cache: the fetched mail list per account. Without it
            --    the in-memory list is empty after a restart while UID cursors
            --    are already advanced, so old mails never come back and chats
            --    look empty. Persisting the envelope list keeps cursors and
            --    mails consistent across restarts without a full IMAP rescan.
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

    // ─── Vault persistence ─────────────

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
    /// Полное стирание пользовательских данных
    /// чаты/история/письма/тумбы/кэши/курсоры/kv — вся таблица emails и kv_store.
    /// Схема остаётся (база продолжает работать «с нуля»).
    pub fn wipe_user_data(&self) -> Result<()> {
        for table in [
            "emails",
            "chat_history",
            "tombstones",
            "imap_cursors",
            "body_cache",
            "kv_store",
            "chats",
            "messages",
            "contacts",
            "encryption_keys",
        ] {
            self.conn
                .execute(&format!("DELETE FROM {table}"), [])
                .map_err(|e| anyhow::anyhow!("wipe {table}: {e}"))?;
        }
        Ok(())
    }

    /// Удалить файл БД целиком — путь «Удалить аккаунт» (RuStore §5.4).
    /// Соединения в open_db() короткоживущие (на каждый invoke), но на всякий
    /// случай открываем базу и сразу закрываем — SQLite сбросит WAL в основной
    /// файл. Спутники `-wal`/`-shm` убираем тоже: иначе данные восстанут из wal.
    /// Отсутствующий файл — не ошибка (повторный вызов / чистая установка).
    pub fn delete_database() -> Result<()> {
        let path = default_db_path()?;
        if path.exists() {
            drop(Connection::open(&path)?);
        }
        for f in [
            path.clone(),
            PathBuf::from(format!("{}-wal", path.display())),
            PathBuf::from(format!("{}-shm", path.display())),
        ] {
            match std::fs::remove_file(&f) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }

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

    /// удалить с устройства
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

    // ─── Account namespace (идентичность = fingerprint) ─────────
    //
    // Модель — как в Delta Chat: идентичность аккаунта это fingerprint
    // ПУБЛИЧНОГО КЛЮЧА, а email — только транспорт (куда ходим за письмами).
    // Поэтому namespace строк в sqlite НЕ привязан к адресу: смена почты не
    // должна ни терять историю/тумбстоуны/черновики, ни создавать второе
    // пустое пространство. Старые строки лежат в той же базе — их нужно
    // ОДИН РАЗ перенести (см. migrate_account_namespace).
    //
    // Пустой fp (ключ ещё не загружен / не сгенерирован) → legacy-фallback
    // на email: вход не блокируем, данные не теряем, миграция доделается
    // при следующем вызове, когда ключ уже есть.

    /// Нормализованный namespace аккаунта: fp есть → `fp:<fp>` (lowercase),
    /// нет → email (lowercase).
    pub fn normalize_account(&self, fp: String, email: String) -> Result<String> {
        let fp = fp.trim().to_lowercase();
        if fp.is_empty() {
            return Ok(email.trim().to_lowercase());
        }
        Ok(format!("fp:{}", fp))
    }

    /// Резолв namespace для клиента: fp есть → `fp:<fp>`, нет → email.
    ///
    /// Отдельно от normalize_account: когда fp ПУСТОЙ, неизвестно, какой
    /// именно fp-namespace принадлежит этому email (одна база — много
    /// аккаунтов), поэтому определить «уже мигрирован ли аккаунт» по этому
    /// вызову невозможно. Отдаём email-namespace и НЕ трогаем данные; перенос
    /// выполнит клиент (api.js ensureAccountNamespace), когда ключ загружен.
    pub fn resolve_account(&self, fp: String, email: String) -> Result<String> {
        Ok(self.normalize_account(fp, email)?)
    }

    /// Есть ли хоть одна строка под account (в любой из account-таблиц).
    pub fn account_has_rows(&self, account: &str) -> Result<bool> {
        for table in ACCOUNT_TABLES {
            let sql = format!("SELECT 1 FROM {} WHERE account=?1 LIMIT 1", table.name);
            let mut stmt = self.conn.prepare(&sql)?;
            let mut rows = stmt.query(params![account])?;
            if rows.next()?.is_some() {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Одноразовая миграция namespace email → fp:<fp>: переносит строки из
    /// ВСЕХ таблиц с колонкой `account` (kv_store, chat_history, body_cache,
    /// tombstones, imap_cursors, emails). Конфликт (строка уже есть под fp) →
    /// оставляем новую. Идемпотентно: повторный вызов ничего не делает.
    ///
    /// Одна транзакция на все таблицы: откат при ошибке не оставляет наполовину
    /// перенесённый аккаунт. Таблицы БЕЗ колонки account (users, chats, messages,
    /// contacts, encryption_keys, settings) не затрагиваются.
    pub fn migrate_account_namespace(
        &self,
        old_account: &str,
        new_account: &str,
    ) -> Result<MigrationReport> {
        let old_account = old_account.trim().to_lowercase();
        let new_account = new_account.trim().to_lowercase();
        let mut report = MigrationReport::default();

        // No-op: пустые/глобальные/совпадающие namespace. 'anon' — настройки
        // приложения, 'local' — курсоры/конверты IMAP-транспорта: их перенос
        // в fp-namespace сломал бы глобальные настройки.
        let is_global = |a: &str| a.is_empty() || a == "anon" || a == "local";
        if is_global(&old_account) || is_global(&new_account) || old_account == new_account {
            return Ok(report);
        }

        self.conn.execute("BEGIN IMMEDIATE", [])?;
        match self.migrate_account_tx(&old_account, &new_account, &mut report) {
            Ok(()) => {
                self.conn.execute("COMMIT", [])?;
                Ok(report)
            }
            Err(e) => {
                let _ = self.conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// Тело миграции — вызывается внутри уже открытой транзакции.
    fn migrate_account_tx(
        &self,
        old_account: &str,
        new_account: &str,
        report: &mut MigrationReport,
    ) -> Result<()> {
        for table in ACCOUNT_TABLES {
            let count_sql = format!("SELECT COUNT(*) FROM {} WHERE account=?1", table.name);
            let n: i64 = self
                .conn
                .query_row(&count_sql, params![old_account], |r| r.get(0))?;
            if n == 0 {
                continue;
            }
            let columns = table.columns.join(", ");
            let mut selects: Vec<String> = Vec::with_capacity(table.columns.len());
            for col in table.columns {
                if *col == "account" {
                    selects.push("?2".to_string());
                } else {
                    selects.push((*col).to_string());
                }
            }
            let select_list = selects.join(", ");
            // INSERT OR IGNORE: строка, уже существующая под новым namespace,
            // НЕ перетирается (новое значение авторитетнее старого).
            let insert_sql = format!(
                "INSERT OR IGNORE INTO {} ({}) SELECT {} FROM {} WHERE account=?1",
                table.name, columns, select_list, table.name
            );
            self.conn
                .execute(&insert_sql, params![old_account, new_account])
                .with_context(|| format!("migrate {}: copy rows", table.name))?;
            // Старые строки удаляем ВСЕГДА: иначе после переноса остался бы
            // дубль, а при конфликте — мёртвая копия под старым адресом.
            let delete_sql = format!("DELETE FROM {} WHERE account=?1", table.name);
            self.conn
                .execute(&delete_sql, params![old_account])
                .with_context(|| format!("migrate {}: delete old rows", table.name))?;
            report.set(table.name, n as usize);
            report.total += n as usize;
        }
        Ok(())
    }
}

/// Таблицы с колонкой `account` — единственные, которые участвуют в миграции
/// namespace. Список РОВНО тот, что создаётся в init_tables.
static ACCOUNT_TABLES: &[AccountTable] = &[
    AccountTable { name: "kv_store", columns: &["account", "key", "value"] },
    AccountTable {
        name: "chat_history",
        columns: &["account", "chat_key", "messages_json", "updated_at"],
    },
    AccountTable { name: "body_cache", columns: &["account", "cache_key", "body"] },
    AccountTable { name: "tombstones", columns: &["account", "msg_id", "mid"] },
    AccountTable { name: "imap_cursors", columns: &["account", "folder", "uid"] },
    AccountTable {
        name: "emails",
        columns: &[
            "account",
            "uid",
            "folder",
            "from_addr",
            "to_addr",
            "subject",
            "date",
            "is_read",
            "message_id",
        ],
    },
];

struct AccountTable {
    name: &'static str,
    columns: &'static [&'static str],
}

/// Отчёт об одноразовом переносе namespace (для лога на клиенте).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MigrationReport {
    pub kv_store: usize,
    pub chat_history: usize,
    pub body_cache: usize,
    pub tombstones: usize,
    pub imap_cursors: usize,
    pub emails: usize,
    pub total: usize,
}

impl MigrationReport {
    fn set(&mut self, table: &str, n: usize) {
        match table {
            "kv_store" => self.kv_store = n,
            "chat_history" => self.chat_history = n,
            "body_cache" => self.body_cache = n,
            "tombstones" => self.tombstones = n,
            "imap_cursors" => self.imap_cursors = n,
            "emails" => self.emails = n,
            _ => {}
        }
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
#[allow(dead_code)]
pub struct StorageStats {
    pub chats: i64,
    pub messages: i64,
    pub contacts: i64,
    pub unread: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Каждый тест открывает СВОЮ базу во временном каталоге. Storage::open(None)
    /// — это живая ~/.local/share/com.vault.vault/vault.db, её не трогаем.
    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn test_storage() -> Storage {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("vault-ns-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        Storage::open(Some(&path)).expect("open test db")
    }

    fn put_row(s: &Storage, table: &str, cols: &[&str], vals: &[&str]) {
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table,
            cols.join(", "),
            vec!["?"; cols.len()].join(", ")
        );
        let params: Vec<&dyn rusqlite::ToSql> =
            vals.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        s.conn.execute(&sql, params.as_slice()).expect("insert");
    }

    fn count_where(s: &Storage, table: &str, account: &str) -> i64 {
        let sql = format!("SELECT COUNT(*) FROM {} WHERE account=?1", table);
        s.conn
            .query_row(&sql, params![account], |r| r.get(0))
            .expect("count")
    }

    fn put_email(s: &Storage, account: &str, uid: &str, subject: &str) {
        put_row(
            s,
            "emails",
            &[
                "account", "uid", "folder", "from_addr", "to_addr", "subject", "date",
                "is_read", "message_id",
            ],
            &[
                account, uid, "INBOX", "peer@x.com", account, subject,
                "Mon, 1 Jan 2026 00:00:00 +0000", "0", "<mid@x>",
            ],
        );
    }

    // ── 1) normalize_account ──────────────────────────────────
    #[test]
    fn normalize_account_fp_and_email() {
        let s = test_storage();
        // fp → fp:<lowercase-fp>, обрезка пробелов и приведение регистра.
        assert_eq!(
            s.normalize_account("  ABCdef123  ".into(), "User@X.com".into()).unwrap(),
            "fp:abcdef123"
        );
        // Пустой fp (ключ не загружен) → legacy-фолбэк на email.
        assert_eq!(
            s.normalize_account("".into(), "  User@X.com ".into()).unwrap(),
            "user@x.com"
        );
        // Только пробелы у fp — тоже пусто.
        assert_eq!(s.normalize_account("   ".into(), "a@b.c".into()).unwrap(), "a@b.c");
        // Email есть, но fp важнее: идентичность = ключ, почта = транспорт.
        assert_eq!(
            s.normalize_account("deadbeef".into(), "a@b.c".into()).unwrap(),
            "fp:deadbeef"
        );
    }

    // ── 2) resolve_account ────────────────────────────────────
    #[test]
    fn resolve_account_fp_and_email() {
        let s = test_storage();
        assert_eq!(
            s.resolve_account("ABC123".into(), "user@x.com".into()).unwrap(),
            "fp:abc123"
        );
        assert_eq!(
            s.resolve_account("".into(), "User@X.com".into()).unwrap(),
            "user@x.com"
        );
    }

    // ── 3) перенос строки из КАЖДОЙ из 6 таблиц ───────────────
    #[test]
    fn migrate_moves_row_in_every_account_table() {
        let s = test_storage();
        let old = "old@x.com";
        put_row(&s, "kv_store", &["account", "key", "value"], &[old, "drafts", "v1"]);
        put_row(
            &s,
            "chat_history",
            &["account", "chat_key", "messages_json", "updated_at"],
            &[old, "peer@x.com", "[]", "2026-01-01T00:00:00Z"],
        );
        put_row(&s, "body_cache", &["account", "cache_key", "body"], &[old, "INBOX:7", "body"]);
        put_row(&s, "tombstones", &["account", "msg_id", "mid"], &[old, "m1", ""]);
        put_row(&s, "imap_cursors", &["account", "folder", "uid"], &[old, "INBOX", "42"]);
        put_email(&s, old, "7", "hi");

        let ns = "fp:abc";
        let rep = s.migrate_account_namespace(old, ns).unwrap();

        assert_eq!(rep.kv_store, 1);
        assert_eq!(rep.chat_history, 1);
        assert_eq!(rep.body_cache, 1);

        assert_eq!(rep.tombstones, 1);
        assert_eq!(rep.imap_cursors, 1);
        assert_eq!(rep.emails, 1);
        assert_eq!(rep.total, 6);

        // Перенесены ЗНАЧЕНИЯ, а не только PK; старых строк не осталось.
        assert_eq!(s.kv_get(ns, "drafts").unwrap().as_deref(), Some("v1"));
        assert_eq!(s.body_cache_get(ns, "INBOX:7").unwrap().as_deref(), Some("body"));
        assert!(s.load_history(ns, "peer@x.com").unwrap().is_some());
        assert_eq!(s.load_cursors(ns).unwrap().get("INBOX"), Some(&42));
        assert_eq!(s.load_tombstones(ns).unwrap().len(), 1);
        let mails = s.load_emails(ns).unwrap();
        assert_eq!(mails.len(), 1);
        assert_eq!(mails[0].subject, "hi");
        for t in ["kv_store", "chat_history", "body_cache", "tombstones", "imap_cursors", "emails"] {
            assert_eq!(count_where(&s, t, old), 0, "{} still has old rows", t);
        }
    }

    // ── 4) идемпотентность ────────────────────────────────────
    #[test]
    fn migrate_is_idempotent() {
        let s = test_storage();
        let old = "old@x.com";
        let ns = "fp:abc";
        put_row(&s, "kv_store", &["account", "key", "value"], &[old, "drafts", "v1"]);
        put_row(
            &s,
            "chat_history",
            &["account", "chat_key", "messages_json", "updated_at"],
            &[old, "peer@x.com", "[]", "2026-01-01T00:00:00Z"],
        );

        let first = s.migrate_account_namespace(old, ns).unwrap();
        assert_eq!(first.total, 2);
        let second = s.migrate_account_namespace(old, ns).unwrap();
        assert_eq!(second.total, 0);
        assert_eq!(second.kv_store, 0);
        assert_eq!(second.chat_history, 0);

        // Ни дублей, ни потерь.
        assert_eq!(count_where(&s, "kv_store", ns), 1);
        assert_eq!(count_where(&s, "chat_history", ns), 1);
        assert_eq!(s.kv_get(ns, "drafts").unwrap().as_deref(), Some("v1"));
    }

    // ── 5) конфликт по PK: строка под fp уже есть ─────────────
    #[test]
    fn migrate_conflict_keeps_existing_fp_row() {
        let s = test_storage();
        let old = "old@x.com";
        let ns = "fp:abc";
        put_row(&s, "kv_store", &["account", "key", "value"], &[old, "drafts", "OLD"]);
        put_row(&s, "kv_store", &["account", "key", "value"], &[ns, "drafts", "NEW"]);
        put_row(&s, "body_cache", &["account", "cache_key", "body"], &[old, "INBOX:7", "OLD"]);
        put_row(&s, "body_cache", &["account", "cache_key", "body"], &[ns, "INBOX:7", "NEW"]);

        let rep = s.migrate_account_namespace(old, ns).unwrap();
        assert_eq!(rep.total, 2);

        // Существующее значение под fp НЕ перетёрто, старая строка удалена.
        assert_eq!(s.kv_get(ns, "drafts").unwrap().as_deref(), Some("NEW"));
        assert_eq!(s.body_cache_get(ns, "INBOX:7").unwrap().as_deref(), Some("NEW"));
        assert_eq!(count_where(&s, "kv_store", old), 0);
        assert_eq!(count_where(&s, "body_cache", old), 0);
        assert_eq!(count_where(&s, "kv_store", ns), 1);
        assert_eq!(count_where(&s, "body_cache", ns), 1);
    }

    // ── 6) одинаковые аккаунты → no-op ───────────────────────
    #[test]
    fn migrate_same_account_is_noop() {
        let s = test_storage();
        let acc = "user@x.com";
        put_row(&s, "kv_store", &["account", "key", "value"], &[acc, "drafts", "v1"]);
        let rep = s.migrate_account_namespace(acc, acc).unwrap();
        assert_eq!(rep.total, 0);
        assert_eq!(count_where(&s, "kv_store", acc), 1);
        // Регистр/пробелы нормализуются — это тот же namespace.
        let rep2 = s.migrate_account_namespace(" User@X.com ", "USER@x.com").unwrap();
        assert_eq!(rep2.total, 0);
        assert_eq!(count_where(&s, "kv_store", "user@x.com"), 1);
    }

    // ── 7) пустой аккаунт / 'anon' → безопасный no-op ──────────
    #[test]
    fn migrate_empty_and_global_namespace_is_noop() {
        let s = test_storage();
        put_row(&s, "kv_store", &["account", "key", "value"], &["anon", "eco-mode", "1"]);
        put_row(&s, "kv_store", &["account", "key", "value"], &["user@x.com", "drafts", "v1"]);

        for (from, to) in [
            ("", "fp:abc"),
            ("   ", "fp:abc"),
            ("anon", "fp:abc"),
            ("user@x.com", ""),
            ("user@x.com", "anon"),
            ("user@x.com", "local"),
        ] {
            let rep = s.migrate_account_namespace(from, to).unwrap();
            assert_eq!(rep.total, 0, "no-op expected for {:?} -> {:?}", from, to);
        }
        // Ничего не потеряно и ничего не перенесено.
        assert_eq!(count_where(&s, "kv_store", "anon"), 1);
        assert_eq!(count_where(&s, "kv_store", "user@x.com"), 1);
        assert_eq!(count_where(&s, "kv_store", "fp:abc"), 0);
    }

    // ── account_has_rows ──────────────────────────────────────
    #[test]
    fn account_has_rows_checks_all_tables() {
        let s = test_storage();
        assert!(!s.account_has_rows("old@x.com").unwrap());
        put_email(&s, "old@x.com", "1", "s");
        assert!(s.account_has_rows("old@x.com").unwrap());
        assert!(!s.account_has_rows("fp:zzz").unwrap());
    }

    // ── Таблицы без колонки account не затрагиваются ───────────
    #[test]
    fn migrate_does_not_touch_tables_without_account_column() {
        let s = test_storage();
        s.conn
            .execute(
                "INSERT INTO users (id, email, username, created_at, is_self) VALUES ('u1','old@x.com','n','t',1)",
                [],
            )
            .unwrap();
        s.conn
            .execute("INSERT INTO settings (key, value) VALUES ('k','v')", [])
            .unwrap();
        let rep = s.migrate_account_namespace("old@x.com", "fp:abc").unwrap();
        assert_eq!(rep.total, 0);
        let email: String = s
            .conn
            .query_row("SELECT email FROM users WHERE id='u1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(email, "old@x.com");
        let val: String = s
            .conn
            .query_row("SELECT value FROM settings WHERE key='k'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(val, "v");
    }
}
