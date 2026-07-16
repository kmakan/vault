# MailCipher Android

E2E Encrypted Messenger — Android client built with Tauri 2.0.

## Tech Stack
- **Frontend**: HTML/CSS/JS (Vite)
- **Backend**: Rust (Tauri 2.0)
- **Encryption**: ChaCha20-Poly1305 + X25519 (same as desktop)
- **Min SDK**: 24 (Android 7.0)

## Build

```bash
# Install dependencies
npm install

# Dev (requires Android SDK + NDK)
cargo tauri android dev

# Build APK
cargo tauri android build
```

## Crypto
Uses identical crypto as the desktop client:
- XChaCha20-Poly1305 for symmetric encryption
- X25519 for key exchange
- SHA-256 for key derivation
- Base64 for ciphertext encoding
