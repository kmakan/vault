// M0 C1 — Wire format parity: Rust VaultEnvelope ↔ JS parseEnvelope.
// Rust canonical (vault-client/src/vault/protocol.rs) использует X-headers
// + envelope_json {version, msg_type, from, to, message_id, in_reply_to, timestamp}.
// JS parseEnvelope читает encrypted_payload {vault:1, id, text, name, avatar, ...}.
// Этот smoke validate roundtrip между слоями без реального Rust runtime —
// использует contract spec из docs/M0-WIRE-FORMAT-PARITY.md.

import { parseEnvelope } from '../src/message-format.js';

const ok = (label, cond) => {
  if (cond) { console.log('  ✓ ' + label); globalThis.__m0ok = (globalThis.__m0ok || 0) + 1; }
  else  { console.log('  ✗ ' + label); globalThis.__m0fail = (globalThis.__m0fail || 0) + 1; }
};

// ── 1. Rust VaultMessage::new → to_email_body ─────────────────────
// Симуляция Rust to_email_body: X-headers + envelope_json + payload_json
function toEmailBodyRust(env, payload) {
  const envelopeJson = JSON.stringify({
    version: env.version, msg_type: env.msg_type,
    from: env.from, to: env.to, message_id: env.message_id,
    in_reply_to: env.in_reply_to || null,
    timestamp: env.timestamp,
  });
  return `X-Vault-Encrypted: 1\r\nX-Vault-Type: ${env.msg_type}\r\nX-Vault-ID: ${env.message_id}\r\nX-Vault-From: ${env.from}\r\nX-Vault-Reply-To: ${env.in_reply_to || ''}\r\n\r\n${envelopeJson}\n${JSON.stringify(payload)}`;
}

const rustEnv = {
  version: '1', msg_type: 'message',
  from: 'alice@x.ru', to: 'bob@x.ru',
  message_id: 'msg-1', in_reply_to: null,
  timestamp: '2026-10-16T10:00:00Z',
};
const appPayload = { vault: 1, id: 'msg-1', text: 'привет', name: 'Аня', avatar: '', ts: 1700000000, key: 'PUB', pq: '', ttl: 0, tok: '' };
const emailBody = toEmailBodyRust(rustEnv, appPayload);

// X-headers parsing
const headers = {};
const parts = emailBody.split('\r\n\r\n');
for (const line of parts[0].split('\r\n')) {
  const [k, ...rest] = line.split(': ');
  headers[k] = rest.join(' ');
}
ok('X-Vault-Encrypted: 1', headers['X-Vault-Encrypted'] === '1');
ok('X-Vault-Type: message', headers['X-Vault-Type'] === 'message');
ok('X-Vault-ID: msg-1', headers['X-Vault-ID'] === 'msg-1');
ok('X-Vault-From', headers['X-Vault-From'] === 'alice@x.ru');

// envelope_json parse (Rust VaultEnvelope)
const [envelopeJson, payloadStr] = parts[1].split('\n');
const envParsed = JSON.parse(envelopeJson);
ok('VaultEnvelope.version == "1"', envParsed.version === '1');
ok('VaultEnvelope.msg_type == message', envParsed.msg_type === 'message');
ok('VaultEnvelope.from', envParsed.from === 'alice@x.ru');
ok('VaultEnvelope.message_id == msg-1', envParsed.message_id === 'msg-1');
ok('VaultEnvelope.in_reply_to null', envParsed.in_reply_to === null);

// ── 2. JS parseEnvelope ↔ Rust payload layer ───────────────────────
const parsedEnv = parseEnvelope(payloadStr);
ok('parseEnvelope: id == msg-1', parsedEnv.id === 'msg-1');
ok('parseEnvelope: text == привет', parsedEnv.text === 'привет');
ok('parseEnvelope: name == Аня', parsedEnv.name === 'Аня');
ok('parseEnvelope: ts == 1700000000', parsedEnv.ts === 1700000000);

// ── 3. Reply (in_reply_to) parity ──────────────────────────────────
const rustReplyEnv = { ...rustEnv, in_reply_to: 'msg-1', message_id: 'msg-2' };
const replyBody = toEmailBodyRust(rustReplyEnv, { ...appPayload, id: 'msg-2' });
const replyParts = replyBody.split('\r\n\r\n');
const replyEnv = JSON.parse(replyParts[1].split('\n')[0]);
ok('reply: in_reply_to == msg-1', replyEnv.in_reply_to === 'msg-1');
ok('reply: message_id == msg-2', replyEnv.message_id === 'msg-2');

// ── 4. Legacy plaintext (vault !== 1) → null ───────────────────────
ok('legacy plaintext → parseEnvelope null', parseEnvelope('just text') === null);

console.log(`\nM0 C1 wire-parity: ${globalThis.__m0ok}/23 passed, ${globalThis.__m0fail || 0} failed`);
if (globalThis.__m0fail) process.exit(1);
