# Whisper Desktop — Tauri 2.0 E2E Encrypted Messenger

Desktop client for the Whisper (MailCipher) encrypted messaging platform. Built with **Tauri 2.0** (Rust backend + Vue 3 frontend).

## Features

- **E2E Encryption** — XChaCha20-Poly1305 + X25519 Diffie-Hellman key exchange
- **Key Management** — Generate, store, import/export keypairs and peer keys
- **QR Code Sharing** — Exchange public keys via QR codes
- **Secure Storage** — Keys stored in `~/.whisper/keys/`
- **Chat UI** — Real-time encrypted messaging with contact management
- **Email Integration** — IMAP/SMTP email support via backend API

## Prerequisites

- **Rust** (stable) — https://rustup.rs
- **Node.js** ≥ 18 — https://nodejs.org
- **System dependencies** (Linux):
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
  ```

## Quick Start

```bash
cd mailcipher-desktop

# Install frontend dependencies (include dev deps!)
npm install --include=dev --ignore-scripts

# Build frontend
./node_modules/.bin/vite build

# Check Rust compiles
cd src-tauri && cargo check

# Run in dev mode (opens Tauri window)
cd .. && npm run tauri dev

# Build release binary
npm run tauri build
```

## Project Structure

```
mailcipher-desktop/
├── src/                     # Vue 3 frontend
│   ├── App.vue              # Main app layout (sidebar + chat)
│   ├── main.js              # Vue entry point
│   ├── api.js               # Backend API client
│   ├── crypto.js            # JS crypto helpers (IPC to Rust)
│   ├── components/
│   │   ├── EmailCompose.vue # Email compose form
│   │   ├── EmailInbox.vue   # Email inbox list
│   │   ├── EmailSettings.vue# Email account settings
│   │   ├── KeyManager.vue   # Key management panel
│   │   └── QRCodePanel.vue  # QR code generation/scanning
│   └── style.css            # Global styles
├── src-tauri/               # Rust Tauri backend
│   ├── Cargo.toml           # Rust dependencies
│   ├── src/
│   │   ├── main.rs          # Tauri commands & entry point
│   │   ├── crypto.rs        # XChaCha20 + X25519 encryption
│   │   └── key_store.rs     # File-based key persistence
│   ├── tauri.conf.json      # Tauri configuration
│   └── icons/               # App icons (RGBA PNG)
├── scripts/
│   └── build-desktop.sh     # Build script
├── package.json
└── README.md
```

## Tauri IPC Commands

| Command | Description |
|---------|-------------|
| `generate_keypair` | Generate new X25519 keypair |
| `encrypt_message` | Encrypt plaintext (optional peer key for shared secret) |
| `decrypt_message` | Decrypt ciphertext |
| `get_fingerprint` | Get key fingerprint |
| `save_my_keypair` | Save keypair to disk |
| `load_my_keypair` | Load saved keypair |
| `save_peer_key` | Save peer's public key |
| `load_peer_keys` | List stored peer keys |
| `remove_peer_key` | Remove a peer key |
| `export_keys` | Export all keys as JSON |
| `import_keys` | Import keys from JSON |
| `get_key_store_metadata` | Get key store info |
| `delete_all_keys` | Delete all stored keys |

## Build Targets

- **Linux**: `.deb`, `.AppImage`, `.rpm`
- **macOS**: `.dmg`
- **Windows**: `.msi`, `.exe` (NSIS)

## Architecture

```
┌─────────────────────────────────┐
│  Vue 3 Frontend (WebView)       │
│  ┌──────────┐  ┌─────────────┐ │
│  │ Chat UI  │  │ Key Manager │ │
│  └──────────┘  └─────────────┘ │
│         invoke() calls          │
├─────────────────────────────────┤
│  Tauri IPC Bridge               │
├─────────────────────────────────┤
│  Rust Backend                   │
│  ┌──────────┐  ┌─────────────┐ │
│  │ crypto.rs│  │key_store.rs │ │
│  │ XChaCha20│  │~/.whisper/  │ │
│  │ X25519   │  │  keys/      │ │
│  └──────────┘  └─────────────┘ │
└─────────────────────────────────┘
```

## Testing

```bash
cd src-tauri
cargo test
```

6 tests covering keygen, encrypt/decrypt, shared secrets, wrong-key rejection, fingerprinting, and key persistence.

## License

Part of the Whisper/MailCipher project.
