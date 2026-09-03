# Privacy Policy

**Vault collects nothing. There is no Vault server to collect it from.**

## What exists on your device

- Your mail credentials (IMAP/SMTP) — stored locally, encrypted with a
  key derived from your password (XChaCha20-Poly1305).
- Your keypair (X25519 + ML-KEM-768) — stored locally in `~/.vault/`.
- Chat history, contacts, groups — stored locally in SQLite
  (`vault.db`), bodies of received mail cached encrypted.

## What leaves your device

Only ordinary email: encrypted messages sent through **your own** mail
provider to your recipients' mail providers. Your mail provider sees
metadata (who you wrote to, when) and an opaque base64 body — it cannot
see content, sender key, or that the mail is a Vault message.

## What never leaves your device

- Your password and private keys.
- Decrypted message content.
- Contacts list, chat history, settings.

## Optional features and their data flow

- **Key recovery escrow** — sends one self-addressed email containing
  your key backup, end-to-end encrypted with your own key. Only you can
  decrypt it.
- **SOS** — sends a pre-composed email (with geolocation if permitted)
  to your chosen contacts when the duress/panic code is entered.
- **Update check** — fetches `latest.json` from vault-msg.ru (plain HTTP
  GET; no device identifiers are sent).

## Android

Auto Backup and device-to-device transfer are disabled for all app data
(`allowBackup=false` + extraction rules), so nothing is uploaded to
Google.

## Telemetry / analytics / ads

None. Zero third-party SDKs in the network path.

## Privacy by architecture

Vault is serverless by design: even the developers cannot access your
messages, keys, or contacts — there is no endpoint that holds them.
