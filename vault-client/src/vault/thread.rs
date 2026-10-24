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

    /// Участник не добавляется в список повторно (иначе «3 участника» при
    /// двух собеседниках).
    #[test]
    fn test_thread_participants_dedup() {
        let mut thread = MessageThread::new("t1", "Hello");
        thread.add_message(make_msg("m1", None, "alice"));
        thread.add_message(make_msg("m2", None, "alice"));
        thread.add_message(make_msg("m3", None, "bob"));
        assert_eq!(thread.participants.len(), 2, "alice и bob — два участника");
        assert!(thread.participants.contains(&"alice".to_string()));
        assert!(thread.participants.contains(&"bob".to_string()));
    }

    /// Корневое сообщение — то, у которого нет parent_id (первое в треде).
    #[test]
    fn test_thread_root_is_the_message_without_parent() {
        let mut thread = MessageThread::new("t1", "Hello");
        thread.add_message(make_msg("m1", None, "alice"));
        thread.add_message(make_msg("m2", Some("m1"), "bob"));
        let root = thread.root().expect("корневое сообщение есть");
        assert_eq!(root.message_id, "m1", "корнем является сообщение без parent_id");
    }

    /// Ответы ищутся по parent_id: «ответ на ответ» не попадает в ответы на
    /// корневое сообщение.
    #[test]
    fn test_thread_replies_are_direct_children() {
        let mut thread = MessageThread::new("t1", "Hello");
        thread.add_message(make_msg("m1", None, "alice"));
        thread.add_message(make_msg("m2", Some("m1"), "bob"));
        thread.add_message(make_msg("m3", Some("m2"), "charlie"));
        assert_eq!(thread.replies_to("m1").len(), 1, "прямой ответ на m1 один");
        assert_eq!(thread.replies_to("m2").len(), 1, "ответ на ответ — отдельный");
    }

    /// Треды сортируются по последней активности (свежие сверху).
    ///
    /// ПРЕДЫДУЩАЯ ФОРМУЛИРОВКА НИЧЕГО НЕ МЕРИЛА: два треда создавались без
    /// сообщений, у обоих `last_activity` — пустая строка, и любое сравнение
    /// давало «отсортировано». Мутация «компаратор перевёрнут» выжила именно
    /// поэтому (24.10). Теперь у тредов РАЗНАЯ активность и порядок проверяется
    /// списком имён, а не «совпадает сам с собой».
    #[test]
    fn test_thread_manager_sorts_by_activity() {
        let mut mgr = ThreadManager::new();
        {
            let older = mgr.find_or_create_thread("Старый", "t1");
            let mut msg = make_msg("m1", None, "alice");
            msg.timestamp = "2026-01-01T00:00:00Z".to_string();
            older.add_message(msg);
        }
        {
            let newer = mgr.find_or_create_thread("Свежий", "t2");
            let mut msg = make_msg("m2", None, "bob");
            msg.timestamp = "2026-03-01T00:00:00Z".to_string();
            newer.add_message(msg);
        }
        let order: Vec<&str> = mgr
            .sorted_threads()
            .iter()
            .map(|t| t.subject.as_str())
            .collect();
        assert_eq!(
            order,
            vec!["Свежий", "Старый"],
            "сверху тот тред, у которого новее последняя активность"
        );
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
