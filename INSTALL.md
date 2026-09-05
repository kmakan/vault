# Installation Guide

Prebuilt binaries are the recommended way to install. Building from source
is for developers and auditors — Vault is open source (AGPL-3.0) precisely so
you don't have to trust our binaries.

## Android

### Install the APK

1. Download
   [vault-0.1.149.apk](https://github.com/kmakan/vault/releases/download/v0.1.149/vault-0.1.149.apk)
   (21 MB, Android 7+) — also mirrored at
   `https://vault-msg.ru/releases/vault-0.1.149.apk`.
2. Open the file. Android will warn about installing from an unknown source —
   allow it for your browser/file manager once.
3. The APK is signed with the Vault release key: future versions install over
   the existing app without data loss. Updates are announced in-app
   (Settings → Help → "Check for updates").

### Build the APK from source

Prerequisites: JDK 17, Android SDK (platforms;android-35, build-tools;35.0.0),
NDK 27.0.12077973, Rust (`rustup`), Node.js 18+.

```bash
git clone https://github.com/kmakan/vault.git && cd vault
cd vault-desktop
npm install
npx tauri android build --apk --target aarch64
# output: src-tauri/gen/android/app/build/outputs/apk/universal/release/
```

The Gradle project in `src-tauri/gen/android` is already configured (no
`tauri android init` needed). Your build will be signed with a debug key —
fine for testing, but it cannot update over the official APK (different
signing key). To install on a device: `adb install -r <apk>`.

## Desktop (Linux)

### deb / rpm (Ubuntu/Debian, Fedora/RHEL)

```bash
# Ubuntu/Debian
wget https://github.com/kmakan/vault/releases/download/v0.1.149/Vault_0.1.149_amd64.deb
sudo apt install ./Vault_0.1.149_amd64.deb

# Fedora/RHEL
sudo rpm -i Vault-0.1.149-1.x86_64.rpm
```

### Portable tar.gz (any distro)

```bash
wget https://vault-msg.ru/releases/vault-desktop-0.1.149-linux-x86_64.tar.gz
tar xzf vault-desktop-0.1.149-linux-x86_64.tar.gz
./vault-desktop
```

Runtime dependencies (installed automatically with the .deb; install manually
for tar.gz): `libwebkit2gtk-4.1-0`, `libayatana-appindicator3`, `librsvg2`.

### Build from source

```bash
git clone https://github.com/kmakan/vault.git && cd vault/vault-desktop
npm install
npm run tauri build
# bundles: src-tauri/target/release/bundle/{deb,rpm,appimage}/
# binary:  src-tauri/target/release/vault-desktop
```

## Terminal (CLI)

Needs Rust 1.75+ only (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`):

```bash
cargo install --git https://github.com/kmakan/vault --bin vault-client
```

or from a clone:

```bash
cd vault/vault-client && cargo build --release
# binary: target/release/vault-client
```

## First run

1. Start the app and add your email (IMAP/SMTP). Use an **app password**,
   not your main password:

| Provider | How to generate |
|----------|-----------------|
| Gmail | https://myaccount.google.com/apppasswords |
| Outlook | https://account.microsoft.com/security |
| Yandex | https://passport.yandex.ru/profile/security/app-passwords |
| Mail.ru | https://e.mail.ru/settings/passwords |
| Zoho | Mail → Settings → Accounts → Generate System Password |

2. Keys are generated automatically on first login (X25519 + ML-KEM-768).
   Back them up: Settings → Keys → recovery phrase (12 words).
3. Exchange keys with a contact: QR code in person, or "Share key" —
   then verify fingerprints out of band.

## Data location

Everything stays on your device:

```
~/.vault/                     # keys (keypair.json), contacts.json, groups.json
~/.local/share/com.vault.vault/   # desktop: vault.db (SQLite: history, cache)
```

Android: app-private storage; cloud backup and device transfer are disabled.

## Verification

Each release lists SHA-256 checksums in the release notes
([v0.1.149](https://github.com/kmakan/vault/releases/tag/v0.1.149)):

```bash
sha256sum vault-0.1.149.apk
```
