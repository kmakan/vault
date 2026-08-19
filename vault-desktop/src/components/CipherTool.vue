<template>
  <div class="cipher-overlay" @click.self="$emit('close')">
    <div class="cipher-panel">
      <div class="panel-header">
        <h3>{{ t('cipher_title') }}</h3>
        <button class="close-btn" @click="$emit('close')" title="Close">&times;</button>
      </div>

      <div class="panel-body">
        <div v-if="Object.keys(peerKeys).length === 0" class="empty-keys-state">
          <div class="empty-icon"><Icon name="shield" :size="28" /></div>
          <h4>{{ t('cipher_no_contacts_title') }}</h4>
          <p>{{ t('cipher_no_contacts_hint') }}</p>
          <button class="btn-primary" @click="openKeysManager" title="Open Keys">
            {{ t('cipher_open_keys') }}
          </button>
        </div>

        <div v-else class="cipher-tabs">
          <div class="tab-buttons">
            <button 
              class="tab-btn" 
              :class="{ active: activeTab === 'encrypt' }"
              @click="activeTab = 'encrypt'"
            >
              {{ t('cipher_encrypt_tab') }}
            </button>
            <button 
              class="tab-btn" 
              :class="{ active: activeTab === 'decrypt' }"
              @click="activeTab = 'decrypt'"
            >
              {{ t('cipher_decrypt_tab') }}
            </button>
            <button 
              class="tab-btn" 
              :class="{ active: activeTab === 'file' }"
              @click="activeTab = 'file'"
            >
              {{ t('cipher_file_tab') || '📁 Файл' }}
            </button>
          </div>

          <div v-show="activeTab === 'encrypt'" class="tab-content">
            <div class="form-group">
              <label>{{ t('cipher_contact') }}</label>
              <select v-model="selectedContact" class="form-control">
                <option value="" disabled>{{ t('cipher_contact') }}...</option>
                <option 
                  v-for="([email, key], index) in Object.entries(peerKeys)" 
                  :key="index" 
                  :value="email"
                >
                  {{ (contacts.find(c => c.email === email) || {}).name || email }}
                </option>
              </select>
            </div>

            <div class="form-group">
              <label>Text</label>
              <textarea 
                v-model="plaintext" 
                :placeholder="t('cipher_text_placeholder')" 
                class="cipher-textarea"
                rows="4"
              ></textarea>
            </div>

            <button 
              @click="encryptMessage" 
              :disabled="!selectedContact || !plaintext || !cryptoReady"
              class="btn-primary"
            >
              {{ t('cipher_action_encrypt') }}
            </button>

            <div v-if="ciphertext" class="output-group">
              <label>Ciphertext</label>
              <textarea 
                v-model="ciphertext" 
                :placeholder="t('cipher_output_placeholder')" 
                class="cipher-textarea read-only"
                rows="3"
                readonly
              ></textarea>
              <button 
                @click="copyCiphertext" 
                class="btn-secondary"
                title="Copy to clipboard"
              >
                {{ copiedText === ciphertext ? t('cipher_copied') : t('cipher_copy') }}
              </button>
            </div>
          </div>

          <div v-show="activeTab === 'decrypt'" class="tab-content">
            <div class="form-group">
              <label>{{ t('cipher_contact') }}</label>
              <select v-model="selectedContact" class="form-control">
                <option value="" disabled>{{ t('cipher_contact') }}...</option>
                <option 
                  v-for="([email, key], index) in Object.entries(peerKeys)" 
                  :key="index" 
                  :value="email"
                >
                  {{ (contacts.find(c => c.email === email) || {}).name || email }}
                </option>
              </select>
            </div>

            <div class="form-group">
              <label>Ciphertext</label>
              <textarea 
                v-model="ciphertext" 
                :placeholder="t('cipher_decrypt_placeholder')" 
                class="cipher-textarea"
                rows="4"
              ></textarea>
            </div>

            <button 
              @click="decryptMessage" 
              :disabled="!selectedContact || !ciphertext || !cryptoReady"
              class="btn-primary"
            >
              {{ t('cipher_action_decrypt') }}
            </button>

            <div v-if="decryptedText" class="output-group">
              <label>Decrypted Text</label>
              <textarea 
                v-model="decryptedText" 
                :placeholder="t('cipher_result_placeholder')" 
                class="cipher-textarea read-only"
                rows="3"
                readonly
              ></textarea>
              <button 
                @click="copyDecrypted" 
                class="btn-secondary"
                title="Copy to clipboard"
              >
                {{ copiedText === decryptedText ? t('cipher_copied') : t('cipher_copy') }}
              </button>
            </div>

            <div v-if="decryptError" class="error-message">
              {{ decryptError }}
            </div>
          </div>

          <div v-show="activeTab === 'file'" class="tab-content">
            <p class="file-tab-hint">{{ t('cipher_file_hint') }}</p>
            <div class="form-group">
              <label>{{ t('cipher_contact') }}</label>
              <select v-model="selectedContact" class="form-control">
                <option value="" disabled>{{ t('cipher_contact') }}...</option>
                <option 
                  v-for="([email, key], index) in Object.entries(peerKeys)" 
                  :key="'file-' + index" 
                  :value="email"
                >
                  {{ (contacts.find(c => c.email === email) || {}).name || email }}
                </option>
              </select>
            </div>

            <!-- Шифрование файла -->
            <div class="file-zone">
              <div class="file-zone-title">{{ t('cipher_file_encrypt_title') }}</div>
              <input type="file" ref="encryptFileInput" class="file-input" @change="onFileEncryptSelect" />
              <div v-if="fileEncrypting" class="file-status">⏳ {{ t('cipher_file_working') }}…</div>
              <div v-if="fileEncryptName" class="file-status">
                ✅ {{ t('cipher_file_encrypted') }}: {{ fileEncryptName }}
                ({{ formatBytes(fileEncryptSize) }})
              </div>
              <button
                v-if="fileCiphertext"
                @click="downloadVaultFile"
                class="btn-primary"
              >
                {{ t('cipher_file_download_vault') }}
              </button>
            </div>

            <!-- Расшифровка файла -->
            <div class="file-zone">
              <div class="file-zone-title">{{ t('cipher_file_decrypt_title') }}</div>
              <input type="file" ref="decryptFileInput" class="file-input" accept=".vault,.txt,text/plain" @change="onFileDecryptSelect" />
              <div v-if="fileDecrypting" class="file-status">⏳ {{ t('cipher_file_working') }}…</div>
              <div v-if="fileDecryptResult" class="file-status">✅ {{ fileDecryptResult }}</div>
            </div>
            <div v-if="fileError" class="error-message">{{ fileError }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import crypto from '../crypto.js';
import Icon from './Icon.vue'
import { useI18n } from '../i18n.js';
import { downloadBase64 } from '../chatExport.js';

export default {
  name: 'CipherTool',
  emits: ['close', 'open-keys'],
  setup() {
    const { t } = useI18n();
    return { t };
  },
  data() {
    return {
      activeTab: 'encrypt',
      plaintext: '',
      ciphertext: '',
      decryptedText: '',
      decryptError: '',
      selectedContact: '',
      cryptoReady: false,
      copiedText: '',
      // Файлы: шифрование в .vault / восстановление из .vault
      fileEncrypting: false,
      fileEncryptName: '',
      fileEncryptSize: 0,
      fileCiphertext: '',
      fileDecrypting: false,
      fileDecryptResult: '',
      fileError: '',
    };
  },
  props: {
    contacts: {
      type: Array,
      default: () => []
    },
    peerKeys: {
      type: Object,
      default: () => {}
    },
  },
  watch: {
    // Reset copied state when text changes
    plaintext() {
      if (this.copiedText === this.ciphertext) this.copiedText = '';
    },
    ciphertext() {
      if (this.copiedText === this.ciphertext) this.copiedText = '';
    },
    decryptedText() {
      if (this.copiedText === this.decryptedText) this.copiedText = '';
    },
  },
  methods: {
    openKeysManager() {
      this.$emit('open-keys');
      this.$emit('close');
    },
    async encryptMessage() {
      if (!this.selectedContact || !this.plaintext || !this.cryptoReady) return;

      try {
        crypto.setPeerPublicKey(this.peerKeys[this.selectedContact]);
        const result = await crypto.encryptVault(this.plaintext);
        this.ciphertext = result;
        this.decryptError = '';

        // Auto-copy to clipboard after showing result
        setTimeout(() => {
          this.copyCiphertext();
        }, 100);
      } catch (error) {
        this.decryptError = this.t('cipher_error');
        this.ciphertext = '';
        console.error('Encryption failed:', error);
      }
    },
    async decryptMessage() {
      if (!this.selectedContact || !this.ciphertext || !this.cryptoReady) return;

      try {
        crypto.setPeerPublicKey(this.peerKeys[this.selectedContact]);
        const result = await crypto.decryptVault(this.ciphertext);
        this.decryptedText = result;
        this.decryptError = '';
        // Вставленный шифротекст сохраняем — пользователь может сравнить
        // или расшифровать повторно.
      } catch (error) {
        this.decryptError = this.t('cipher_error');
        this.decryptedText = '';
        console.error('Decryption failed:', error);
      }
    },
    // --- Файлы через шифратор ---
    // Прочитать File как base64 (data URL без префикса).
    readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(String(e.target.result).split(',')[1] || '');
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(file);
      });
    },
    formatBytes(bytes) {
      if (!bytes) return '0 B';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(1) + ' MB';
    },
    // Шифровать ФАЙЛ для выбранного контакта: результат — .vault-файл
    // (текст шифротекста), который можно передать ЛЮБЫМ транспортом.
    // Получатель открывает его во вкладке «Файл» и восстанавливает.
    async onFileEncryptSelect(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this.fileError = '';
      this.fileCiphertext = '';
      this.fileEncryptName = '';
      if (!this.selectedContact || !this.cryptoReady) {
        this.fileError = this.t('cipher_file_no_contact') || 'Сначала выберите контакт';
        return;
      }
      // Ограничение ~20MB: шифротекст в base64-файле, чтобы .vault можно
      // было передать даже почтой (лимит вложений 25MB у Gmail).
      if (file.size > 20 * 1024 * 1024) {
        this.fileError = this.t('cipher_file_too_large') || 'Файл слишком большой (макс 20MB)';
        return;
      }
      this.fileEncrypting = true;
      try {
        const base64 = await this.readFileAsBase64(file);
        const payload = JSON.stringify({
          vault_file: 1,
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          data: base64,
        });
        crypto.setPeerPublicKey(this.peerKeys[this.selectedContact]);
        this.fileCiphertext = await crypto.encryptVault(payload);
        this.fileEncryptName = file.name;
        this.fileEncryptSize = file.size;
      } catch (err) {
        this.fileError = this.t('cipher_file_encrypt_error') || 'Не удалось зашифровать файл';
        console.error('File encrypt failed:', err);
      } finally {
        this.fileEncrypting = false;
        if (this.$refs.encryptFileInput) this.$refs.encryptFileInput.value = '';
      }
    },
    // Скачать зашифрованный файл (.vault) — текст шифротекста.
    downloadVaultFile() {
      if (!this.fileCiphertext) return;
      const name = (this.fileEncryptName || 'file') + '.vault';
      downloadBase64(this.fileCiphertext, name, 'text/plain');
    },
    // Расшифровать .vault-файл: восстанавливаем оригинал и скачиваем.
    async onFileDecryptSelect(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      this.fileError = '';
      this.fileDecryptResult = '';
      if (!this.selectedContact || !this.cryptoReady) {
        this.fileError = this.t('cipher_file_no_contact') || 'Сначала выберите контакт';
        return;
      }
      this.fileDecrypting = true;
      try {
        const text = await file.text();
        crypto.setPeerPublicKey(this.peerKeys[this.selectedContact]);
        const plaintext = await crypto.decryptVault(text.trim());
        let obj = null;
        try { obj = JSON.parse(plaintext); } catch { /* не JSON */ }
        if (!obj || obj.vault_file !== 1 || !obj.data) {
          this.fileError = this.t('cipher_file_not_vault') || 'Это не зашифрованный файл Vault';
          return;
        }
        downloadBase64(obj.data, obj.name || 'decrypted.bin', obj.type || 'application/octet-stream');
        this.fileDecryptResult =
          (this.t('cipher_file_recovered') || 'Файл расшифрован и скачан') +
          `: ${obj.name} (${this.formatBytes(obj.size || 0)})`;
      } catch (err) {
        this.fileError = this.t('cipher_error');
        console.error('File decrypt failed:', err);
      } finally {
        this.fileDecrypting = false;
        if (this.$refs.decryptFileInput) this.$refs.decryptFileInput.value = '';
      }
    },
    async copyCiphertext() {
      if (!this.ciphertext) return;
      
      try {
        await navigator.clipboard.writeText(this.ciphertext);
        this.copiedText = this.ciphertext;
        setTimeout(() => {
          this.copiedText = '';
        }, 2000);
      } catch {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = this.ciphertext;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this.copiedText = this.ciphertext;
        setTimeout(() => {
          this.copiedText = '';
        }, 2000);
      }
    },
    async copyDecrypted() {
      if (!this.decryptedText) return;
      
      try {
        await navigator.clipboard.writeText(this.decryptedText);
        this.copiedText = this.decryptedText;
        setTimeout(() => {
          this.copiedText = '';
        }, 2000);
      } catch {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = this.decryptedText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        this.copiedText = this.decryptedText;
        setTimeout(() => {
          this.copiedText = '';
        }, 2000);
      }
    },
    async loadCryptoState() {
      this.cryptoReady = this.$parent.cryptoReady || false;
      if (!this.cryptoReady) {
        await this.$parent.initCrypto();
        this.cryptoReady = this.$parent.cryptoReady || false;
      }
    },
  },
  async mounted() {
    await this.loadCryptoState();
  },
};
</script>

<style scoped>
.cipher-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.cipher-panel {
  background: var(--bg-primary);
  border-radius: 12px;
  width: 100%;
  max-width: 600px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid var(--bg-hover);
}

.panel-header h3 {
  margin: 0;
  font-size: 20px;
  color: var(--text-primary);
}

.close-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 24px;
  cursor: pointer;
  padding: 8px;
  border-radius: 6px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.panel-body {
  padding: 24px;
}

.empty-keys-state {
  text-align: center;
  padding: 40px 20px;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  opacity: 0.7;
}

.empty-keys-state h4 {
  margin: 0 0 12px 0;
  font-size: 18px;
  color: var(--text-primary);
}

.empty-keys-state p {
  margin: 0 0 24px 0;
  color: var(--text-secondary);
  line-height: 1.5;
}

.cipher-tabs {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.tab-buttons {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.tab-btn {
  flex: 1;
  padding: 10px 16px;
  background: transparent;
  border: 1px solid var(--bg-hover);
  color: var(--text-secondary);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  font-size: 14px;
  font-weight: 500;
}

.tab-btn.active {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--accent);
}

.tab-btn:hover:not(.active) {
  background: var(--bg-primary);
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--text-secondary);
  font-weight: 500;
}

.form-control {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--bg-hover);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}

.cipher-textarea {
  width: 100%;
  padding: 12px;
  background: var(--bg-primary);
  border: 1px solid var(--bg-hover);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  resize: vertical;
  min-height: 100px;
  font-family: monospace;
  box-sizing: border-box;
}

.cipher-textarea:read-only {
  opacity: 0.8;
  background: var(--bg-secondary);
  cursor: default;
}

.btn-primary {
  padding: 12px 24px;
  background: var(--accent);
  border: none;
  border-radius: 8px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.output-group {
  margin-top: 24px;
  padding: 20px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid var(--bg-hover);
}

.output-group .cipher-textarea {
  margin-bottom: 12px;
}

.btn-secondary {
  padding: 8px 16px;
  background: var(--bg-hover);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.btn-secondary:hover {
  background: var(--bg-primary);
}

.error-message {
  margin-top: 16px;
  padding: 12px 16px;
  background: rgba(220, 38, 38, 0.1);
  border: 1px solid rgba(220, 38, 38, 0.3);
  color: #fca5a5;
  border-radius: 6px;
  font-size: 14px;
}

.file-tab-hint {
  margin: 0 0 16px 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.file-zone {
  margin-bottom: 20px;
  padding: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--bg-hover);
  border-radius: 8px;
}

.file-zone-title {
  margin-bottom: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.file-input {
  display: block;
  width: 100%;
  margin-bottom: 10px;
  font-size: 13px;
  color: var(--text-secondary);
}

.file-input::-webkit-file-upload-button {
  background: var(--bg-hover);
  color: var(--text-primary);
  border: none;
  border-radius: 6px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  margin-right: 10px;
}

.file-status {
  margin: 8px 0;
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-word;
}

@keyframes fade-in {
  from { opacity: 0; transform: translateY(-10px); }
  to { opacity: 0; }
}

</style>
