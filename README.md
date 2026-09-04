# Vault

> **A private messenger that lives inside ordinary email.**
> No servers. No phone numbers. Post-quantum E2E encryption. Voice calls.
>
> Version: 0.1.147 · License: AGPL-3.0 · Status: Beta

[English](#english) · [Русский](#русский)

---

## English

Vault turns your existing email into a secure messenger. Messages are
encrypted end-to-end on your device and sent as ordinary-looking emails
through your own IMAP/SMTP provider. There is no Vault server anywhere —
if every relay in the world went down, your messenger would keep working.

### Why Vault

| | Vault | Typical email-based messengers |
|---|---|---|
| Servers required | **none** (your mailbox is the transport) | chatmail/relays in practice |
| Post-quantum E2E | **yes** — ML-KEM-768 + X25519 hybrid | no |
| Voice calls | **yes** — Opus over DTLS-SRTP, serverless signaling | no |
| Stealth | messages indistinguishable from normal mail | visible in headers/subjects |
| Onboarding | just an email address + app password | invites, IDs, phrases |

### Features

- **Hybrid post-quantum encryption** — every conversation key is derived
  from both an X25519 and an ML-KEM-768 shared secret (HKDF-SHA256);
  payload encryption is XChaCha20-Poly1305. Legacy X25519-only fallback
  keeps old contacts working during migration.
- **1-to-1 and group chats** — roles (creator/admin/member), invites via
  QR or link, membership survives an email change (key-fingerprint
  migration), pinned / edited / deleted-for-me / starred / disappearing
  messages, reactions, replies, read receipts.
- **Polls** — create a poll in any chat or group (up to 10 options);
  votes are E2E-encrypted signal letters, aggregated on every device.
- **Forwarding** — resend any message to another chat or group with a
  "forwarded from" attribution; the text is re-encrypted for the target.
- **Drafts** — an unfinished message is saved per chat and restored when
  you come back.
- **Location sharing** — send your current point as an OpenStreetMap
  link (Android).
- **Chat folders** — organize chats into folders (chips above the list);
  archive and per-chat mute included.
- **Voice calls** — Opus 48 kHz, per-frame AEAD + DTLS-SRTP, P2P via
  WebRTC with email signaling and instant hangup over a control
  DataChannel. No call servers.
- **Attachments** — encrypted files, images, audio messages; provider
  size limits detected automatically.
- **Duress & panic controls** — a duress password opens an empty vault,
  a panic code wipes the device; optional SOS email with geolocation.
  Biometric app lock on Android.
- **Local-first storage** — SQLite on your device; no cloud sync, no
  telemetry, no third-party SDKs.
- **Cross-platform** — Desktop (Linux/Windows/macOS via Tauri 2),
  Android (Tauri 2), terminal (Rust CLI with feature parity).
- **i18n** — English, Russian, Chinese.

### How it works

```
┌──────────────┐   E2E-encrypted email    ┌──────────────┐
│  Alice       │ ───────────────────────► │  Bob         │
│  Vault app   │   (any IMAP/SMTP mail)   │  Vault app   │
│  keys+DB on  │                          │  keys+DB on  │
│  device      │ ◄─────────────────────── │  device      │
└──────────────┘                          └──────────────┘
        ▲                                        ▲
        └────── mail providers see: opaque base64 body,
                no subject, no Vault markers ──────┘
```

- **Key exchange** — QR code in person, or send your public key over any
  channel you already trust. Fingerprints are short and verifiable.
- **Groups** — a shared group key is delivered inside an E2E envelope to
  each member; group state lives locally on every device.
- **Calls** — SDP offers/answers travel as the same E2E envelopes;
  media goes peer-to-peer (STUN only, TURN relay planned as a premium
  option).

### Known limitations (honest)

- **No forward secrecy yet** — chat keys are static; a stolen keypair can
  decrypt history. Double-ratchet is on the roadmap.
- **Email metadata** — your providers see that two addresses exchange
  mail (not what, not that it is Vault).
- **Latency** — plain email delivery is 30–60 s; IMAP IDLE brings it to
  ~1 s while the app is alive. A push relay is planned.
- **Attachments** are capped by your mail provider (typically 25–30 MB).

### Install (prebuilt binaries)

**Android** — download the signed APK and open it:
[vault-0.1.147.apk](https://github.com/kmakan/vault/releases/download/v0.1.147/vault-0.1.147.apk)
(21 MB, Android 7+). The system will ask to allow installs from this source —
allow it. The APK is signed with the Vault release key, so future versions
install over it without data loss; in-app updates: Settings → Help →
"Check for updates".

**Linux (Debian/Ubuntu)** — deb package:
```bash
sudo dpkg -i Vault_0.1.147_amd64.deb   # or: sudo apt install ./Vault_0.1.147_amd64.deb
```
**Linux (any distro)** — portable tar.gz:
```bash
tar xzf vault-desktop-0.1.147-linux-x86_64.tar.gz
./vault-desktop
```
Runtime deps on Ubuntu 22.04+: `libwebkit2gtk-4.1-0` (pulled in automatically
by the .deb).

**Windows / macOS** — builds in progress; use the CLI meanwhile.

**Terminal (CLI)** — needs Rust 1.75+ only:
```bash
cargo install --git https://github.com/kmakan/vault --bin vault-client
```

All files are also mirrored at [vault-msg.ru/releases](https://vault-msg.ru/releases/)
and in [GitHub Releases](https://github.com/kmakan/vault/releases).

### Build from source

Prerequisites: Rust 1.75+ (`rustup`), Node.js 18+; for Android — JDK 17,
Android SDK 35 + NDK 27 (`ANDROID_HOME` set); for desktop on Linux —
`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.

```bash
git clone https://github.com/kmakan/vault.git && cd vault
```

**Desktop (Tauri 2: Rust core + Vue 3 UI).** `npm install` fetches the
frontend toolchain; `npm run tauri build` then compiles the Vue app (vite),
builds the Rust core in release mode and bundles installers:
```bash
cd vault-desktop
npm install
npm run tauri build
# output: src-tauri/target/release/bundle/{deb,rpm,appimage}/
# bare binary: src-tauri/target/release/vault-desktop
```

**Android.** The Gradle project lives in `vault-desktop/src-tauri/gen/android`
(already configured — no `tauri android init` needed). This builds the Rust
core for ARM and packages the APK:
```bash
cd vault-desktop
npx tauri android build --apk --target aarch64
# output: src-tauri/gen/android/app/build/outputs/apk/universal/release/
```
The result is unsigned (the release keystore is not in this repo) — sign it
with your own keystore before installing (`apksigner` / `zipalign`), or just
use the prebuilt APK above.

**CLI.** Plain Rust, no extra tooling:
```bash
cd vault-client
cargo build --release   # → target/release/vault-client
```

Tests: `cargo test` in each crate (430+ unit/integration tests, real
provider e2e included).

### Security & privacy

- Read [SECURITY.md](SECURITY.md) — design, known limitations, disclosure.
- Read [PRIVACY.md](PRIVACY.md) — what leaves your device (only opaque email).
- Community rules: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

### License

AGPL-3.0 — see [LICENSE](LICENSE). Commercial/dual licensing available on
request.

---

## Русский

Vault превращает обычную почту в приватный мессенджер. Сообщения
шифруются на устройстве (гибрид **ML-KEM-768 + X25519**, постквантово) и
уходят как **обычные письма** через ваш IMAP/SMTP. Серверов Vault не
существует — мессенджер живёт, пока работает почта.

**Возможности:** 1-на-1 и групповые чаты (роли, QR-инвайты, реакции,
редактирование, «удалить у меня», избранное, исчезающие сообщения),
голосовые звонки (Opus + DTLS-SRTP, P2P, без серверов), зашифрованные
вложения, duress/panic-режимы с полным стиранием, SOS с гео, вход по
отпечатку (Android), локальная база SQLite, три языка интерфейса.

**Честно об ограничениях:** нет forward secrecy (в роадмапе), почтовые
метаданные видны провайдеру, доставка 30–60 с (IDLE — ~1 с), размер
вложений ограничен лимитами почты.

Сборка, загрузка и политика безопасности — выше по тексту.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues are tagged
`good-first-issue`.

## Credits

Built with Rust, Vue 3, Tauri 2.
