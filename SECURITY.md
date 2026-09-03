# Security Policy

## Design summary

Vault is a serverless E2E messenger over email. What protects you:

- **Hybrid post-quantum key exchange** — ML-KEM-768 + X25519, session key
  derived via HKDF-SHA256 over both shared secrets (`PQ1` envelope format).
  Breaking either primitive alone does not yield the key.
- **AEAD encryption** — XChaCha20-Poly1305 (24-byte nonce) for messages,
  attachments, and local storage.
- **Stealth transport** — messages are indistinguishable from ordinary
  email: empty subjects, no identifying headers, AAD tag bound to the
  ciphertext, not the wire.
- **Local-first keys** — keypairs live only on your device
  (`~/.vault/`), encrypted with a PBKDF2-derived key from your password.
  Optional BIP-39 (12-word) escrow to your own mailbox is end-to-end
  encrypted with your key.
- **Voice calls** — Opus frames encrypted with XChaCha20-Poly1305 and
  carried over DTLS-SRTP; signaling reuses the same E2E envelopes.
- **Duress controls** — a duress password wipes local state; a panic code
  wipes and exits; optional SOS broadcast with geolocation.
- **No telemetry** — the app makes no network calls except IMAP/SMTP to
  your own configured mail servers.
- **Android** — `allowBackup=false`, cloud backup and device transfer are
  explicitly excluded for all app data.

## Known limitations (honest list)

- **No forward secrecy yet** — chat keys are static; a leaked keypair can
  decrypt past messages. Double-ratchet is planned (roadmap M6).
- **Metadata** — your email provider sees that you exchanged mail with a
  contact (addresses, timestamps), not the content or that it is Vault.
- **Delivery timing** — over plain email, message latency is 30–60 s
  (IDLE reduces it); an optional relay will improve this.

## Reporting a vulnerability

Email: **security@vault-msg.ru** — we aim to acknowledge within 72 hours
and release a fix before public disclosure. Please do not open a public
issue for security bugs.

## Supported versions

| Version | Supported |
|---------|-----------|
| 0.1.x (latest) | ✅ |
| older | ❌ (pre-release) |
