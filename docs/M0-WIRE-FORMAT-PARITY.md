# M0 C1 — Wire Format Parity (VaultEnvelope ↔ parseEnvelope)

## Canonical format (Rust `vault-client/src/vault/protocol.rs`)

```email
X-Vault-Encrypted: 1
X-Vault-Type: message|receipt|key_exchange|key_verify
X-Vault-ID: <message_id>
X-Vault-From: <sender_email>
X-Vault-Reply-To: <in_reply_to>     # empty если нет

<envelope_json>
<encrypted_payload>
```

`envelope_json`:
```json
{"version":"1", "msg_type":"message", "from":"alice@x", "to":"bob@x",
 "message_id":"msg-1", "in_reply_to":null, "timestamp":"2026-...Z"}
```

`encrypted_payload` = зашифрованный JSON (base64), распаковывается в приложенческий конверт:
```json
{"id":"msg-1", "text":"привет", "name":"Аня", "avatar":"...", "ts":1700000000}
```

## Field mapping (Rust canonical ↔ JS legacy aliases)

| Rust `VaultEnvelope` | JS `parseEnvelope`/`buildEnvelope` | Note |
|---|---|---|
| `version:"1"` | `vault:1` | canonical `version`, JS читает `obj.vault === 1` (backward-compat: number 1, не string) |
| `msg_type` | `(в payload)` / `obj.type` для call_* | core-level; app-level type в encrypted_payload |
| `from` | `(X-Vault-From)` | core; JS использует `ctx.canonicalOf(from)` |
| `message_id` | `id` | canonical в envelope; JS `obj.id` в payload (legacy alias) |
| `in_reply_to` | `in_reply_to` in payload | threading — OK |
| `timestamp` (RFC3339) | `ts` (unix ms) в payload | core=RFC3339, app=unix ms — OK |

## Divergence log

1. **vault:1 vs version:"1"** — Rust canonical `version` string; JS legacy `vault:1` number. **Fix:** JS `parseEnvelope` читает `obj.vault === 1` (OK), Rust `from_email_body` игнорирует `vault` (core canonical — `version`). ✅ OK как есть.
2. **message_id vs id** — Rust canonical `message_id`; JS legacy `id` в payload. **Fix:** `message-format.js parseEnvelope` мэппит `env.id = obj.id` (payload), core `message_id` в envelope — слой читается отдельно. ✅ OK.
3. **timestamp vs ts** — core RFC3339, app unix ms. ✅ OK.

## Action items (M0 C1)

- [x] Doc parity: `docs/M0-WIRE-FORMAT-PARITY.md` (this file)
- [ ] JS `message-format.js parseEnvelope`: использовать `from_email_body`-style parser (core envelope + X-headers), мэппить `obj.id → env.id`, `obj.ts → env.ts`
- [ ] `m0-e2e-parity.mjs`: Rust `VaultMessage::new` → `to_email_body` ↔ JS `parseEnvelope` roundtrip (23 assertions)
