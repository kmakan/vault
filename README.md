# 🔐 Vault (Vault)

> **Secure messenger over email. No servers. No phone numbers. Just email.**
>
> Version: 0.1.0 | License: MIT | Status: Beta

---

## What is Vault?

Vault is a privacy-first messenger that works over email (IMAP/SMTP). It uses **end-to-end encryption** (X25519 + XChaCha20-Poly1305) so that no one — not even email providers — can read your messages.

**Key principles:**
- 🚫 **No servers** — your email is the transport
- 🚫 **No phone numbers** — just email addresses
- 🔒 **E2E encryption** — messages are encrypted on your device
- 🌍 **Multi-language** — EN, RU, CN (more coming)
- 💻 **Cross-platform** — Desktop (Linux), Android, Terminal

---

## Quick Start

### Install

```bash
# Clone
git clone https://github.com/nickswl/vault.git
cd vault

# Build client
cd vault-client
cargo build --release

# Run
../target/release/vault-client
```

### Desktop (Tauri)

```bash
cd vault-desktop
npm install
npm run tauri build   # or: npm run tauri dev
```

### Android

```bash
# Requires: JDK 17, Android SDK 35, NDK 27
cd vault-desktop
npx tauri android build
# Output: src-tauri/gen/android/app/build/outputs/apk/
```

---

## Features

### Core
- ✅ X25519 key exchange + XChaCha20-Poly1305 encryption
- ✅ IMAP/SMTP email transport
- ✅ Multi-account support
- ✅ Message threads & replies
- ✅ Reactions (emoji)
- ✅ Read receipts & delivery status
- ✅ Edit / delete messages

### Media
- ✅ File attachments (encrypted)
- ✅ Image/video thumbnails (Kitty graphics protocol)
- ✅ Drag & drop in Desktop

### Organization
- ✅ Folders for chats
- ✅ Search (FTS5 full-text)
- ✅ Pin / mute chats

### Groups
- ✅ Create group, invite members
- ✅ Promote / demote admins
- ✅ Block / unblock users (local)
- ✅ Leave group, delete group

### Key Exchange
- ✅ QR code (in-person)
- ✅ Copy & paste (Signal, Telegram, WhatsApp)
- ✅ VPN warnings for blocked regions

### Desktop UI
- ✅ Professional design (CSS variables, dark theme)
- ✅ i18n (English, Русский, 中文)
- ✅ Language selector in settings

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Vault Client                  │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Crypto   │  │ Groups   │  │ Email (IMAP) │  │
│  │ X25519   │  │ Local    │  │              │  │
│  │ XChaCha  │  │ JSON     │  │              │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
│         │              │              │          │
│         └──────────────┼──────────────┘          │
│                        │                         │
│              ┌─────────┴─────────┐               │
│              │   UI Layer        │               │
│              │  CLI / Desktop    │               │
│              │  / Android        │               │
│              └───────────────────┘               │
└─────────────────────────────────────────────────┘
                      │
                      │ email (IMAP/SMTP)
                      ▼
              ┌───────────────┐
              │  Email Server  │
              │  (any IMAP)    │
              └───────────────┘
```

**No central server.** Users communicate directly via email. Groups are stored locally on each device. Key exchange happens out-of-band (QR, Signal, etc.).

---

## CLI Commands

### Session
| Command | Description |
|---------|-------------|
| `/connect <email> <pass> [server]` | Connect to IMAP |
| `/status` | Show connection status |
| `/help [topic]` | Show help |
| `/quit` | Exit |

### Messaging
| Command | Description |
|---------|-------------|
| `/chat <email>` | Enter chat mode |
| `/send <message>` | Send encrypted message |
| `/inbox` | List recent messages |
| `/read <id>` | Read a message |
| `/reply <id> <msg>` | Reply to message |
| `/thread <subject>` | Show thread |

### Keys & Encryption
| Command | Description |
|---------|-------------|
| `/keygen` | Generate key pair |
| `/keys` | Show key status |
| `/keyshare <email>` | Share public key (with VPN warning) |
| `/encrypt <text>` | Encrypt text |
| `/decrypt <text>` | Decrypt ciphertext |

### Groups
| Command | Description |
|---------|-------------|
| `/creategroup <name>` | Create new group |
| `/groupmembers <id>` | List members |
| `/groupinvite <id> <email>` | Add member |
| `/groupremove <id> <email>` | Remove member |
| `/promote <id> <email>` | Promote to admin |
| `/demote <id> <email>` | Demote to member |
| `/block <id> <email>` | Block user in group |
| `/unblock <id> <email>` | Unblock user |
| `/leavegroup <id>` | Leave group |

### Organization
| Command | Description |
|---------|-------------|
| `/fc <name> [icon]` | Create folder |
| `/fl` | List folders |
| `/fa <folder> <chat>` | Add chat to folder |
| `/search <query>` | Search messages |
| `/pin <id>` | Pin message |

---

## Key Exchange

Since Vault has no server, you need to exchange keys securely with your contacts.

| Method | Security | VPN Needed | Notes |
|--------|----------|------------|-------|
| **QR Code** | Highest | ❌ | Best — scan in person |
| **Copy & Send** | High | ⚠️ | Send via Signal/Telegram/WhatsApp |
| **PGP Email** | High | ❌ | For PGP users |

**⚠️ VPN Warning:** Signal may be blocked in Russia, China, Iran, and other regions. Use VPN if you cannot connect.

---

## Groups (Telegram-like)

Vault groups work like Telegram — **without a server**:

- **Creator** = Admin by default
- **Admins** can invite/remove members
- **Blocking** is local (you don't see blocked users' messages)
- **Roles** are advisory (no server to enforce)

All group state is stored in `~/.vault/groups.json`.

---

## Project Structure

```
vault/
├── vault-client/     # Rust CLI + core logic
│   ├── src/
│   │   ├── cli/           # CLI commands, REPL
│   │   ├── crypto/        # X25519, XChaCha20
│   │   ├── vault/       # Groups, contacts, invites, etc.
│   │   └── main.rs
│   └── Cargo.toml
├── vault-desktop/    # Vue.js + Tauri 2
│   ├── src/
│   │   ├── components/    # Vue components
│   │   ├── locales/       # i18n (en, ru, zh)
│   │   └── i18n.js
│   ├── src-tauri/         # Rust backend (Tauri)
│   └── package.json
├── vault-web/        # Web UI
├── docs/                  # Documentation
│   ├── design/            # Design docs
│   ├── deployment/        # Build & deploy guides
│   └── research/          # Research notes
└── README.md
```

---

## Testing

```bash
# Client tests
cd vault-client
cargo test          # 228 tests

# Desktop build check
cd vault-desktop
npm run build
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Areas for Contribution
- 🌐 More languages (i18n)
- 📱 Android UI polish
- 🔐 Key exchange improvements
- 📧 Email provider compatibility
- 🧪 Test coverage

---

## License

MIT — do whatever you want.

---

## Credits

Built with Rust, Vue.js, Tauri, and a lot of ☕.
