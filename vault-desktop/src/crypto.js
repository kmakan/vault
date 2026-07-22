import { invoke } from '@tauri-apps/api/core';

export class CryptoClient {
  constructor() {
    this.privateKey = null;
    this.publicKey = null;
    this.peerPublicKey = null;
  }

  async generateKeypair() {
    const keypair = await invoke('generate_keypair');
    this.privateKey = keypair.private_key;
    this.publicKey = keypair.public_key;
    return keypair;
  }

  async initFromStorage() {
    const stored = await invoke('load_my_keypair');
    if (stored) {
      this.privateKey = stored.private_key;
      this.publicKey = stored.public_key;
      return { keypair: stored, loaded: true };
    }
    return { keypair: null, loaded: false };
  }

  async saveToStorage() {
    if (!this.publicKey || !this.privateKey) {
      throw new Error('No keypair to save');
    }
    await invoke('save_my_keypair', {
      publicKey: this.publicKey,
      privateKey: this.privateKey,
    });
  }

  setPrivateKey(hex) {
    this.privateKey = hex;
  }

  setPeerPublicKey(hex) {
    this.peerPublicKey = hex;
  }

  async savePeerKey(email, publicKey, label) {
    await invoke('save_peer_key', { email, publicKey, label: label || null });
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

  async fingerprint() {
    if (!this.publicKey) throw new Error('No public key. Call generateKeypair first.');
    return await invoke('get_fingerprint', { publicKey: this.publicKey });
  }

  isEncrypted(text) {
    try {
      const decoded = atob(text);
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
