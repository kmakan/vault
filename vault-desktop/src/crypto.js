import { invoke } from '@tauri-apps/api/core';

// Pure, testable helper: a stored keypair is valid only when both keys are
// 64-char hex (32 bytes), differ from each other, and are not placeholders.
export function isValidKeypair(kp) {
  if (!kp || typeof kp !== 'object') return false;
  if (typeof kp.public_key !== 'string' || typeof kp.private_key !== 'string') return false;
  const hex64 = /^[0-9a-f]{64}$/i;
  if (!hex64.test(kp.public_key) || !hex64.test(kp.private_key)) return false;
  if (kp.private_key === kp.public_key) return false;
  return true;
}

export class CryptoClient {
  constructor() {
    this.privateKey = null;
    this.publicKey = null;
    this.peerPublicKey = null;
    // Post-quantum: ML-KEM-768 пара (seed hex / ek b64) и PQ-ключи
    // контактов. Отсутствие = аккаунт/контакт до PQ-миграции (legacy X25519).
    this.pqSeed = null;
    this.pqEk = null;
    this.peerPqEk = null;
  }

  async generateKeypair() {
    const keypair = await invoke('generate_keypair');
    this.privateKey = keypair.private_key;
    this.publicKey = keypair.public_key;
    // PQ-пара генерируется в key_store (PQ-2 миграция) — подхватываем после
    // сохранения (saveToStorage → load_my_keypair возвращает pq-поля).
    await this.saveToStorage();
    const stored = await invoke('load_my_keypair');
    if (stored) {
      this.pqSeed = stored.pq_private_key || null;
      this.pqEk = stored.pq_public_key || null;
    }
    return keypair;
  }

  async initFromStorage() {
    const stored = await invoke('load_my_keypair');
    // Only accept a real keypair. Placeholders/short keys must be rejected so
    // the caller regenerates a proper X25519 keypair.
    if (stored && isValidKeypair(stored)) {
      this.privateKey = stored.private_key;
      this.publicKey = stored.public_key;
      // PQ: load_my_keypair мигрирует старые файлы (генерит ML-KEM)
      // и возвращает pq-поля. Отсутствие — легаси-аккаунт без PQ.
      this.pqSeed = stored.pq_private_key || null;
      this.pqEk = stored.pq_public_key || null;
      return { keypair: stored, loaded: true };
    }
    return { keypair: null, loaded: false };
  }

  async saveToStorage() {
    if (!this.publicKey || !this.privateKey) {
      throw new Error('No keypair to save');
    }
    // PQ: передаём pq при наличии; Rust мержит со старыми, если нет.
    await invoke('save_my_keypair', {
      publicKey: this.publicKey,
      privateKey: this.privateKey,
      pqPublicKey: this.pqEk || null,
      pqPrivateKey: this.pqSeed || null,
    });
  }

  setPrivateKey(hex) {
    this.privateKey = hex;
  }

  setPeerPublicKey(hex, pqEk = null) {
    this.peerPublicKey = hex;
    // PQ: pq-ключ пира опционален (контакт без PQ → legacy-конверт)
    this.peerPqEk = pqEk;
  }

  async savePeerKey(email, publicKey, label, pqPublicKey = null) {
    await invoke('save_peer_key', {
      email,
      publicKey,
      label: label || null,
      pqPublicKey: pqPublicKey || null,
    });
  }

  async loadPeerKeys() {
    return await invoke('load_peer_keys');
  }

  async removePeerKey(email) {
    return await invoke('remove_peer_key', { email });
  }

  async exportKeys() {
    return await invoke('export_keys');
  }

  async importKeys(jsonData) {
    return await invoke('import_keys', { jsonData });
  }

  async getKeyStoreMetadata() {
    return await invoke('get_key_store_metadata');
  }

  // --- Key Recovery: мнемоника 12 слов обёртывает backup
  async recoveryGenerateMnemonic() {
    return await invoke('recovery_generate_mnemonic');
  }
  async recoveryValidateMnemonic(mnemonic) {
    return await invoke('recovery_validate_mnemonic', { mnemonic });
  }
  // Обернуть текущий backup словами → JSON WrappedBackup
  async recoveryWrapBackup(mnemonic) {
    return await invoke('recovery_wrap_backup', { mnemonic });
  }
  // Распаковать WrappedBackup словами → строка backup-JSON
  async recoveryUnwrapBackup(wrappedJson, mnemonic) {
    return await invoke('recovery_unwrap_backup', { wrappedJson, mnemonic });
  }
  // Тело эскроу-письма (стелс-конверт с payload)
  async recoveryBuildEscrowEmail(wrappedJson) {
    return await invoke('recovery_build_escrow_email', { wrappedJson });
  }
  // Разобрать тело письма → WrappedBackup-строка или null
  async recoveryParseEscrowEmail(body) {
    return await invoke('recovery_parse_escrow_email', { body });
  }

  async deleteAllKeys() {
    await invoke('delete_all_keys');
    this.privateKey = null;
    this.publicKey = null;
    this.peerPublicKey = null;
  }

  async encrypt(plaintext) {
    if (!this.privateKey) throw new Error('No private key. Call generateKeypair first.');
    return await invoke('encrypt_message', {
      plaintext,
      privateKey: this.privateKey,
      peerPublicKey: this.peerPublicKey,
    });
  }

  async decrypt(ciphertext) {
    if (!this.privateKey) throw new Error('No private key. Call generateKeypair first.');
    return await invoke('decrypt_message', {
      ciphertext,
      privateKey: this.privateKey,
      peerPublicKey: this.peerPublicKey,
    });
  }

  // Vault messages use AAD="VAULT" (serverless-mail vault chats).
  // PQ: при наличии PQ-ключей у обеих сторон команда возвращает
  // гибридный конверт "PQ1:kemct|sender_ek|wire"; иначе legacy X25519.
  async encryptVault(plaintext) {
    if (!this.privateKey) throw new Error('No private key. Call generateKeypair first.');
    return await invoke('encrypt_vault_message', {
      plaintext,
      privateKey: this.privateKey,
      peerPublicKey: this.peerPublicKey,
      myPqSeed: this.pqSeed || null,
      peerPqEk: this.peerPqEk || null,
    });
  }

  async decryptVault(ciphertext) {
    if (!this.privateKey) throw new Error('No private key. Call generateKeypair first.');
    return await invoke('decrypt_vault_message', {
      ciphertext,
      privateKey: this.privateKey,
      peerPublicKey: this.peerPublicKey,
      myPqSeed: this.pqSeed || null,
      senderPqEk: null,
    });
  }

  async fingerprint() {
    if (!this.publicKey) throw new Error('No public key. Call generateKeypair first.');
    return await invoke('get_fingerprint', { publicKey: this.publicKey });
  }

  isEncrypted(text) {
    try {
      // SMTP folds base64 at 76 chars with \r\n (RFC 5322) — atob is strict,
      // so strip ALL whitespace first (same lesson as decryptVault /
      // decrypt_symmetric_cmd). Without this, group mails arriving via SMTP
      // were silently dropped by isEncrypted before decryption.
      const decoded = atob(String(text || '').replace(/\s+/g, ''));
      return decoded.length >= 25 && this.privateKey !== null;
    } catch {
      return false;
    }
  }

  // --- Group E2E encryption ---
  // Generate a random symmetric key for group encryption
  async generateGroupKey() {
    const keyBytes = new Uint8Array(32);
    crypto.getRandomValues(keyBytes);
    return Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Encrypt group key with a member's public key (for distribution)
  async encryptGroupKeyForUser(groupKeyHex, userPublicKeyHex) {
    return await invoke('encrypt_message', {
      plaintext: groupKeyHex,
      privateKey: this.privateKey,
      peerPublicKey: userPublicKeyHex,
    });
  }

  // Decrypt group key received from group creator
  async decryptGroupKey(encryptedGroupKey, senderPublicKey) {
    return await invoke('decrypt_message', {
      ciphertext: encryptedGroupKey,
      privateKey: this.privateKey,
      peerPublicKey: senderPublicKey,
    });
  }

  // Encrypt a message with a group key (symmetric XChaCha20)
  async encryptWithGroupKey(plaintext, groupKeyHex) {
    return await invoke('encrypt_symmetric', {
      plaintext,
      key: groupKeyHex,
    });
  }

  // Decrypt a message with a group key (symmetric XChaCha20)
  async decryptWithGroupKey(ciphertext, groupKeyHex) {
    return await invoke('decrypt_symmetric', {
      ciphertext,
      key: groupKeyHex,
    });
  }
}

export default new CryptoClient();
