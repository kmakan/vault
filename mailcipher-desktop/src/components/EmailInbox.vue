<template>
  <div class="email-inbox">
    <div class="inbox-header">
      <h3>Email</h3>
      <div class="filter-tabs">
        <button 
          :class="['filter-tab', { active: filter === 'all' }]"
          @click="filter = 'all'"
        >
          All
        </button>
        <button 
          :class="['filter-tab', { active: filter === 'whisper' }]"
          @click="filter = 'whisper'"
        >
          Whisper
        </button>
        <button 
          :class="['filter-tab', { active: filter === 'regular' }]"
          @click="filter = 'regular'"
        >
          Regular
        </button>
      </div>
    </div>

    <div class="emails-list">
      <div v-if="loading" class="loading">Loading emails...</div>
      <div v-else-if="filteredEmails.length === 0" class="empty-state">
        No emails to display.
      </div>
      <div v-else>
        <div 
          v-for="email in filteredEmails" 
          :key="email.uid"
          :class="['email-item', { unread: !email.is_read, whisper: isWhisper(email) }]"
          @click="$emit('open-email', email)"
        >
          <div class="email-sender">{{ email.from }}</div>
          <div class="email-subject">{{ email.subject || '(no subject)' }}</div>
          <div class="email-meta">
            <span class="email-date">{{ email.date }}</span>
            <span v-if="isWhisper(email)" class="whisper-badge">Whisper</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'EmailInbox',
  props: {
    emails: {
      type: Array,
      default: () => []
    },
    loading: {
      type: Boolean,
      default: false
    }
  },
  emits: ['open-email'],
  data() {
    return {
      filter: 'all'
    };
  },
  computed: {
    filteredEmails() {
      if (this.filter === 'all') return this.emails;
      if (this.filter === 'whisper') return this.emails.filter(e => this.isWhisper(e));
      return this.emails.filter(e => !this.isWhisper(e));
    }
  },
  methods: {
    isWhisper(email) {
      const subject = email.subject || '';
      const body = email.body || '';
      return subject.includes('[Whisper]') || 
             body.includes('---BEGIN WHISPER---') ||
             body.includes('X-MailCipher-Type: whisper');
    }
  }
};
</script>

<style scoped>
.email-inbox {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.inbox-header {
  padding: 16px;
  border-bottom: 1px solid #16213e;
}

.inbox-header h3 {
  margin: 0 0 12px;
  color: white;
}

.filter-tabs {
  display: flex;
  gap: 8px;
}

.filter-tab {
  padding: 6px 12px;
  background: #16213e;
  color: #888;
  border: none;
  border-radius: 16px;
  cursor: pointer;
  font-size: 13px;
}

.filter-tab.active {
  background: #0f3460;
  color: white;
}

.emails-list {
  flex: 1;
  overflow-y: auto;
}

.loading, .empty-state {
  text-align: center;
  color: #888;
  padding: 40px;
}

.email-item {
  padding: 16px;
  border-bottom: 1px solid #16213e;
  cursor: pointer;
  transition: background 0.2s;
}

.email-item:hover {
  background: #16213e;
}

.email-item.unread {
  background: #0a1628;
}

.email-item.whisper {
  border-left: 3px solid #0f3460;
}

.email-sender {
  color: white;
  font-weight: 500;
  margin-bottom: 4px;
}

.email-subject {
  color: #ccc;
  font-size: 14px;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.email-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.email-date {
  font-size: 12px;
  color: #666;
}

.whisper-badge {
  font-size: 11px;
  padding: 2px 8px;
  background: #0f3460;
  border-radius: 12px;
  color: white;
}
</style>
