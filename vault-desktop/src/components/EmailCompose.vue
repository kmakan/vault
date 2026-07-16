<template>
  <div class="email-compose">
    <div class="compose-header">
      <h3>{{ t('email_compose') }}</h3>
      <button @click="$emit('close')" class="close-btn">&times;</button>
    </div>

    <div class="compose-form">
      <div class="form-group">
        <label>{{ t('email_to') }}</label>
        <input v-model="form.to" type="email" placeholder="recipient@example.com" required />
      </div>

      <div class="form-group">
        <label>{{ t('email_subject') }}</label>
        <input v-model="form.subject" :placeholder="t('email_subject')" />
      </div>

      <div class="form-group encryption-toggle">
        <label class="checkbox-label">
          <input type="checkbox" v-model="form.encrypt" />
          {{ t('app_tagline') }} ({{ t('app_name') }})
        </label>
        <select v-if="form.encrypt" v-model="form.keyType" class="key-select">
          <option value="combined">Combined (Alpha + Columnar)</option>
          <option value="alpha">Alpha only</option>
          <option value="columnar">Columnar only</option>
        </select>
      </div>

      <div class="form-group reply-to-group" v-if="replyTo">
        <label>{{ t('email_reply_to') }}</label>
        <div class="reply-to-info">{{ replyTo }}</div>
      </div>

      <div class="form-group">
        <label>{{ t('email_body') }}</label>
        <textarea 
          v-model="form.body" 
          rows="12" 
          :placeholder="t('email_body') + '...'"
          class="body-textarea"
        ></textarea>
      </div>

      <div class="form-actions">
        <button @click="$emit('close')" class="cancel-btn">{{ t('settings_cancel') }}</button>
        <button 
          @click="send" 
          :disabled="sending || !form.to || !form.body" 
          class="send-btn"
        >
          {{ sending ? t('email_sending') : t('email_send') }}
        </button>
      </div>

      <div v-if="error" class="error-message">{{ error }}</div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';
import { useI18n } from '../i18n.js';

export default {
  name: 'EmailCompose',
  setup() {
    const { t } = useI18n();
    return { t };
  },
  props: {
    accountId: {
      type: String,
      required: true
    },
    replyTo: {
      type: String,
      default: ''
    },
    defaultSubject: {
      type: String,
      default: ''
    }
  },
  emits: ['close', 'sent'],
  data() {
    return {
      form: {
        to: '',
        subject: '',
        body: '',
        encrypt: false,
        keyType: 'combined',
      },
      sending: false,
      error: '',
    };
  },
  mounted() {
    if (this.replyTo) {
      this.form.to = this.replyTo;
    }
    if (this.defaultSubject) {
      this.form.subject = this.defaultSubject.startsWith('Re:') 
        ? this.defaultSubject 
        : `Re: ${this.defaultSubject}`;
    }
  },
  methods: {
    async send() {
      if (!this.form.to || !this.form.body) return;

      this.sending = true;
      this.error = '';

      try {
        const body = this.form.encrypt 
          ? this.encryptBody(this.form.body)
          : this.form.body;

        const subject = this.form.encrypt
          ? `[Vault] ${this.form.subject}`
          : this.form.subject;

        await api.sendEmail(this.accountId, {
          to: this.form.to,
          subject,
          body,
          is_html: false,
        });

        this.$emit('sent');
        this.$emit('close');
      } catch (error) {
        this.error = 'Failed to send: ' + error.message;
      } finally {
        this.sending = false;
      }
    },

    encryptBody(text) {
      // Client-side placeholder for E2E encryption.
      // In production, this would use the user's key to encrypt
      // before sending via SMTP. The backend also encrypts with
      // server-side keys, so this is defense-in-depth.
      const marker = '---BEGIN VAULT---\n';
      const endMarker = '\n---END VAULT---';
      return `${marker}${text}${endMarker}`;
    },
  },
};
</script>

<style scoped>
.email-compose {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0f0f23;
}

.compose-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid #16213e;
}

.compose-header h3 {
  margin: 0;
  color: white;
}

.close-btn {
  background: none;
  border: none;
  color: #888;
  font-size: 24px;
  cursor: pointer;
  padding: 0 4px;
}

.close-btn:hover {
  color: white;
}

.compose-form {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  color: #888;
  font-size: 13px;
}

.form-group input,
.form-group textarea {
  width: 100%;
  padding: 10px 12px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: white;
  font-size: 14px;
  box-sizing: border-box;
  font-family: inherit;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: #0f3460;
}

.body-textarea {
  resize: vertical;
  min-height: 200px;
}

.encryption-toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: white;
  cursor: pointer;
  font-size: 14px;
}

.key-select {
  padding: 6px 12px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: white;
  font-size: 13px;
}

.reply-to-info {
  color: #ccc;
  font-size: 13px;
  padding: 8px 12px;
  background: #16213e;
  border-radius: 6px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 20px;
}

.cancel-btn {
  padding: 10px 20px;
  background: #16213e;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.send-btn {
  padding: 10px 24px;
  background: #0f3460;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}

.send-btn:hover {
  background: #1a5276;
}

.send-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.error-message {
  margin-top: 12px;
  padding: 10px;
  background: #3d1111;
  border: 1px solid #ff6b6b;
  border-radius: 6px;
  color: #ff6b6b;
  font-size: 13px;
}
</style>
