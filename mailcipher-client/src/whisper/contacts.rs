use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// A Whisper contact
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Contact {
    pub email: String,
    pub name: String,
    pub public_key: String,
    pub fingerprint: String,
    pub added_at: String,
    pub last_seen: Option<String>,
    pub is_verified: bool,
}

impl Contact {
    pub fn new(email: &str, name: &str, public_key: &str) -> Self {
        let fingerprint = Self::compute_fingerprint(public_key);
        Self {
            email: email.to_string(),
            name: name.to_string(),
            public_key: public_key.to_string(),
            fingerprint,
            added_at: chrono::Utc::now().to_rfc3339(),
            last_seen: None,
            is_verified: false,
        }
    }

    /// Check if contact is online (last seen within 5 minutes)
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

    /// Get status indicator
    pub fn status_icon(&self) -> &str {
        if self.is_online() { "🟢" } else { "⚪" }
    }

    /// Compute fingerprint from public key (first 8 bytes hex)
    fn compute_fingerprint(pub_key: &str) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};

        let mut hasher = DefaultHasher::new();
        pub_key.hash(&mut hasher);
        let hash = hasher.finish();

        format!("{:016x}", hash)
            .chars()
            .collect::<Vec<_>>()
            .chunks(2)
            .map(|c| c.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join(":")
    }

    /// Update last seen timestamp
    pub fn touch(&mut self) {
        self.last_seen = Some(chrono::Utc::now().to_rfc3339());
    }

    /// Verify the contact's key fingerprint
    pub fn verify(&mut self) {
        self.is_verified = true;
    }
}

/// Contact book - manages all contacts
#[derive(Debug, Serialize, Deserialize)]
pub struct ContactBook {
    contacts: HashMap<String, Contact>,
}

impl ContactBook {
    pub fn new() -> Self {
        Self {
            contacts: HashMap::new(),
        }
    }

    /// Load from file
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::new());
        }
        let data = std::fs::read_to_string(path)
            .context("Failed to read contacts file")?;
        let book: ContactBook = serde_json::from_str(&data)
            .context("Failed to parse contacts file")?;
        Ok(book)
    }

    /// Save to file
    pub fn save(&self, path: &Path) -> Result<()> {
        let data = serde_json::to_string_pretty(self)
            .context("Failed to serialize contacts")?;
        std::fs::write(path, data)
            .context("Failed to write contacts file")?;
        Ok(())
    }

    /// Add a contact
    pub fn add(&mut self, contact: Contact) {
        self.contacts.insert(contact.email.clone(), contact);
    }

    /// Remove a contact
    pub fn remove(&mut self, email: &str) -> Option<Contact> {
        self.contacts.remove(email)
    }

    /// Get a contact by email
    pub fn get(&self, email: &str) -> Option<&Contact> {
        self.contacts.get(email)
    }

    /// Get a mutable contact reference
    pub fn get_mut(&mut self, email: &str) -> Option<&mut Contact> {
        self.contacts.get_mut(email)
    }

    /// Get all contacts
    pub fn all(&self) -> Vec<&Contact> {
        self.contacts.values().collect()
    }

    /// Search contacts by name or email
    pub fn search(&self, query: &str) -> Vec<&Contact> {
        let q = query.to_lowercase();
        self.contacts
            .values()
            .filter(|c| {
                c.name.to_lowercase().contains(&q) || c.email.to_lowercase().contains(&q)
            })
            .collect()
    }

    /// Get online contacts
    pub fn online(&self) -> Vec<&Contact> {
        self.contacts.values().filter(|c| c.is_online()).collect()
    }

    /// Contact count
    pub fn count(&self) -> usize {
        self.contacts.len()
    }

    /// Update last seen for a contact
    pub fn touch(&mut self, email: &str) {
        if let Some(contact) = self.contacts.get_mut(email) {
            contact.touch();
        }
    }

    /// Verify a contact's key
    pub fn verify(&mut self, email: &str) -> bool {
        if let Some(contact) = self.contacts.get_mut(email) {
            contact.verify();
            true
        } else {
            false
        }
    }
}

impl Default for ContactBook {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_contact_creation() {
        let contact = Contact::new("alice@example.com", "Alice", "pubkey123");
        assert_eq!(contact.email, "alice@example.com");
        assert_eq!(contact.name, "Alice");
        assert!(!contact.is_verified);
        assert!(!contact.is_online());
    }

    #[test]
    fn test_contact_online_status() {
        let mut contact = Contact::new("alice@example.com", "Alice", "pubkey123");
        
        // No last_seen = offline
        assert!(!contact.is_online());
        assert_eq!(contact.status_icon(), "⚪");
        
        // Set last_seen to now = online
        contact.last_seen = Some(chrono::Utc::now().to_rfc3339());
        assert!(contact.is_online());
        assert_eq!(contact.status_icon(), "🟢");
        
        // Set last_seen to 10 minutes ago = offline
        let old = chrono::Utc::now() - chrono::Duration::minutes(10);
        contact.last_seen = Some(old.to_rfc3339());
        assert!(!contact.is_online());
        assert_eq!(contact.status_icon(), "⚪");
    }

    #[test]
    fn test_contact_fingerprint() {
        let c1 = Contact::new("a@test.com", "A", "key1");
        let c2 = Contact::new("b@test.com", "B", "key2");
        assert_ne!(c1.fingerprint, c2.fingerprint);
    }

    #[test]
    fn test_contact_book_add_remove() {
        let mut book = ContactBook::new();
        book.add(Contact::new("a@test.com", "Alice", "key1"));
        book.add(Contact::new("b@test.com", "Bob", "key2"));

        assert_eq!(book.count(), 2);
        assert!(book.get("a@test.com").is_some());

        book.remove("a@test.com");
        assert_eq!(book.count(), 1);
        assert!(book.get("a@test.com").is_none());
    }

    #[test]
    fn test_contact_book_search() {
        let mut book = ContactBook::new();
        book.add(Contact::new("alice@test.com", "Alice", "key1"));
        book.add(Contact::new("bob@test.com", "Bob", "key2"));

        let results = book.search("alice");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "Alice");
    }

    #[test]
    fn test_contact_verify() {
        let mut book = ContactBook::new();
        book.add(Contact::new("a@test.com", "Alice", "key1"));

        assert!(book.verify("a@test.com"));
        assert!(book.get("a@test.com").unwrap().is_verified);
        assert!(!book.verify("nonexistent"));
    }
}
