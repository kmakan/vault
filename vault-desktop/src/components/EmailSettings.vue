<template>
  <div class="email-settings">
    <!-- NO ACCOUNT — show setup -->
    <div v-if="!loading && accounts.length === 0 && !showForm">
      <div class="empty-state">
        <p>{{ t('settings_email_accounts') }}. {{ t('settings_add_account') }}.</p>
        <button @click="startAdd" class="btn btn-primary btn-sm">+ {{ t('settings_add_account') }}</button>
      </div>
    </div>

    <!-- EXISTING ACCOUNT — show card with edit -->
    <div v-if="!loading && accounts.length > 0 && !showForm">
      <div class="account-card">
        <div class="account-info">
          <div class="account-email">{{ accounts[0].email }}</div>
          <div class="account-details">
            <span class="detail">IMAP: {{ accounts[0].imap_server }}:{{ accounts[0].imap_port }}</span>
            <span class="detail">SMTP: {{ accounts[0].smtp_server }}:{{ accounts[0].smtp_port }}</span>
          </div>
        </div>
        <div class="account-actions">
          <button @click="startEdit(accounts[0])" class="edit-btn"><Icon name="pencil" :size="13" /></button>
          <button @click="deleteAccount(accounts[0].id)" class="delete-btn">×</button>
        </div>
      </div>
      <p class="hint">{{ t('email_keys_local_hint') }}</p>
    </div>

    <!-- ADD/EDIT FORM -->
    <div v-if="showForm" class="edit-form">
      <h3>{{ editingAccount ? 'Изменить аккаунт' : t('settings_add_account') }}</h3>
      <form @submit.prevent="saveAccount">
        <div class="form-group">
          <label>{{ t('settings_email_provider') }}</label>
          <select v-model="selectedProvider" @change="applyProvider" class="provider-select">
            <option value="">—</option>
            <option value="mail.ru">Mail.ru</option>
            <option value="google.com">Google (Gmail)</option>
            <option value="yandex.ru">Yandex</option>
            <option value="rambler.ru">Rambler</option>
            <option value="yahoo.com">Yahoo</option>
            <option value="outlook.com">Outlook (Microsoft)</option>
            <option value="icloud.com">iCloud (Apple)</option>
            <option value="protonmail.com">ProtonMail</option>
            <option value="custom">{{ t('settings_email_provider_custom') }}</option>
          </select>
        </div>
        <div class="form-group">
          <label>{{ t('settings_email_address') }}</label>
          <input v-model="form.email" type="email" required placeholder="user@example.com" />
        </div>
        <div class="form-group">
          <label>{{ t('settings_imap_server') }}</label>
          <input v-model="form.imap_server" :disabled="selectedProvider !== 'custom'" required placeholder="imap.example.com" />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>{{ t('settings_imap_port') }}</label>
            <input v-model.number="form.imap_port" type="number" :disabled="selectedProvider !== 'custom'" placeholder="993" />
          </div>
          <div class="form-group">
            <label>{{ t('settings_smtp_server') }}</label>
            <input v-model="form.smtp_server" :disabled="selectedProvider !== 'custom'" required placeholder="smtp.example.com" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>{{ t('settings_smtp_port') }}</label>
            <input v-model.number="form.smtp_port" type="number" :disabled="selectedProvider !== 'custom'" placeholder="587" />
          </div>
          <div class="form-group">
            <label>{{ t('settings_username') }}</label>
            <input v-model="form.username" required :placeholder="t('settings_username')" />
          </div>
        </div>
        <div class="form-group">
          <label>{{ t('settings_password') }}</label>
          <input v-model="form.password_encrypted" type="password" required :placeholder="t('settings_password')" />
        </div>
        <div class="form-row">
          <label class="checkbox-label">
            <input type="checkbox" v-model="form.use_tls" /> TLS
          </label>
          <label class="checkbox-label">
            <input type="checkbox" v-model="form.is_default" /> {{ t('general_confirm') }}
          </label>
        </div>
        <div class="form-actions">
          <button type="button" @click="cancelForm" class="btn btn-ghost">{{ t('settings_cancel') }}</button>
          <button type="submit" :disabled="submitting" class="btn btn-primary">
            {{ submitting ? t('general_loading') : (editingAccount ? 'Сохранить' : t('settings_add_account')) }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script>
import api from '../api.js';
import Icon from './Icon.vue'
import { useI18n } from '../i18n.js';

const PROVIDER_PRESETS = {
  'mail.ru': { imap_server: 'imap.mail.ru', imap_port: 993, smtp_server: 'smtp.mail.ru', smtp_port: 465, use_tls: true },
  'google.com': { imap_server: 'imap.gmail.com', imap_port: 993, smtp_server: 'smtp.gmail.com', smtp_port: 587, use_tls: true },
  'yandex.ru': { imap_server: 'imap.yandex.ru', imap_port: 993, smtp_server: 'smtp.yandex.ru', smtp_port: 465, use_tls: true },
  'rambler.ru': { imap_server: 'imap.rambler.ru', imap_port: 993, smtp_server: 'smtp.rambler.ru', smtp_port: 465, use_tls: true },
  'yahoo.com': { imap_server: 'imap.mail.yahoo.com', imap_port: 993, smtp_server: 'smtp.mail.yahoo.com', smtp_port: 587, use_tls: true },
  'outlook.com': { imap_server: 'outlook.office365.com', imap_port: 993, smtp_server: 'smtp.office365.com', smtp_port: 587, use_tls: true },
  'icloud.com': { imap_server: 'imap.mail.me.com', imap_port: 993, smtp_server: 'smtp.mail.me.com', smtp_port: 587, use_tls: true },
  'protonmail.com': { imap_server: '127.0.0.1', imap_port: 1143, smtp_server: '127.0.0.1', smtp_port: 1025, use_tls: false }
};

export default {
  name: 'EmailSettings',
  components: { Icon },
  setup() { const { t } = useI18n(); return { t }; },
  data() {
    return {
      accounts: [],
      loading: false,
      showForm: false,
      editingAccount: null,
      submitting: false,
      selectedProvider: '',
      form: this.emptyForm()
    };
  },
  watch: {
    'form.email'(val) {
      if (!val || this.selectedProvider === 'custom') return;
      const domain = val.split('@')[1];
      if (domain && PROVIDER_PRESETS[domain] && this.selectedProvider !== domain) {
        this.selectedProvider = domain;
        this.applyProvider();
      }
    }
  },
  async mounted() { await this.loadAccounts(); },
  methods: {
    emptyForm() {
      return { email: '', imap_server: '', imap_port: 993, smtp_server: '', smtp_port: 587, username: '', password_encrypted: '', use_tls: true, is_default: false };
    },
    async loadAccounts() {
      this.loading = true;
      try { this.accounts = await api.getEmailAccounts(); }
      catch (e) { console.error('Failed to load email accounts:', e); }
      finally { this.loading = false; }
    },
    startAdd() {
      this.editingAccount = null;
      this.form = this.emptyForm();
      this.selectedProvider = '';
      this.showForm = true;
    },
    startEdit(account) {
      this.editingAccount = account;
      this.form = { email: account.email, imap_server: account.imap_server, imap_port: account.imap_port, smtp_server: account.smtp_server, smtp_port: account.smtp_port, username: account.username || account.email.split('@')[0], password_encrypted: '', use_tls: account.use_tls !== false, is_default: account.is_default || false };
      this.selectedProvider = this.detectProvider(account.email);
      this.showForm = true;
    },
    detectProvider(email) {
      if (!email) return 'custom';
      const domain = email.split('@')[1];
      return PROVIDER_PRESETS[domain] ? domain : 'custom';
    },
    applyProvider() {
      if (this.selectedProvider === 'custom' || !this.selectedProvider) return;
      const p = PROVIDER_PRESETS[this.selectedProvider];
      if (p) { Object.assign(this.form, { imap_server: p.imap_server, imap_port: p.imap_port, smtp_server: p.smtp_server, smtp_port: p.smtp_port, use_tls: p.use_tls }); }
    },
    async saveAccount() {
      this.submitting = true;
      try {
        // If editing — delete old first
        if (this.editingAccount) {
          await api.deleteEmailAccount(this.editingAccount.id);
        }
        await api.createEmailAccount(this.form);
        this.showForm = false;
        await this.loadAccounts();
      } catch (e) {
        alert(this.t('err_generic') + e.message);
      } finally {
        this.submitting = false;
      }
    },
    async deleteAccount(id) {
      if (!(await confirm(this.t('email_del_account_confirm')))) return;
      try { await api.deleteEmailAccount(id); await this.loadAccounts(); }
      catch (e) { alert(this.t('err_generic') + e.message); }
    },
    cancelForm() { this.showForm = false; this.editingAccount = null; }
  }
};
</script>

<style scoped>
.email-settings { padding: 20px; }
.empty-state { text-align: center; padding: 40px 20px; color: var(--text-muted, #8b949e); }
.account-card { display: flex; justify-content: space-between; align-items: center; padding: 16px; background: var(--bg-secondary, #161b22); border: 1px solid var(--border-subtle, #30363d); border-radius: 8px; margin-bottom: 8px; }
.account-email { color: var(--text-primary, #e6edf3); font-weight: 600; font-size: 15px; }
.account-details { display: flex; gap: 12px; margin-top: 4px; }
.detail { color: var(--text-muted, #8b949e); font-size: 12px; }
.account-actions { display: flex; gap: 8px; }
.edit-btn, .delete-btn { background: none; border: none; cursor: pointer; font-size: 18px; padding: 4px 8px; border-radius: 4px; color: var(--text-secondary, #8b949e); }
.edit-btn:hover { background: var(--bg-hover, #21262d); }
.delete-btn:hover { background: #da3633; color: white; }
.hint { color: var(--text-muted, #8b949e); font-size: 12px; margin-top: 8px; }
.edit-form h3 { margin: 0 0 16px; color: var(--text-primary, white); }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; margin-bottom: 4px; color: var(--text-muted, #8b949e); font-size: 13px; }
.form-group input, .form-group select { width: 100%; padding: 8px 12px; background: var(--bg-primary, #0d1117); border: 1px solid var(--border-subtle, #30363d); border-radius: 6px; color: var(--text-primary, #e6edf3); font-size: 14px; box-sizing: border-box; }
.form-group input:disabled { opacity: 0.5; }
.form-row { display: flex; gap: 12px; }
.form-row .form-group { flex: 1; }
.checkbox-label { display: flex; align-items: center; gap: 6px; color: var(--text-muted, #8b949e); font-size: 13px; cursor: pointer; }
.form-actions { display: flex; gap: 8px; margin-top: 16px; }
.cancel-btn { padding: 8px 16px; background: var(--bg-tertiary, #21262d); color: var(--text-primary, #e6edf3); border: 1px solid var(--border-subtle, #30363d); border-radius: 6px; cursor: pointer; }
.submit-btn { padding: 8px 16px; background: linear-gradient(135deg, var(--accent-primary, #6366f1), #4f46e5); color: white; border: none; border-radius: 6px; cursor: pointer; }
.submit-btn:disabled { opacity: 0.5; }
</style>
