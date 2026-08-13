<template>
  <div class="qr-code-panel">
    <h3>QR Code для обмена ключами</h3>
    
    <div class="qr-section">
      <div class="qr-display">
        <canvas ref="qrCanvas"></canvas>
      </div>
      <p class="qr-instructions">
        Отсканируйте этот QR-код другим устройством для обмена публичным ключом
      </p>
    </div>
    
    <div class="scan-section">
      <h4>Сканировать QR-код</h4>
      <div class="scan-input">
        <input 
          v-model="scanInput" 
          placeholder="Вставьте QR-код или введите публичный ключ вручную..."
          @keyup.enter="addScannedKey"
        />
        <button @click="addScannedKey" :disabled="!scanInput">
          Добавить ключ
        </button>
      </div>
      <p class="scan-instructions">
        Или введите публичный ключ вручную в формате hex
      </p>
    </div>
    
    <div class="invite-section">
      <h4>Пригласить участника по id</h4>
      <div class="scan-input">
        <input 
          v-model="inviteEmail" 
          type="email"
          placeholder="Email участника (например, user@example.com)"
          @keyup.enter="sendInviteById"
        />
        <button @click="sendInviteById" :disabled="!inviteEmail">
          Пригласить
        </button>
      </div>
      <p class="scan-instructions">
        Собеседник получит запрос контакта и после принятия появится в ваших чатах
      </p>
    </div>
    
    <div class="key-info">
      <h4>Ваш публичный ключ</h4>
      <code class="public-key">{{ publicKey }}</code>
      <button @click="copyPublicKey">Копировать</button>
    </div>
    
    <button @click="$emit('close')">Закрыть</button>
  </div>
</template>

<script>
import QRCode from 'qrcode';
import crypto from '../crypto.js';

export default {
  name: 'QRCodePanel',
  props: {
    publicKey: {
      type: String,
      required: true
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
          width: 200,
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
          alert('Неверный формат публичного ключа. Ожидается hex строка длиной 64 символа.');
          return;
        }
        
        // Emit event to add the key
        this.$emit('key-scanned', publicKey);
        this.scanInput = '';
        
      } catch (error) {
        alert('Ошибка при обработке QR-кода: ' + error.message);
      }
    },
    copyPublicKey() {
      navigator.clipboard.writeText(this.publicKey);
      alert('Публичный ключ скопирован в буфер обмена');
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.qr-section {
  text-align: center;
  margin-bottom: 20px;
}

.qr-display {
  background: white;
  padding: 20px;
  border-radius: 8px;
  margin-bottom: 10px;
}

.scan-section {
  margin-bottom: 20px;
  width: 300px;
}

.scan-input {
  display: flex;
  gap: 8px;
}

.scan-input input {
  flex: 1;
  padding: 8px;
  background: #0f0f23;
  border: 1px solid #16213e;
  border-radius: 4px;
  color: white;
  font-family: monospace;
  font-size: 12px;
}

.scan-input button {
  padding: 8px 16px;
  background: #0f3460;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
}

.scan-input button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.key-info {
  margin-bottom: 20px;
  text-align: center;
}

.public-key {
  display: block;
  padding: 8px;
  background: #0f0f23;
  border: 1px solid #16213e;
  border-radius: 4px;
  font-family: monospace;
  font-size: 10px;
  word-break: break-all;
  margin-bottom: 8px;
}

.qr-instructions, .scan-instructions {
  font-size: 12px;
  color: #888;
  margin-top: 8px;
}

button:last-child {
  padding: 8px 16px;
  background: #16213e;
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
}
</style>
