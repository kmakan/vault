use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Default path for the contacts file
const CONTACTS_FILE: &str = "contacts.json";
const CONTACTS_DIR: &str = ".vault";

// ─── Contact ────────────────────────────────────────────────────────────────

/// A Vault contact — stores identity, key material, and verification state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Contact {
    pub email: String,
    pub name: String,
    pub public_key: String,
    pub fingerprint: String,
    pub added_at: String,
    pub last_seen: Option<String>,
    pub last_verified: Option<String>,
    pub is_verified: bool,
    pub notes: String,
    pub groups: Vec<String>,
}

impl Contact {
    /// Create a new contact from email, name, and a hex-encoded public key.
    /// The fingerprint is derived via SHA-256 of the key bytes.
    pub fn new(email: &str, name: &str, public_key: &str) -> Self {
        let fingerprint = Self::compute_fingerprint(public_key);
        Self {
            email: email.to_string(),
            name: name.to_string(),
            public_key: public_key.to_string(),
            fingerprint,
            added_at: chrono::Utc::now().to_rfc3339(),
            last_seen: None,
            last_verified: None,
            is_verified: false,
            notes: String::new(),
            groups: Vec::new(),
        }
    }

    /// Create a contact without a public key (for address-book-only entries).
    pub fn without_key(email: &str, name: &str) -> Self {
        Self {
            email: email.to_string(),
            name: name.to_string(),
            public_key: String::new(),
            fingerprint: String::new(),
            added_at: chrono::Utc::now().to_rfc3339(),
            last_seen: None,
            last_verified: None,
            is_verified: false,
            notes: String::new(),
            groups: Vec::new(),
        }
    }

    // ── Fingerprint ──────────────────────────────────────────────────────

    /// Compute a deterministic fingerprint from a hex-encoded public key.
    /// Uses SHA-256 → first 32 bytes formatted as `xx:xx:...:xx`.
    /// This matches the format used by `CryptoClient::fingerprint()`.
    pub fn compute_fingerprint(pub_key_hex: &str) -> String {
        let key_bytes =
            hex::decode(pub_key_hex).unwrap_or_else(|_| pub_key_hex.as_bytes().to_vec());
        let hash = Sha256::digest(&key_bytes);
        hash[..16]
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<Vec<_>>()
            .join(":")
    }

    /// Verify that the stored fingerprint matches the current public key.
    pub fn fingerprint_valid(&self) -> bool {
        if self.public_key.is_empty() {
            return false;
        }
        self.fingerprint == Self::compute_fingerprint(&self.public_key)
    }

    // ── Online status ────────────────────────────────────────────────────

    /// Check if contact is online (last seen within 5 minutes).
    pub fn is_online(&self) -> bool {
        if let Some(ref last_seen) = self.last_seen {
            if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(last_seen) {
                let now = chrono::Utc::now();
                let diff = now.signed_duration_since(dt);
                return diff.num_minutes() < 5;
            }
        }
        false
    }

    /// Status icon: 🟢 online, ⚪ offline.
    pub fn status_icon(&self) -> &str {
        if self.is_online() {
            "🟢"
        } else {
            "⚪"
        }
    }

    /// Verification icon: ✓ verified, ? unverified.
    pub fn verify_icon(&self) -> &str {
        if self.is_verified {
            "✓"
        } else {
            "?"
        }
    }

    // ── Mutators ─────────────────────────────────────────────────────────

    /// Update the last_seen timestamp to now.
    pub fn touch(&mut self) {
        self.last_seen = Some(chrono::Utc::now().to_rfc3339());
    }

    /// Mark the contact as verified and record when.
    pub fn verify(&mut self) {
        self.is_verified = true;
        self.last_verified = Some(chrono::Utc::now().to_rfc3339());
    }

    /// Un-verify the contact.
    pub fn unverify(&mut self) {
        self.is_verified = false;
        self.last_verified = None;
    }

    /// Add a group tag to this contact.
    pub fn add_group(&mut self, group: &str) {
        if !self.groups.contains(&group.to_string()) {
            self.groups.push(group.to_string());
        }
    }

    /// Remove a group tag from this contact.
    pub fn remove_group(&mut self, group: &str) {
        self.groups.retain(|g| g != group);
    }

    /// Format a short summary line for display.
    pub fn summary_line(&self) -> String {
        let status = self.status_icon();
        let verified = self.verify_icon();
        let fp_short: String = self.fingerprint.chars().take(15).collect();
        format!(
            "{} {} <{}> [{}] fp:{}",
            status, self.name, self.email, verified, fp_short
        )
    }

    /// Format a detailed info block for /whois.
    pub fn detail_block(&self) -> Vec<String> {
        let mut lines = Vec::new();
        lines.push(format!("Name:       {}", self.name));
        lines.push(format!("Email:      {}", self.email));
        lines.push(format!("Added:      {}", self.fmt_added_at()));
        if let Some(ref ls) = self.last_seen {
            lines.push(format!("Last seen:  {}", ls));
        } else {
            lines.push("Last seen:  never".to_string());
        }
        lines.push(format!(
            "Status:     {}",
            if self.is_online() {
                "online"
            } else {
                "offline"
            }
        ));
        lines.push(format!(
            "Verified:   {}",
            if self.is_verified { "yes" } else { "no" }
        ));
        if let Some(ref lv) = self.last_verified {
            lines.push(format!("Verified at: {}", lv));
        }
        if !self.fingerprint.is_empty() {
            lines.push(format!("Fingerprint: {}", self.fingerprint));
        }
        if !self.public_key.is_empty() {
            let pk_short: String = self.public_key.chars().take(32).collect();
            lines.push(format!("Public key:  {}...", pk_short));
        }
        if !self.notes.is_empty() {
            lines.push(format!("Notes:       {}", self.notes));
        }
        if !self.groups.is_empty() {
            lines.push(format!("Groups:      {}", self.groups.join(", ")));
        }
        lines
    }

    fn fmt_added_at(&self) -> String {
        self.added_at
            .chars()
            .take(19)
            .collect::<String>()
            .replace('T', " ")
    }
}

// ─── ContactBook ────────────────────────────────────────────────────────────

/// Manages the full contact list with persistence and search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactBook {
    contacts: HashMap<String, Contact>,
    #[serde(default)]
    version: u32,
}

impl ContactBook {
    pub fn new() -> Self {
        Self {
            contacts: HashMap::new(),
            version: 1,
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────

    /// Return the default contacts file path: `~/.vault/contacts.json`.
    pub fn default_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(CONTACTS_DIR)
            .join(CONTACTS_FILE)
    }

    /// Load contacts from a JSON file. Returns an empty book if the file
    /// doesn't exist.
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::new());
        }
        let data = std::fs::read_to_string(path).context("Failed to read contacts file")?;
        let book: ContactBook =
            serde_json::from_str(&data).context("Failed to parse contacts file")?;
        Ok(book)
    }

    /// Load from the default path (`~/.vault/contacts.json`).
    pub fn load_default() -> Result<Self> {
        Self::load(&Self::default_path())
    }

    /// Save contacts to a JSON file. Creates parent directories if needed.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("Failed to create contacts directory")?;
        }
        let data = serde_json::to_string_pretty(self).context("Failed to serialize contacts")?;
        std::fs::write(path, data).context("Failed to write contacts file")?;
        Ok(())
    }

    /// Save to the default path.
    pub fn save_default(&self) -> Result<()> {
        self.save(&Self::default_path())
    }

    // ── CRUD ─────────────────────────────────────────────────────────────

    /// Add a contact. If a contact with the same email exists it is replaced.
    pub fn add(&mut self, contact: Contact) -> Option<Contact> {
        self.contacts.insert(contact.email.clone(), contact)
    }

    /// Remove a contact by email. Returns the removed contact if present.
    pub fn remove(&mut self, email: &str) -> Option<Contact> {
        self.contacts.remove(email)
    }

    /// Get a contact by email (immutable).
    pub fn get(&self, email: &str) -> Option<&Contact> {
        self.contacts.get(email)
    }

    /// Get a mutable reference to a contact by email.
    pub fn get_mut(&mut self, email: &str) -> Option<&mut Contact> {
        self.contacts.get_mut(email)
    }

    /// Check if a contact exists.
    pub fn contains(&self, email: &str) -> bool {
        self.contacts.contains_key(email)
    }

    /// Get all contacts as an iterator.
    pub fn all(&self) -> Vec<&Contact> {
        self.contacts.values().collect()
    }

    /// Get all contacts sorted by name.
    pub fn all_sorted(&self) -> Vec<&Contact> {
        let mut v: Vec<&Contact> = self.contacts.values().collect();
        v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        v
    }

    /// Total number of contacts.
    pub fn count(&self) -> usize {
        self.contacts.len()
    }

    // ── Search & Filter ──────────────────────────────────────────────────

    /// Search contacts by name or email (case-insensitive substring match).
    pub fn search(&self, query: &str) -> Vec<&Contact> {
        let q = query.to_lowercase();
        self.contacts
            .values()
            .filter(|c| c.name.to_lowercase().contains(&q) || c.email.to_lowercase().contains(&q))
            .collect()
    }

    /// Get only verified contacts.
    pub fn verified(&self) -> Vec<&Contact> {
        self.contacts.values().filter(|c| c.is_verified).collect()
    }

    /// Get only unverified contacts.
    pub fn unverified(&self) -> Vec<&Contact> {
        self.contacts.values().filter(|c| !c.is_verified).collect()
    }

    /// Get online contacts.
    pub fn online(&self) -> Vec<&Contact> {
        self.contacts.values().filter(|c| c.is_online()).collect()
    }

    /// Get contacts in a specific group.
    pub fn in_group(&self, group: &str) -> Vec<&Contact> {
        self.contacts
            .values()
            .filter(|c| c.groups.iter().any(|g| g == group))
            .collect()
    }

    /// List all distinct group names.
    pub fn groups(&self) -> Vec<String> {
        let mut groups: Vec<String> = self
            .contacts
            .values()
            .flat_map(|c| c.groups.clone())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        groups.sort();
        groups
    }

    // ── Actions ──────────────────────────────────────────────────────────

    /// Update last_seen for a contact.
    pub fn touch(&mut self, email: &str) {
        if let Some(contact) = self.contacts.get_mut(email) {
            contact.touch();
        }
    }

    /// Verify a contact's key. Returns false if contact not found.
    pub fn verify(&mut self, email: &str) -> bool {
        if let Some(contact) = self.contacts.get_mut(email) {
            contact.verify();
            true
        } else {
            false
        }
    }

    /// Un-verify a contact.
    pub fn unverify(&mut self, email: &str) -> bool {
        if let Some(contact) = self.contacts.get_mut(email) {
            contact.unverify();
            true
        } else {
            false
        }
    }

    /// Set notes for a contact.
    pub fn set_notes(&mut self, email: &str, notes: &str) -> bool {
        if let Some(contact) = self.contacts.get_mut(email) {
            contact.notes = notes.to_string();
            true
        } else {
            false
        }
    }

    /// Add a group to a contact.
    pub fn add_to_group(&mut self, email: &str, group: &str) -> bool {
        if let Some(contact) = self.contacts.get_mut(email) {
            contact.add_group(group);
            true
        } else {
            false
        }
    }

    /// Remove a group from a contact.
    pub fn remove_from_group(&mut self, email: &str, group: &str) -> bool {
        if let Some(contact) = self.contacts.get_mut(email) {
            contact.remove_group(group);
            true
        } else {
            false
        }
    }

    // ── Import / Export ──────────────────────────────────────────────────

    /// Export a single contact as a shareable JSON string.
    pub fn export_contact(email: &str) -> Option<String> {
        // We need the contact from somewhere — caller should pass it in.
        // This is a static helper for formatting.
        None // placeholder — use ContactBook instance method below
    }

    /// Export a contact as a portable JSON object (without private data).
    pub fn export_as_portable(&self, email: &str) -> Option<String> {
        let contact = self.get(email)?;
        let portable = serde_json::json!({
            "vault_contact": true,
            "version": 1,
            "name": contact.name,
            "email": contact.email,
            "public_key": contact.public_key,
            "fingerprint": contact.fingerprint,
        });
        serde_json::to_string_pretty(&portable).ok()
    }

    /// Import a contact from a portable JSON string.
    pub fn import_from_portable(json_str: &str) -> Result<Contact> {
        let val: serde_json::Value = serde_json::from_str(json_str).context("Invalid JSON")?;

        let name = val["name"]
            .as_str()
            .context("Missing 'name' field")?
            .to_string();
        let email = val["email"]
            .as_str()
            .context("Missing 'email' field")?
            .to_string();
        let public_key = val["public_key"].as_str().unwrap_or("").to_string();

        let mut contact = Contact::new(&email, &name, &public_key);
        // If the portable format provides a fingerprint, trust it (will be validated later).
        if let Some(fp) = val["fingerprint"].as_str() {
            contact.fingerprint = fp.to_string();
        }
        Ok(contact)
    }

    // ── Merge ────────────────────────────────────────────────────────────

    /// Merge another ContactBook into this one.
    /// Existing contacts are NOT overwritten; new ones are added.
    pub fn merge(&mut self, other: &ContactBook) -> usize {
        let mut added = 0;
        for contact in other.contacts.values() {
            if !self.contacts.contains_key(&contact.email) {
                self.contacts.insert(contact.email.clone(), contact.clone());
                added += 1;
            }
        }
        added
    }
}

impl Default for ContactBook {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Contact creation ─────────────────────────────────────────────────

    #[test]
    fn test_contact_new() {
        let c = Contact::new("alice@example.com", "Alice", "abcd1234");
        assert_eq!(c.email, "alice@example.com");
        assert_eq!(c.name, "Alice");
        assert_eq!(c.public_key, "abcd1234");
        assert!(!c.is_verified);
        assert!(!c.is_online());
        assert!(c.notes.is_empty());
        assert!(c.groups.is_empty());
    }

    #[test]
    fn test_contact_without_key() {
        let c = Contact::without_key("bob@example.com", "Bob");
        assert_eq!(c.email, "bob@example.com");
        assert!(c.public_key.is_empty());
        assert!(c.fingerprint.is_empty());
    }

    #[test]
    fn test_fingerprint_sha256_deterministic() {
        let fp1 = Contact::compute_fingerprint("deadbeef");
        let fp2 = Contact::compute_fingerprint("deadbeef");
        assert_eq!(fp1, fp2);
    }

    #[test]
    fn test_fingerprint_different_keys() {
        let fp1 = Contact::compute_fingerprint("aaaa");
        let fp2 = Contact::compute_fingerprint("bbbb");
        assert_ne!(fp1, fp2);
    }

    #[test]
    fn test_fingerprint_format() {
        let fp = Contact::compute_fingerprint("abcdef01");
        // Should be 16 hex pairs separated by colons → 47 chars
        let parts: Vec<&str> = fp.split(':').collect();
        assert_eq!(parts.len(), 16);
        for p in &parts {
            assert_eq!(p.len(), 2);
            assert!(p.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn test_fingerprint_valid() {
        let c = Contact::new("a@test.com", "A", "deadbeef");
        assert!(c.fingerprint_valid());

        let mut c2 = c.clone();
        c2.fingerprint = "tampered".to_string();
        assert!(!c2.fingerprint_valid());
    }

    #[test]
    fn test_fingerprint_valid_empty_key() {
        let c = Contact::without_key("a@test.com", "A");
        assert!(!c.fingerprint_valid());
    }

    // ── Online status ────────────────────────────────────────────────────

    #[test]
    fn test_online_status_offline_by_default() {
        let c = Contact::new("a@test.com", "A", "key");
        assert!(!c.is_online());
        assert_eq!(c.status_icon(), "⚪");
    }

    #[test]
    fn test_online_status_online() {
        let mut c = Contact::new("a@test.com", "A", "key");
        c.last_seen = Some(chrono::Utc::now().to_rfc3339());
        assert!(c.is_online());
        assert_eq!(c.status_icon(), "🟢");
    }

    #[test]
    fn test_online_status_stale() {
        let mut c = Contact::new("a@test.com", "A", "key");
        let old = chrono::Utc::now() - chrono::Duration::minutes(10);
        c.last_seen = Some(old.to_rfc3339());
        assert!(!c.is_online());
        assert_eq!(c.status_icon(), "⚪");
    }

    // ── Verify ───────────────────────────────────────────────────────────

    #[test]
    fn test_verify_unverify() {
        let mut c = Contact::new("a@test.com", "A", "key");
        assert!(!c.is_verified);
        assert!(c.last_verified.is_none());

        c.verify();
        assert!(c.is_verified);
        assert!(c.last_verified.is_some());
        assert_eq!(c.verify_icon(), "✓");

        c.unverify();
        assert!(!c.is_verified);
        assert!(c.last_verified.is_none());
        assert_eq!(c.verify_icon(), "?");
    }

    // ── Groups ───────────────────────────────────────────────────────────

    #[test]
    fn test_add_remove_group() {
        let mut c = Contact::new("a@test.com", "A", "key");
        c.add_group("team");
        c.add_group("vip");
        assert_eq!(c.groups, vec!["team", "vip"]);

        // Duplicate adds are ignored
        c.add_group("team");
        assert_eq!(c.groups, vec!["team", "vip"]);

        c.remove_group("team");
        assert_eq!(c.groups, vec!["vip"]);
    }

    // ── Touch ────────────────────────────────────────────────────────────

    #[test]
    fn test_touch() {
        let mut c = Contact::new("a@test.com", "A", "key");
        assert!(c.last_seen.is_none());
        c.touch();
        assert!(c.last_seen.is_some());
        assert!(c.is_online());
    }

    // ── Summary / Detail ─────────────────────────────────────────────────

    #[test]
    fn test_summary_line() {
        let c = Contact::new("a@test.com", "Alice", "deadbeef01234567");
        let s = c.summary_line();
        assert!(s.contains("Alice"));
        assert!(s.contains("a@test.com"));
        assert!(s.contains("fp:"));
    }

    #[test]
    fn test_detail_block() {
        let c = Contact::new("a@test.com", "Alice", "deadbeef01234567");
        let block = c.detail_block();
        assert!(block.iter().any(|l| l.contains("Alice")));
        assert!(block.iter().any(|l| l.contains("a@test.com")));
        assert!(block.iter().any(|l| l.contains("Fingerprint")));
    }

    // ── ContactBook CRUD ─────────────────────────────────────────────────

    #[test]
    fn test_book_add_get_remove() {
        let mut book = ContactBook::new();
        assert!(book
            .add(Contact::new("a@test.com", "Alice", "k1"))
            .is_none());
        assert!(book.add(Contact::new("b@test.com", "Bob", "k2")).is_none());

        assert_eq!(book.count(), 2);
        assert!(book.contains("a@test.com"));
        assert!(book.get("a@test.com").is_some());
        assert_eq!(book.get("a@test.com").unwrap().name, "Alice");

        // Replace existing
        let old = book.add(Contact::new("a@test.com", "Alice2", "k1"));
        assert!(old.is_some());
        assert_eq!(book.get("a@test.com").unwrap().name, "Alice2");

        // Remove
        assert!(book.remove("a@test.com").is_some());
        assert_eq!(book.count(), 1);
        assert!(!book.contains("a@test.com"));

        // Remove nonexistent
        assert!(book.remove("nonexistent").is_none());
    }

    // ── ContactBook search ───────────────────────────────────────────────

    #[test]
    fn test_book_search() {
        let mut book = ContactBook::new();
        book.add(Contact::new("alice@test.com", "Alice", "k1"));
        book.add(Contact::new("bob@test.com", "Bob", "k2"));
        book.add(Contact::new("charlie@test.com", "Charlie", "k3"));

        let r = book.search("alice");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name, "Alice");

        // Search by email
        let r = book.search("bob@test");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].name, "Bob");

        // Case insensitive
        let r = book.search("ALICE");
        assert_eq!(r.len(), 1);

        // No match
        let r = book.search("dave");
        assert!(r.is_empty());
    }

    // ── ContactBook verified / online / groups ────────────────────────────

    #[test]
    fn test_book_verified_filter() {
        let mut book = ContactBook::new();
        let mut c1 = Contact::new("a@test.com", "A", "k1");
        c1.verify();
        book.add(c1);
        book.add(Contact::new("b@test.com", "B", "k2"));

        assert_eq!(book.verified().len(), 1);
        assert_eq!(book.unverified().len(), 1);
    }

    #[test]
    fn test_book_groups() {
        let mut book = ContactBook::new();
        let mut c1 = Contact::new("a@test.com", "A", "k1");
        c1.add_group("team");
        c1.add_group("vip");
        book.add(c1);

        let mut c2 = Contact::new("b@test.com", "B", "k2");
        c2.add_group("team");
        book.add(c2);

        assert_eq!(book.groups(), vec!["team", "vip"]);
        assert_eq!(book.in_group("team").len(), 2);
        assert_eq!(book.in_group("vip").len(), 1);
    }

    #[test]
    fn test_book_add_to_group() {
        let mut book = ContactBook::new();
        book.add(Contact::new("a@test.com", "A", "k1"));

        assert!(book.add_to_group("a@test.com", "friends"));
        assert!(!book.add_to_group("nonexistent", "friends"));

        let c = book.get("a@test.com").unwrap();
        assert_eq!(c.groups, vec!["friends"]);
    }

    // ── ContactBook verify / touch / notes ────────────────────────────────

    #[test]
    fn test_book_verify_contact() {
        let mut book = ContactBook::new();
        book.add(Contact::new("a@test.com", "A", "k1"));

        assert!(book.verify("a@test.com"));
        assert!(book.get("a@test.com").unwrap().is_verified);
        assert!(!book.verify("nonexistent"));
    }

    #[test]
    fn test_book_unverify_contact() {
        let mut book = ContactBook::new();
        let mut c = Contact::new("a@test.com", "A", "k1");
        c.verify();
        book.add(c);

        assert!(book.unverify("a@test.com"));
        assert!(!book.get("a@test.com").unwrap().is_verified);
        assert!(!book.unverify("nonexistent"));
    }

    #[test]
    fn test_book_touch() {
        let mut book = ContactBook::new();
        book.add(Contact::new("a@test.com", "A", "k1"));
        book.touch("a@test.com");
        assert!(book.get("a@test.com").unwrap().is_online());
    }

    #[test]
    fn test_book_set_notes() {
        let mut book = ContactBook::new();
        book.add(Contact::new("a@test.com", "A", "k1"));
        assert!(book.set_notes("a@test.com", "My friend"));
        assert_eq!(book.get("a@test.com").unwrap().notes, "My friend");
        assert!(!book.set_notes("nonexistent", "nope"));
    }

    // ── ContactBook sorted ────────────────────────────────────────────────

    #[test]
    fn test_book_all_sorted() {
        let mut book = ContactBook::new();
        book.add(Contact::new("c@test.com", "Charlie", "k3"));
        book.add(Contact::new("a@test.com", "Alice", "k1"));
        book.add(Contact::new("b@test.com", "Bob", "k2"));

        let sorted = book.all_sorted();
        assert_eq!(sorted[0].name, "Alice");
        assert_eq!(sorted[1].name, "Bob");
        assert_eq!(sorted[2].name, "Charlie");
    }

    // ── Persistence ──────────────────────────────────────────────────────

    #[test]
    fn test_book_save_load_roundtrip() {
        let tmp = std::env::temp_dir().join("vault_contacts_test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let path = tmp.join("contacts.json");

        let mut book = ContactBook::new();
        book.add(Contact::new("alice@test.com", "Alice", "k1"));
        book.add(Contact::new("bob@test.com", "Bob", "k2"));
        book.save(&path).unwrap();

        let loaded = ContactBook::load(&path).unwrap();
        assert_eq!(loaded.count(), 2);
        assert!(loaded.contains("alice@test.com"));
        assert!(loaded.contains("bob@test.com"));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_book_load_nonexistent() {
        let path = Path::new("/tmp/vault_nonexistent_contacts.json");
        let book = ContactBook::load(path).unwrap();
        assert_eq!(book.count(), 0);
    }

    #[test]
    fn test_book_save_creates_dirs() {
        let tmp = std::env::temp_dir().join("vault_nested_test/sub/dir");
        let path = tmp.join("contacts.json");
        let book = ContactBook::new();
        book.save(&path).unwrap();
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("vault_nested_test"));
    }

    // ── Import / Export ──────────────────────────────────────────────────

    #[test]
    fn test_export_import_portable() {
        let mut book = ContactBook::new();
        book.add(Contact::new("alice@test.com", "Alice", "deadbeef01"));

        let portable = book.export_as_portable("alice@test.com").unwrap();
        assert!(portable.contains("alice@test.com"));
        assert!(portable.contains("Alice"));

        let imported = ContactBook::import_from_portable(&portable).unwrap();
        assert_eq!(imported.email, "alice@test.com");
        assert_eq!(imported.name, "Alice");
    }

    #[test]
    fn test_export_nonexistent() {
        let book = ContactBook::new();
        assert!(book.export_as_portable("nobody@test.com").is_none());
    }

    // ── Merge ────────────────────────────────────────────────────────────

    #[test]
    fn test_book_merge() {
        let mut book1 = ContactBook::new();
        book1.add(Contact::new("a@test.com", "Alice", "k1"));

        let mut book2 = ContactBook::new();
        book2.add(Contact::new("a@test.com", "Alice Dup", "k1"));
        book2.add(Contact::new("b@test.com", "Bob", "k2"));

        let added = book1.merge(&book2);
        assert_eq!(added, 1); // only Bob added
        assert_eq!(book1.count(), 2);
        // Alice from book1 is kept (not overwritten)
        assert_eq!(book1.get("a@test.com").unwrap().name, "Alice");
    }

    // ── Default path ─────────────────────────────────────────────────────

    #[test]
    fn test_default_path() {
        let p = ContactBook::default_path();
        assert!(p.to_string_lossy().contains(CONTACTS_DIR));
        assert!(p.to_string_lossy().ends_with(CONTACTS_FILE));
    }
}
