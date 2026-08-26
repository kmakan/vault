<template>
  <div class="qr-code-panel">
    <div class="qr-panel-card">
      <div class="qr-header-row">
        <h3>Добавить контакт</h3>
        <button class="modal-close-x" @click="$emit('close')"><Icon name="x" :size="20" /></button>
      </div>
      <p class="panel-subtitle">Обменяйтесь ключами, чтобы начать защищённый чат</p>

      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <h4>Сообщите собеседнику ваш ID</h4>
          <div class="id-row">
            <code class="my-id">{{ myFingerprint || myEmail }}</code>
            <button @click="copyMyId">Копировать</button>
          </div>
          <p class="hint" v-if="myFingerprint">ID — ваш fingerprint. Он не меняется при смене почты (в отличие от email).</p>
          <details class="qr-collapse" v-if="publicKey">
            <summary>Показать QR-код (для Android / другого устройства)</summary>
            <div class="qr-display">
              <canvas ref="qrCanvas"></canvas>
            </div>
            <p class="hint">Отсканируйте код устройством с Vault — ключ добавится автоматически.</p>
          </details>
          <details class="qr-collapse" v-if="publicKey">
            <summary>Скопировать ключ (передать через любой канал: мессенджер, SMS…)</summary>
            <div class="id-row key-row">
              <code class="my-id key-preview">{{ keyPreview }}</code>
              <button @click="copyMyKey">Копировать ключ</button>
            </div>
            <p class="hint">
              Собеседник вставит это в поле «Добавить ключ» (шаг 3) — email-письмо не нужно.
              Ключ публичный: его можно передавать открыто, переписку он не раскрывает.
            </p>
          </details>
        </div>
      </div>

      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <h4>Введите email собеседника</h4>
          <div class="scan-input">
            <input
              v-model="inviteEmail"
              placeholder="Email собеседника"
              @keyup.enter="sendInviteById"
            />
            <button @click="sendInviteById" :disabled="!inviteEmail">
              Отправить запрос
            </button>
          </div>
          <p class="hint">
            Собеседник получит приглашение. После принятия чат появится в списке.
          </p>
        </div>
      </div>

      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body">
          <h4>Или вставьте ключ из QR-кода собеседника</h4>
          <div class="scan-input">
            <input
              v-model="scanInput"
              placeholder="Содержимое QR-кода или ключ (hex)"
              @keyup.enter="addScannedKey"
            />
            <button @click="addScannedKey" :disabled="!scanInput">
              Добавить ключ
            </button>
          </div>
          <p class="hint">Подходит, если собеседник прислал вам свой QR-код или ключ.</p>
          <div class="scan-qr-row">
            <button class="scan-qr-btn" @click="triggerScan" :disabled="scanning">
              <Icon name="camera" :size="15" /> {{ scanning ? 'Сканирую…' : 'Сканировать QR с экрана собеседника' }}
            </button>
            <input ref="scanFile" type="file" accept="image/*" capture="environment" style="display:none" @change="onScanFilePicked" />
          </div>
          <p class="hint">Наведите камеру на QR-код собеседника (или выберите фото с QR) — ключ добавится автоматически.</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import Icon from './Icon.vue';

export default {
  name: 'QRCodePanel',
  components: { Icon },
  props: {
    publicKey: {
      type: String,
      required: true
    },
    myEmail: {
      type: String,
      default: ''
    },
    myFingerprint: {
      type: String,
      default: ''
    }
  },
  data() {
    return {
      scanInput: '',
      inviteEmail: '',
      scanning: false
    };
  },
  computed: {
    keyPreview() {
      const k = this.publicKey || '';
      return k.length > 24 ? k.slice(0, 12) + '…' + k.slice(-12) : k;
    }
  },
  mounted() {
    this.generateQRCode();
  },
  methods: {
    async generateQRCode() {
      const canvas = this.$refs.qrCanvas;
      if (!canvas || !this.publicKey) return;

      try {
        // Create a compact QR code data. email включён (v2) — при сканировании
        // контакт добавится сразу с email, без ручного ввода.
        const qrData = {
          type: 'vault-key',
          version: 2,
          email: this.myEmail || '',
          publicKey: this.publicKey,
          timestamp: Date.now()
        };

        await QRCode.toCanvas(canvas, JSON.stringify(qrData), {
          width: 180,
          margin: 2,
          color: {
            dark: '#000000',
            light: '#ffffff'
          }
        });
      } catch (error) {
        console.error('Failed to generate QR code:', error);
      }
    },
    async addScannedKey() {
      if (!this.scanInput) return;

      try {
        // Try to parse as QR data
        let publicKey = this.scanInput;
        let email = '';

        // Check if it's a JSON QR code
        if (this.scanInput.startsWith('{')) {
          const qrData = JSON.parse(this.scanInput);
          if (qrData.type === 'vault-key' && qrData.publicKey) {
            publicKey = qrData.publicKey;
            email = qrData.email || '';
          }
        }

        // Validate the public key
        if (!/^[0-9a-f]{64}$/i.test(publicKey)) {
          alert('Неверный формат ключа. Ожидается hex строка длиной 64 символа.');
          return;
        }

        // Emit event to add the key (email из QR — если есть, без ручного ввода)
        this.$emit('key-scanned', { publicKey, email });
        this.scanInput = '';
      } catch (error) {
        alert('Ошибка при обработке QR-кода: ' + error.message);
      }
    },
    triggerScan() {
      this.scanning = false;
      const el = this.$refs.scanFile;
      if (el) { el.value = ''; el.click(); }
    },
    async onScanFilePicked(ev) {
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      this.scanning = true;
      try {
        const dataUrl = await this.fileToDataUrl(file);
        const decoded = await this.decodeQrFromImage(dataUrl);
        if (!decoded) {
          alert('QR-код не найден на изображении. Попробуйте ближе/чётче.');
          return;
        }
        this.scanInput = decoded;
        await this.addScannedKey();
      } catch (e) {
        alert('Ошибка сканирования: ' + e.message);
      } finally {
        this.scanning = false;
      }
    },
    fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error || new Error('read failed'));
        fr.readAsDataURL(file);
      });
    },
    decodeQrFromImage(dataUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            // Ограничим размер — jsQR быстрее на малых изображениях.
            const maxSide = 800;
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(data.data, data.width, data.height, { inversionAttempts: 'dontInvert' });
            resolve(code ? code.data : null);
          } catch (e) { reject(e); }
        };
        img.onerror = () => reject(new Error('не удалось загрузить изображение'));
        img.src = dataUrl;
      });
    },
    copyMyId() {
      navigator.clipboard.writeText(this.myFingerprint || this.myEmail);
      alert('Ваш ID скопирован — отправьте его собеседнику');
    },
    copyMyKey() {
      if (!this.publicKey) return;
      navigator.clipboard.writeText(this.publicKey);
      alert('Публичный ключ скопирован — передайте его собеседнику любым удобным способом');
    },
    sendInviteById() {
      const email = (this.inviteEmail || '').trim();
      if (!email) return;
      this.$emit('invite-by-id', email);
      this.inviteEmail = '';
    }
  },
  watch: {
    publicKey() {
      this.generateQRCode();
    }
  }
};
</script>

<style scoped>
.qr-code-panel {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.qr-panel-card {
  background: var(--bg-secondary, #141a26);
  border: 1px solid var(--border-subtle, #2e3a52);
  border-radius: 12px;
  padding: 24px 28px;
  width: 460px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  color: var(--text-primary, #e6edf3);
}

.qr-panel-card h3 {
  margin: 0 0 4px;
  font-size: 18px;
  color: var(--text-primary, #f3f4f6);
}

.panel-subtitle {
  margin: 0 0 18px;
  font-size: 13px;
  color: var(--text-muted, #8b949e);
}

.step {
  display: flex;
  gap: 12px;
  margin-bottom: 18px;
}

.step-num {
  flex: 0 0 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent-primary, #0f3460);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 2px;
}

.step-body {
  flex: 1;
  min-width: 0;
}

.step-body h4 {
  margin: 0 0 8px;
  font-size: 14px;
  color: #e6edf3;
  font-weight: 600;
}

.id-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.my-id {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  background: #0f1420;
  border: 1px solid #2e3a52;
  border-radius: 6px;
  font-family: monospace;
  font-size: 12px;
  color: #e6edf3;
  word-break: break-all;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.id-row button {
  padding: 8px 12px;
  background: #0f3460;
  border: none;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.id-row button:hover {
  background: #16487f;
}

.key-row {
  margin-top: 8px;
}

.key-preview {
  font-size: 11px;
}

.qr-collapse {
  margin-top: 10px;
}

.qr-collapse summary {
  cursor: pointer;
  font-size: 13px;
  color: #7ea6d8;
  user-select: none;
}

.qr-collapse summary:hover {
  color: #a5c4ec;
}

.qr-display {
  background: #fff;
  padding: 12px;
  border-radius: 8px;
  margin-top: 10px;
  width: fit-content;
}

.qr-display canvas {
  display: block;
}

.scan-input {
  display: flex;
  gap: 8px;
}

.scan-input input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  background: #0f1420;
  border: 1px solid #2e3a52;
  border-radius: 6px;
  color: #e6edf3;
  font-family: monospace;
  font-size: 12px;
  outline: none;
}

.scan-input input:focus {
  border-color: #4f6fa8;
}

.scan-input button {
  padding: 8px 12px;
  background: #0f3460;
  border: none;
  border-radius: 6px;
  color: #fff;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.scan-input button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.hint {
  font-size: 12px;
  color: #8b949e;
  margin: 8px 0 0;
}

/* Шапка карточки: заголовок + единый крестик закрытия (25.08). */
.qr-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.qr-header-row h3 {
  margin: 0;
}

/* Мобильный (25.08): фуллскрин + safe-top, единый вид с остальными окнами. */
@media (max-width: 767px) {
  .qr-panel-card {
    width: 100%;
    max-width: 100%;
    height: 100%;
    max-height: 100%;
    border-radius: 0;
    padding-top: calc(16px + var(--safe-top, 0px));
  }
}
.scan-qr-row { margin-top: 12px; }
.scan-qr-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; background: #0f3460; border: none; border-radius: 6px;
  color: #fff; cursor: pointer; font-size: 13px;
}
.scan-qr-btn:hover { background: #16487f; }
.scan-qr-btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
