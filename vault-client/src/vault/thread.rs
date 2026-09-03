use serde::{Deserialize, Serialize};

/// A single message in a thread
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadMessage {
    pub message_id: String,
    pub parent_id: Option<String>,
    pub from: String,
    pub subject: String,
    pub preview: String,
    pub timestamp: String,
    pub is_read: bool,
    pub reply_count: usize,
}

/// Thread of messages (conversation)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageThread {
    pub thread_id: String,
    pub subject: String,
    pub participants: Vec<String>,
    pub messages: Vec<ThreadMessage>,
    pub last_activity: String,
    pub unread_count: usize,
}

impl MessageThread {
    pub fn new(thread_id: &str, subject: &str) -> Self {
        Self {
            thread_id: thread_id.to_string(),
            subject: subject.to_string(),
            participants: Vec::new(),
            messages: Vec::new(),
            last_activity: String::new(),
            unread_count: 0,
        }
    }

    /// Add a message to the thread
    pub fn add_message(&mut self, msg: ThreadMessage) {
        self.last_activity = msg.timestamp.clone();
        if !msg.is_read {
            self.unread_count += 1;
        }
        if !self.participants.contains(&msg.from) {
            self.participants.push(msg.from.clone());
        }
        self.messages.push(msg);
    }

    /// Get the root message (first in thread)
    pub fn root(&self) -> Option<&ThreadMessage> {
        self.messages.iter().find(|m| m.parent_id.is_none())
    }

    /// Get replies to a specific message
    pub fn replies_to(&self, message_id: &str) -> Vec<&ThreadMessage> {
        self.messages
            .iter()
            .filter(|m| m.parent_id.as_deref() == Some(message_id))
            .collect()
    }

    /// Get unread count
    pub fn unread(&self) -> usize {
        self.messages.iter().filter(|m| !m.is_read).count()
    }

    /// Mark all messages as read
    pub fn mark_all_read(&mut self) {
        for msg in &mut self.messages {
            msg.is_read = true;
        }
        self.unread_count = 0;
    }
}

/// Thread manager for organizing messages
pub struct ThreadManager {
    threads: Vec<MessageThread>,
}

impl ThreadManager {
    pub fn new() -> Self {
        Self {
            threads: Vec::new(),
        }
    }

    /// Find or create a thread by subject
    pub fn find_or_create_thread(&mut self, subject: &str, thread_id: &str) -> &mut MessageThread {
        let idx = self.threads.iter().position(|t| t.subject == subject);
        if let Some(i) = idx {
            return &mut self.threads[i];
        }
        self.threads.push(MessageThread::new(thread_id, subject));
        self.threads.last_mut().unwrap()
    }

    /// Get all threads sorted by last activity
    pub fn sorted_threads(&self) -> Vec<&MessageThread> {
        let mut threads: Vec<&MessageThread> = self.threads.iter().collect();
        threads.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        threads
    }

    /// Get total unread across all threads
    pub fn total_unread(&self) -> usize {
        self.threads.iter().map(|t| t.unread()).sum()
    }

    /// Get thread count
    pub fn thread_count(&self) -> usize {
        self.threads.len()
    }
}

impl Default for ThreadManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_msg(id: &str, parent: Option<&str>, from: &str) -> ThreadMessage {
        ThreadMessage {
            message_id: id.to_string(),
            parent_id: parent.map(|s| s.to_string()),
            from: from.to_string(),
            subject: "Test".to_string(),
            preview: "preview".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            is_read: false,
            reply_count: 0,
        }
    }

    #[test]
    fn test_thread_add_message() {
        let mut thread = MessageThread::new("t1", "Hello");
        thread.add_message(make_msg("m1", None, "alice"));
        assert_eq!(thread.messages.len(), 1);
        assert_eq!(thread.participants.len(), 1);
        assert_eq!(thread.unread_count, 1);
    }

    #[test]
    fn test_thread_replies() {
        let mut thread = MessageThread::new("t1", "Hello");
        thread.add_message(make_msg("m1", None, "alice"));
        thread.add_message(make_msg("m2", Some("m1"), "bob"));
        thread.add_message(make_msg("m3", Some("m1"), "charlie"));

        let replies = thread.replies_to("m1");
        assert_eq!(replies.len(), 2);
    }

    #[test]
    fn test_thread_mark_read() {
        let mut thread = MessageThread::new("t1", "Hello");
        thread.add_message(make_msg("m1", None, "alice"));
        thread.add_message(make_msg("m2", None, "bob"));

        thread.mark_all_read();
        assert_eq!(thread.unread(), 0);
        assert_eq!(thread.unread_count, 0);
    }

    #[test]
    fn test_thread_manager() {
        let mut mgr = ThreadManager::new();
        mgr.find_or_create_thread("Hello", "t1");
        mgr.find_or_create_thread("World", "t2");
        mgr.find_or_create_thread("Hello", "t1"); // same thread

        assert_eq!(mgr.thread_count(), 2);
        assert_eq!(mgr.total_unread(), 0);
    }
}
