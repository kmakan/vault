# Installation Guide

## Desktop (Linux)

### Option 1: Download DEB/RPM

Download from GitHub Releases:
```bash
# Ubuntu/Debian
sudo dpkg -i vault_0.1.0_amd64.deb

# Fedora/RHEL
sudo rpm -i vault-0.1.0-1.x86_64.rpm
```

### Option 2: Build from Source

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone & build
git clone https://github.com/nickswl/vault.git
cd vault/vault-desktop
npm install
npm run tauri build

# Binary: src-tauri/target/release/vault-desktop
```

---

## Android

### Prerequisites
- JDK 17
- Android SDK (platforms;android-35, build-tools;35.0.0)
- NDK 27.0.12077973

### Build APK

```bash
cd vault-desktop
npm install
npx tauri android build

# Output: src-tauri/gen/android/app/build/outputs/apk/
```

### Install on Device

```bash
adb install app-universal-release-unsigned.apk
```

**Note:** APK is unsigned. For production, sign with a release keystore.

---

## Terminal (CLI)

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone & build
git clone https://github.com/nickswl/vault.git
cd vault/vault-client
cargo build --release

# Run
../target/release/vault-client

# Or install globally
cargo install --path .
vault-client
```

---

## Configuration

### First Run

```bash
# Generate keys
/keygen

# Connect to email
/connect user@gmail.com your-app-password

# Share your public key with a contact
/keyshare contact@example.com
```

### App Passwords

Vault uses app passwords (not your main password):

| Provider | How to Generate |
|----------|-----------------|
| Gmail | https://myaccount.google.com/apppasswords |
| Outlook | https://account.microsoft.com/security |
| Yandex | https://passport.yandex.ru/profile/security/app-passwords |
| Mail.ru | https://e.mail.ru/settings/passwords |

### Data Location

```
~/.vault/
├── keys/           # Your key pairs
├── contacts/       # Contact book
├── groups.json     # Group definitions
├── search_index/   # Full-text search index
└── config.toml     # Settings
```

---

## Troubleshooting

### "Connection refused"
- Check IMAP server address
- Check if port 993 (SSL) is open
- Try app password instead of main password

### "Key not found"
- Run `/keygen` to generate keys
- Share your public key with contacts

### "Build failed"
- Ensure Rust 1.75+: `rustc --version`
- For Desktop: Node.js 18+: `node --version`
- For Android: JDK 17: `java -version`

---

## Uninstall

```bash
# DEB
sudo dpkg -r vault

# RPM
sudo rpm -e vault

# Remove data
rm -rf ~/.vault/
```
