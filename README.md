# Vault

> **A private messenger that lives inside ordinary email.**
> No servers. No phone numbers. Post-quantum E2E encryption. Voice calls.
>
> Version: 0.1.142 · License: AGPL-3.0 · Status: Beta

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

### Build from source

```bash
# Desktop (Tauri 2, Rust + Vue 3)
cd vault-desktop && npm install && npm run tauri build

# Android (JDK 17, Android SDK 35, NDK 27)
cd vault-desktop && npx tauri android build

# CLI
cd vault-client && cargo build --release
```

Tests: `cargo test` in each crate (220+ unit/integration tests, real
provider e2e included).

### Downloads

Downloads and changelog: **[vault-msg.ru](https://vault-msg.ru)** (Android APK + desktop builds, `latest.json` for in-app update checks).

### Security & privacy

- Read [SECURITY.md](SECURITY.md) — design, known limitations, disclosure.
- Read [PRIVACY.md](PRIVACY.md) — what leaves your device (only opaque email).

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
