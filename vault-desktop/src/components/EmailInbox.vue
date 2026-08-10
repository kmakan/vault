<template>
  <div class="email-inbox">
    <div class="inbox-header">
      <h3>{{ t('nav_mail') || 'Почта' }}</h3>
    </div>

    <div class="emails-list">
      <div v-if="loading" class="loading">{{ t('email_loading') }}</div>
      <div v-else-if="emails.length === 0" class="empty-state">
        {{ t('email_empty') }}
      </div>
      <div v-else>
        <div 
          v-for="email in emails" 
          :key="email.uid"
          :class="['email-item', { unread: !email.is_read, vault: isVault(email) }]"
          @click="$emit('open-email', email)"
        >
          <div class="email-sender">{{ email.from }}</div>
          <div class="email-subject">{{ email.subject || t('email_empty') }}</div>
          <div class="email-meta">
            <span class="email-date">{{ email.date }}</span>
            <span v-if="isVault(email)" class="vault-badge">{{ t('app_name') }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { useI18n } from '../i18n.js';

export default {
  name: 'EmailInbox',
  setup() {
    const { t } = useI18n();
    return { t };
  },
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
  methods: {
    isVault(email) {
      const subject = String(email.subject || '').trim();
      const body = email.body || '';
      // Mail list has no body yet — flag by subject; if body present check the block marker.
      const subjectFlag = /^\[Vault/i.test(subject) || /^Vault:/i.test(subject) || /^\[VAULT-/.test(subject);
      const bodyFlag = body.includes('---BEGIN VAULT ENCRYPTED---');
      return subjectFlag || bodyFlag;
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
  margin: 0;
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

.email-item.vault {
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

.vault-badge {
  font-size: 11px;
  padding: 2px 8px;
  background: #0f3460;
  border-radius: 12px;
  color: white;
}
</style>
