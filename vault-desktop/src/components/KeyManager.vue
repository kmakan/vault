<template>
  <div class="key-manager-overlay" @click.self="$emit('close')">
    <div class="key-manager-panel">
      <div class="panel-header">
        <h3>{{ t('keys_title') }}</h3>
        <button class="modal-close-x" @click="$emit('close')"><Icon name="x" :size="20" /></button>
      </div>

      <div class="panel-body">
        <div class="section">
          <h4>{{ t('keys_mine') }}</h4>
          <div class="key-status">
            <span :class="hasKeys ? 'status-active' : 'status-none'">
              {{ hasKeys ? t('keys_loaded') : t('keys_none') }}
            </span>
          </div>

          <div v-if="hasKeys" class="key-info">
            <label>{{ t('keys_fingerprint') }}</label>
            <code class="fingerprint-display">{{ fingerprint }}</code>

            <label>{{ t('keys_public') }}</label>
            <div class="key-display">
              <textarea readonly :value="publicKey" rows="2"></textarea>
              <button class="copy-btn" @click="copyToClipboard(publicKey)" :title="t('keys_copy')">
                <Icon name="copy" :size="15" /> {{ copiedField === 'public' ? '✓' : '' }}
              </button>
            </div>
          </div>

          <div class="key-actions">
            <button v-if="!hasKeys" @click="generateKeys" :disabled="generating" class="btn-primary">
              {{ generating ? t('keys_generating') : t('keys_generate') }}
            </button>
            <button v-if="hasKeys" @click="exportAllKeys" class="btn-secondary">
              {{ t('keys_export') }}
            </button>
            <button v-if="hasKeys" @click="confirmDelete" class="btn-danger">
              {{ t('keys_delete_all') }}
            </button>
          </div>
        </div>

        <!-- Обёртывает backup и отправляет эскроу-письмо себе. -->
        <div class="section recovery-section">
          <h4><Icon name="key" :size="15" gradient /> {{ t('recovery_title') }}</h4>
          <p class="recovery-hint">{{ t('recovery_hint') }}</p>

          <div v-if="!recoveryCreated" class="recovery-actions">
            <button @click="createRecoveryKey" :disabled="recoveryBusy || !hasKeys" class="btn-primary">
              {{ recoveryBusy ? '…' : t('recovery_create') }}
            </button>
            <span v-if="!hasKeys" class="recovery-note">{{ t('recovery_first_keys') }}</span>
          </div>

          <div v-else class="recovery-words-box">
            <p class="recovery-warning">{{ t('recovery_write_warning') }}</p>
            <div class="recovery-grid">
              <div v-for="(w, i) in recoveryWords" :key="i" class="recovery-word">
                <span class="word-num">{{ i + 1 }}</span>{{ w }}
              </div>
            </div>
            <button @click="copyToClipboard(recoveryWords.join(' '))" class="btn-secondary">
              {{ copiedField === 'recovery' ? t('recovery_copied') : t('recovery_copy') }}
            </button>
            <button @click="confirmRecoverySaved" class="btn-primary">
              {{ t('recovery_saved_confirm') }}
            </button>
          </div>

          <p v-if="recoveryStatus" :class="['import-result', recoveryStatus.ok ? 'success' : 'error']">
            {{ recoveryStatus.message }}
          </p>
        </div>

        <div class="section">
          <h4>{{ t('keys_import') }}</h4>
          <div class="import-area">
            <textarea
              v-model="importData"
              :placeholder="t('keys_export') + '...'"
              rows="4"
            ></textarea>
            <button @click="importKeys" :disabled="!importData.trim()" class="btn-primary">
              {{ t('general_confirm') }}
            </button>
          </div>
          <div v-if="importResult" :class="['import-result', importResult.success ? 'success' : 'error']">
            {{ importResult.message }}
          </div>
        </div>

        <div class="section">
          <h4>Peer Keys ({{ peerKeys.length }})</h4>
          <div v-if="peerKeys.length === 0" class="empty-state">
            No peer keys stored yet.
          </div>
          <TransitionGroup v-else name="peer-key" tag="div" class="peer-keys-list">
            <div v-for="pk in peerKeys" :key="pk.email" class="peer-key-item" :class="{ 'peer-key-removing': removingEmail === pk.email }">
              <div class="peer-key-info">
                <div class="peer-email">{{ pk.email }}</div>
                <div class="peer-key-hex">{{ pk.public_key.substring(0, 24) }}...</div>
                <div class="peer-meta" v-if="pk.label">Label: {{ pk.label }}</div>
              </div>
              <div class="peer-key-actions">
                <button @click="copyToClipboard(pk.public_key, pk.email)" class="icon-btn" title="Copy key">
                  <Icon name="copy" :size="15" /> {{ copiedField === pk.email ? '✓' : '' }}
                </button>
                <button @click="removePeerKey(pk.email)" class="icon-btn danger" title="Remove">
                  <Icon name="trash" :size="15" />
                </button>
              </div>
            </div>
          </TransitionGroup>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import crypto from '../crypto.js';
import Icon from './Icon.vue';
import { useI18n } from '../i18n.js';

export default {
  name: 'KeyManager',
  components: { Icon },
  emits: ['close', 'keys-changed', 'recovery-created'],
  setup() {
    const { t } = useI18n();
    return { t };
  },
  data() {
    return {
      hasKeys: false,
      publicKey: '',
      fingerprint: '',
      peerKeys: [],
      removingEmail: null,
      generating: false,
      importData: '',
      importResult: null,
      copiedField: null,
      // Key Recovery
      recoveryBusy: false,
      recoveryCreated: false,   // слова показаны, ждём подтверждения записи
      recoveryWords: [],
      recoveryStatus: null,
    };
  },
  async mounted() {
    await this.loadState();
  },
  methods: {
    async loadState() {
      const result = await crypto.initFromStorage();
      this.hasKeys = result.loaded;
      if (result.loaded) {
        this.publicKey = result.keypair.public_key;
        this.fingerprint = await crypto.fingerprint();
      }
      this.peerKeys = await crypto.loadPeerKeys();
    },
    async generateKeys() {
      this.generating = true;
      try {
        await crypto.generateKeypair();
        await crypto.saveToStorage();
        this.publicKey = crypto.publicKey;
        this.fingerprint = await crypto.fingerprint();
        this.hasKeys = true;
        this.$emit('keys-changed');
      } catch (error) {
        alert('Failed to generate keys: ' + error.message);
      } finally {
        this.generating = false;
      }
    },
    async exportAllKeys() {
      try {
        const data = await crypto.exportKeys();
        await this.copyToClipboard(data);
        alert('Keys exported to clipboard. Save as JSON file.');
      } catch (error) {
        alert('Export failed: ' + error.message);
      }
    },
    async importKeys() {
      this.importResult = null;
      try {
        const meta = await crypto.importKeys(this.importData);
        this.importResult = {
          success: true,
          message: `Imported ${meta.key_count} keys successfully.`,
        };
        this.importData = '';
        await this.loadState();
        this.$emit('keys-changed');
      } catch (error) {
        this.importResult = {
          success: false,
          message: 'Import failed: ' + error.message,
        };
      }
    },
    async removePeerKey(email) {
      if (!(await confirm(`Remove peer key for ${email}?`))) return;
      // Реактивность: сначала плавно убираем из списка, потом
      // удаляем в хранилище — иначе элемент дёргается/висит до перезагрузки.
      this.removingEmail = email;
      try {
        await new Promise(r => setTimeout(r, 300)); // время на fade-out
        await crypto.removePeerKey(email);
        this.peerKeys = await crypto.loadPeerKeys();
        this.$emit('keys-changed');
      } catch (error) {
        alert('Failed to remove key: ' + error.message);
      } finally {
        this.removingEmail = null;
      }
    },
    async confirmDelete() {
      if (!(await confirm('Delete ALL keys? This cannot be undone.'))) return;
      if (!(await confirm('Are you really sure? All encryption keys will be lost.'))) return;
      try {
        await crypto.deleteAllKeys();
        await this.loadState();
        this.$emit('keys-changed');
      } catch (error) {
        alert('Failed to delete keys: ' + error.message);
      }
    },
    async copyToClipboard(text, field) {
      try {
        await navigator.clipboard.writeText(text);
        if (field) this.copiedField = field;
        else if (text === this.publicKey) this.copiedField = 'public';
        else if (Array.isArray(this.recoveryWords) && text === this.recoveryWords.join(' '))
          this.copiedField = 'recovery';
        else this.copiedField = 'other';
        setTimeout(() => { this.copiedField = null; }, 2000);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    },

    // --- Key Recovery: создание мнемоники + эскроу-письмо ---
    // 1) генерируем слова и оборачиваем backup; 2) показываем слова один раз;
    // 3) по подтверждению App.vue отправляет эскроу-письмо себе (@recovery-created).
    async createRecoveryKey() {
      this.recoveryBusy = true;
      this.recoveryStatus = null;
      try {
        const mnemonic = await crypto.recoveryGenerateMnemonic();
        // Сразу проверяем валидность и готовим wrapped — если что-то не так,
        // лучше узнать до показа слов.
        await crypto.recoveryWrapBackup(mnemonic);
        this.recoveryWords = mnemonic.split(/\s+/);
        this.recoveryCreated = true;
      } catch (e) {
        this.recoveryStatus = { ok: false, message: 'Не удалось создать ключ: ' + (e.message || e) };
      } finally {
        this.recoveryBusy = false;
      }
    },
    confirmRecoverySaved() {
      const mnemonic = this.recoveryWords.join(' ');
      this.$emit('recovery-created', { mnemonic });
      this.recoveryCreated = false;
      this.recoveryWords = [];
      this.recoveryStatus = { ok: true, message: 'Ключ восстановления сохранён. Эскроу-письмо отправлено в ваш ящик.' };
      setTimeout(() => { this.recoveryStatus = null; }, 6000);
    },
  },
};
</script>

<style scoped>
.key-manager-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.15s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.key-manager-panel {
  background: var(--bg-secondary, #1a1a2e);
  border-radius: 12px;
  width: 520px;
  max-width: calc(100vw - 32px);
  max-height: 80vh;
  overflow-y: auto;
  border: 1px solid var(--border-subtle, #16213e);
  color: var(--text-primary, white);
}

/* Мобильный: фуллскрин + safe-top, единый вид с настройками/шифром. */
@media (max-width: 767px) {
  .key-manager-overlay {
    align-items: stretch;
  }
  .key-manager-panel {
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
    border: none;
    padding-top: calc(12px + var(--safe-top, 0px));
  }
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-subtle, #16213e);
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
}

.close-btn {
  background: none;
  border: none;
  color: white;
  font-size: 20px;
  cursor: pointer;
  padding: 4px 8px;
}

.panel-body {
  padding: 20px;
}

.section {
  margin-bottom: 24px;
}

.section h4 {
  margin: 0 0 12px 0;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #888;
}

.key-status {
  margin-bottom: 12px;
}

.status-active {
  color: var(--status-online, #4ade80);
  font-size: 13px;
}

.status-none {
  color: #fbbf24;
  font-size: 13px;
}

.key-info label {
  display: block;
  font-size: 12px;
  color: var(--text-muted, #888);
  margin-bottom: 4px;
  margin-top: 8px;
}

.fingerprint-display {
  display: block;
  padding: 8px 12px;
  background: var(--bg-primary, #0f0f23);
  border-radius: 6px;
  font-family: monospace;
  font-size: 14px;
  color: var(--status-online, #4ade80);
}

.key-display {
  display: flex;
  gap: 8px;
}

.key-display textarea {
  flex: 1;
  padding: 8px;
  background: var(--bg-primary, #0f0f23);
  border: 1px solid var(--border-subtle, #16213e);
  border-radius: 6px;
  color: var(--text-primary, white);
  font-family: monospace;
  font-size: 11px;
  resize: none;
}

.copy-btn {
  padding: 8px 12px;
  background: var(--bg-tertiary, #16213e);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-primary, white);
}

.key-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.import-area textarea {
  width: 100%;
  padding: 8px;
  background: var(--bg-primary, #0f0f23);
  border: 1px solid var(--border-subtle, #16213e);
  border-radius: 6px;
  color: var(--text-primary, white);
  font-family: monospace;
  font-size: 11px;
  resize: vertical;
  margin-bottom: 8px;
  box-sizing: border-box;
}

.import-result {
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  margin-top: 8px;
}

.import-result.success {
  background: rgba(74, 222, 128, 0.12);
  color: var(--status-online, #4ade80);
}

.import-result.error {
  background: rgba(248, 81, 73, 0.12);
  color: #fca5a5;
}

.empty-state {
  color: var(--text-muted, #666);
  font-size: 13px;
  padding: 12px;
  background: var(--bg-primary, #0f0f23);
  border-radius: 6px;
  text-align: center;
}

.peer-keys-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.peer-key-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  background: var(--bg-primary, #0f0f23);
  border-radius: 6px;
  border: 1px solid var(--border-subtle, #16213e);
}

.peer-key-info {
  flex: 1;
  min-width: 0;
}

.peer-email {
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 2px;
}

.peer-key-hex {
  font-family: monospace;
  font-size: 11px;
  color: #888;
}

.peer-meta {
  font-size: 11px;
  color: #666;
  margin-top: 2px;
}

.peer-key-actions {
  display: flex;
  gap: 4px;
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  font-size: 14px;
  border-radius: 4px;
}

.icon-btn:hover {
  background: var(--bg-tertiary, #16213e);
}

.icon-btn.danger:hover {
  background: rgba(248, 81, 73, 0.25);
}

/* --- Key Recovery */
.recovery-section .recovery-hint {
  margin: 4px 0 10px;
  color: var(--text-muted, #8b949e);
  font-size: 12px;
  line-height: 1.5;
}
.recovery-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.recovery-note { color: var(--text-muted, #8b949e); font-size: 12px; }
.recovery-warning {
  margin: 0 0 8px; font-size: 13px; color: #f85149; font-weight: 600;
}
.recovery-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px;
  margin-bottom: 10px;
}
@media (max-width: 767px) {
  .recovery-grid { grid-template-columns: repeat(2, 1fr); }
}
.recovery-word {
  display: flex; align-items: center; gap: 6px;
  padding: 7px 10px;
  background: var(--bg-primary, #0d1117);
  border: 1px solid var(--border-subtle, #30363d);
  border-radius: 8px;
  font-family: ui-monospace, monospace;
  font-size: 14px;
  color: var(--text-primary, #e6edf3);
}
.recovery-word .word-num {
  color: var(--accent, #58a6ff);
  font-size: 11px;
  min-width: 16px;
  text-align: right;
}
/* Плавное исчезновение при удалении ключа контакта. */
.peer-key-removing {
  opacity: 0 !important;
  transform: translateX(24px);
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.peer-key-enter-active, .peer-key-leave-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}
.peer-key-enter-from, .peer-key-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
</style>
