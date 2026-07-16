<template>
  <div class="email-settings">
    <div class="settings-header">
      <h2>{{ t('settings_email_accounts') }}</h2>
      <button @click="showAddForm = true" class="add-btn">+ {{ t('settings_add_account') }}</button>
    </div>

    <div class="accounts-list">
      <div v-if="loading" class="loading">{{ t('general_loading') }}</div>
      <div v-else-if="accounts.length === 0" class="empty-state">
        {{ t('settings_email_accounts') }}. {{ t('settings_add_account') }}.
      </div>
      <div v-else class="account-cards">
        <div v-for="account in accounts" :key="account.id" class="account-card">
          <div class="account-info">
            <div class="account-email">{{ account.email }}</div>
            <div class="account-details">
              <span class="detail">IMAP: {{ account.imap_server }}:{{ account.imap_port }}</span>
              <span class="detail">SMTP: {{ account.smtp_server }}:{{ account.smtp_port }}</span>
              <span v-if="account.is_default" class="default-badge">{{ t('general_confirm') }}</span>
            </div>
          </div>
          <button @click="deleteAccount(account.id)" class="delete-btn">×</button>
        </div>
      </div>
    </div>

    <div v-if="showAddForm" class="modal-overlay" @click.self="showAddForm = false">
      <div class="modal">
        <h3>{{ t('settings_add_account') }}</h3>
        <form @submit.prevent="addAccount">
          <div class="form-group">
            <label>{{ t('settings_email_address') }}</label>
            <input v-model="newAccount.email" type="email" required placeholder="user@example.com" />
          </div>

          <div class="form-group">
            <label>{{ t('settings_imap_server') }}</label>
            <input v-model="newAccount.imap_server" required placeholder="imap.example.com" />
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>{{ t('settings_imap_port') }}</label>
              <input v-model.number="newAccount.imap_port" type="number" placeholder="993" />
            </div>
            <div class="form-group">
              <label>{{ t('settings_smtp_server') }}</label>
              <input v-model="newAccount.smtp_server" required placeholder="smtp.example.com" />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label>{{ t('settings_smtp_port') }}</label>
              <input v-model.number="newAccount.smtp_port" type="number" placeholder="587" />
            </div>
            <div class="form-group">
              <label>{{ t('settings_username') }}</label>
              <input v-model="newAccount.username" required :placeholder="t('settings_username')" />
            </div>
          </div>

          <div class="form-group">
            <label>{{ t('settings_password') }}</label>
            <input v-model="newAccount.password_encrypted" type="password" required :placeholder="t('settings_password')" />
          </div>

          <div class="form-row">
            <label class="checkbox-label">
              <input type="checkbox" v-model="newAccount.use_tls" />
              TLS
            </label>
            <label class="checkbox-label">
              <input type="checkbox" v-model="newAccount.is_default" />
              {{ t('general_confirm') }}
            </label>
          </div>

          <div class="form-actions">
            <button type="button" @click="showAddForm = false" class="cancel-btn">{{ t('settings_cancel') }}</button>
            <button type="submit" :disabled="submitting" class="submit-btn">
              {{ submitting ? t('general_loading') : t('settings_add_account') }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script>
import api from '../api.js';
import { useI18n } from '../i18n.js';

export default {
  name: 'EmailSettings',
  setup() {
    const { t } = useI18n();
    return { t };
  },
  data() {
    return {
      accounts: [],
      loading: false,
      showAddForm: false,
      submitting: false,
      newAccount: {
        email: '',
        imap_server: '',
        imap_port: 993,
        smtp_server: '',
        smtp_port: 587,
        username: '',
        password_encrypted: '',
        use_tls: true,
        is_default: false
      }
    };
  },
  async mounted() {
    await this.loadAccounts();
  },
  methods: {
    async loadAccounts() {
      this.loading = true;
      try {
        this.accounts = await api.getEmailAccounts();
      } catch (error) {
        console.error('Failed to load email accounts:', error);
      } finally {
        this.loading = false;
      }
    },
    async addAccount() {
      this.submitting = true;
      try {
        await api.createEmailAccount(this.newAccount);
        await this.loadAccounts();
        this.showAddForm = false;
        this.resetForm();
      } catch (error) {
        alert('Failed to add account: ' + error.message);
      } finally {
        this.submitting = false;
      }
    },
    async deleteAccount(id) {
      if (!confirm('Delete this email account?')) return;
      try {
        await api.deleteEmailAccount(id);
        await this.loadAccounts();
      } catch (error) {
        alert('Failed to delete account: ' + error.message);
      }
    },
    resetForm() {
      this.newAccount = {
        email: '',
        imap_server: '',
        imap_port: 993,
        smtp_server: '',
        smtp_port: 587,
        username: '',
        password_encrypted: '',
        use_tls: true,
        is_default: false
      };
    }
  }
};
</script>

<style scoped>
.email-settings {
  padding: 20px;
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.settings-header h2 {
  margin: 0;
  color: white;
}

.add-btn {
  padding: 8px 16px;
  background: #0f3460;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.add-btn:hover {
  background: #1a5276;
}

.loading, .empty-state {
  text-align: center;
  color: #888;
  padding: 40px;
}

.account-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  background: #16213e;
  border-radius: 8px;
  margin-bottom: 12px;
}

.account-email {
  font-weight: 500;
  color: white;
  margin-bottom: 8px;
}

.account-details {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.detail {
  font-size: 12px;
  color: #888;
}

.default-badge {
  font-size: 11px;
  padding: 2px 8px;
  background: #0f3460;
  border-radius: 12px;
  color: white;
}

.delete-btn {
  background: none;
  border: none;
  color: #ff6b6b;
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 100;
}

.modal {
  background: #1a1a2e;
  padding: 24px;
  border-radius: 12px;
  width: 100%;
  max-width: 500px;
  max-height: 90vh;
  overflow-y: auto;
}

.modal h3 {
  margin: 0 0 20px;
  color: white;
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

.form-group input {
  width: 100%;
  padding: 10px 12px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 6px;
  color: white;
  font-size: 14px;
  box-sizing: border-box;
}

.form-group input:focus {
  outline: none;
  border-color: #0f3460;
}

.form-row {
  display: flex;
  gap: 16px;
}

.form-row .form-group {
  flex: 1;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: white;
  cursor: pointer;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}

.cancel-btn {
  padding: 10px 20px;
  background: #16213e;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.submit-btn {
  padding: 10px 20px;
  background: #0f3460;
  color: white;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
