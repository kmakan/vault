<template>
  <div class="qr-code-panel">
    <div class="qr-panel-card">
      <h3>Добавить контакт</h3>
      <p class="panel-subtitle">Обменяйтесь ключами, чтобы начать защищённый чат</p>

      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body">
          <h4>Сообщите собеседнику ваш ID</h4>
          <div class="id-row">
            <code class="my-id">{{ myEmail }}</code>
            <button @click="copyMyId">Копировать</button>
          </div>
          <details class="qr-collapse" v-if="publicKey">
            <summary>Показать QR-код (для Android / другого устройства)</summary>
            <div class="qr-display">
              <canvas ref="qrCanvas"></canvas>
            </div>
            <p class="hint">Отсканируйте код устройством с Vault — ключ добавится автоматически.</p>
          </details>
        </div>
      </div>

      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body">
          <h4>Введите ID собеседника</h4>
          <div class="scan-input">
            <input
              v-model="inviteEmail"
              placeholder="ID собеседника (email)"
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
        </div>
      </div>

      <button class="close-btn" @click="$emit('close')">Закрыть</button>
    </div>
  </div>
</template>

<script>
import QRCode from 'qrcode';

export default {
  name: 'QRCodePanel',
  props: {
    publicKey: {
      type: String,
      required: true
    },
    myEmail: {
      type: String,
      default: ''
    }
  },
  data() {
    return {
      scanInput: '',
      inviteEmail: ''
    };
  },
  mounted() {
    this.generateQRCode();
  },
  methods: {
    async generateQRCode() {
      const canvas = this.$refs.qrCanvas;
      if (!canvas || !this.publicKey) return;

      try {
        // Create a compact QR code data
        const qrData = {
          type: 'vault-key',
          version: 1,
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

        // Check if it's a JSON QR code
        if (this.scanInput.startsWith('{')) {
          const qrData = JSON.parse(this.scanInput);
          if (qrData.type === 'vault-key' && qrData.publicKey) {
            publicKey = qrData.publicKey;
          }
        }

        // Validate the public key
        if (!/^[0-9a-f]{64}$/i.test(publicKey)) {
          alert('Неверный формат ключа. Ожидается hex строка длиной 64 символа.');
          return;
        }

        // Emit event to add the key
        this.$emit('key-scanned', publicKey);
        this.scanInput = '';
      } catch (error) {
        alert('Ошибка при обработке QR-кода: ' + error.message);
      }
    },
    copyMyId() {
      navigator.clipboard.writeText(this.myEmail);
      alert('Ваш ID скопирован — отправьте его собеседнику');
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
  background: #141a26;
  border: 1px solid #2e3a52;
  border-radius: 12px;
  padding: 24px 28px;
  width: 460px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  color: #e6edf3;
}

.qr-panel-card h3 {
  margin: 0 0 4px;
  font-size: 18px;
  color: #f3f4f6;
}

.panel-subtitle {
  margin: 0 0 18px;
  font-size: 13px;
  color: #8b949e;
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
  background: #0f3460;
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

.close-btn {
  width: 100%;
  margin-top: 6px;
  padding: 10px;
  background: #232b3d;
  border: none;
  border-radius: 8px;
  color: #c8d1e0;
  cursor: pointer;
  font-size: 14px;
}

.close-btn:hover {
  background: #2e3a52;
}
</style>
