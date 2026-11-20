#!/usr/bin/env node
// Контракт Rust ↔ JS для формата VAULTBLOB1 (ADR-006 §5).
//
// Проверяем не «примерно то же», а байт-в-байт:
//   1) заголовок (magic/ver/chunk_size/nonce_prefix/total);
//   2) blob_id == SHA-256(ciphertext);
//   3) HKDF-вывод ключа миниатюры совпадает с Rust;
//   4) каждый чанк расшифровывается XChaCha20-Poly1305 (HChaCha20 + IETF
//      ChaCha20-Poly1305 из Node), с тем же AAD, что строит Rust.
// Если Rust и JS разойдутся в раскладке nonce или AAD — расшифровка упадёт.

import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  '..',
  'crates',
  'social-media',
  'tests',
  'fixtures',
  'blob-contract.json',
);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function rotl(v, n) {
  v >>>= 0;
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function qr(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl(s[b] ^ s[c], 7);
}

// HChaCha20 (draft-irtf-cfrg-xchacha §2.2): 20 раундов, выход = слова 0..3 и 12..15.
function hchacha20(key, nonce16) {
  const k = new Uint32Array(8);
  const n = new Uint32Array(4);
  for (let i = 0; i < 8; i++) k[i] = key.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) n[i] = nonce16.readUInt32LE(i * 4);

  // HChaCha20: constants | все 8 слов ключа | 4 слова nonce (не counter!).
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) s[4 + i] = k[i];
  for (let i = 0; i < 4; i++) s[12 + i] = n[i];

  for (let r = 0; r < 10; r++) {
    qr(s, 0, 4, 8, 12);
    qr(s, 1, 5, 9, 13);
    qr(s, 2, 6, 10, 14);
    qr(s, 3, 7, 11, 15);
    qr(s, 0, 5, 10, 15);
    qr(s, 1, 6, 11, 12);
    qr(s, 2, 7, 8, 13);
    qr(s, 3, 4, 9, 14);
  }

  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeUInt32LE(s[i], i * 4);
  for (let i = 0; i < 4; i++) out.writeUInt32LE(s[12 + i], 16 + i * 4);
  return out;
}

function u64le(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

// XChaCha20-Poly1305: subkey = HChaCha20(key, nonce[0..16]);
// IETF nonce = 0x00000000 || nonce[16..24].
function xchachaDecrypt(key32, nonce24, sealed, aad) {
  if (nonce24.length !== 24) throw new Error('xchacha nonce must be 24 bytes');
  const subkey = hchacha20(key32, nonce24.subarray(0, 16));
  const ietfNonce = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)]);
  const tag = sealed.subarray(sealed.length - 16);
  const ct = sealed.subarray(0, sealed.length - 16);
  const d = createDecipheriv('chacha20-poly1305', subkey, ietfNonce, {
    authTagLength: 16,
  });
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

function parseAndDecrypt(blob, key32, expectedPlainHex, label) {
  if (blob.length < 71) fail(`${label}: blob shorter than header`);
  if (blob.subarray(0, 10).toString('latin1') !== 'VAULTBLOB1') {
    fail(`${label}: bad magic`);
  }
  if (blob[10] !== 1) fail(`${label}: bad version ${blob[10]}`);

  const chunkSize = blob.readUInt32LE(11);
  if (chunkSize === 0) fail(`${label}: chunk_size is zero`);
  const blobId = blob.subarray(15, 47);
  const noncePrefix = blob.subarray(47, 63);
  const total = Number(blob.readBigUInt64LE(63));
  const ciphertext = blob.subarray(71);

  const chunkCount = total === 0 ? 0 : Math.ceil(total / chunkSize);
  const expectedCt = total + chunkCount * 16;
  if (ciphertext.length !== expectedCt) {
    fail(`${label}: ciphertext ${ciphertext.length} != expected ${expectedCt}`);
  }

  if (!sha256(ciphertext).equals(blobId)) {
    fail(`${label}: blob_id != SHA-256(ciphertext)`);
  }

  const domain = Buffer.from('7661756c74626c6f623a763100', 'hex'); // "vaultblob:v1\0"
  const parts = [];
  for (let i = 0; i < chunkCount; i++) {
    const ptLen = Math.min(chunkSize, total - i * chunkSize);
    const ctLen = ptLen + 16;
    const off = i * (chunkSize + 16);
    const chunk = ciphertext.subarray(off, off + ctLen);
    const nonce = Buffer.concat([noncePrefix, u64le(i)]);
    const aad = Buffer.concat([domain, noncePrefix, u64le(i), u64le(total)]);
    parts.push(xchachaDecrypt(key32, nonce, chunk, aad));
  }

  const plain = Buffer.concat(parts);
  if (plain.toString('hex') !== expectedPlainHex) {
    fail(`${label}: plaintext mismatch`);
  }
  return { blobId, noncePrefix, chunkSize, total, chunkCount, ciphertext };
}

const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));
const key = Buffer.from(fx.file_key_hex, 'hex');

if (key.length !== 32) fail('file_key must be 32 bytes');
if (Buffer.from(fx.nonce_prefix_hex, 'hex').length !== 16) {
  fail('nonce_prefix must be 16 bytes');
}

// 1-4: полный блоб.
const parsed = parseAndDecrypt(
  Buffer.from(fx.blob_hex, 'hex'),
  key,
  fx.plaintext_hex,
  'main blob',
);
if (parsed.blobId.toString('hex') !== fx.blob_id_hex) {
  fail('main blob_id does not match fixture');
}

// Миниатюра: ключ выводится HKDF, шифр тот же.
const thumbInfo = Buffer.from(fx.thumb.thumb_info_hex, 'hex');
const thumbKey = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), thumbInfo, 32));
if (thumbKey.toString('hex') !== fx.thumb.thumb_key_hex) {
  fail('thumb key from HKDF does not match Rust');
}
parseAndDecrypt(
  Buffer.from(fx.thumb.blob_hex, 'hex'),
  thumbKey,
  fx.thumb.plaintext_hex,
  'thumbnail blob',
);

// Негатив 1: подмена байта чанка обязана провалить Poly1305.
const blob = Buffer.from(fx.blob_hex, 'hex');
const chunkSize = blob.readUInt32LE(11);
const noncePrefix = blob.subarray(47, 63);
const total = Number(blob.readBigUInt64LE(63));
const chunk = Buffer.from(blob.subarray(71, 71 + chunkSize + 16));
chunk[5] ^= 0x01;
const nonce0 = Buffer.concat([noncePrefix, u64le(0)]);
const aad0 = Buffer.concat([
  Buffer.from('7661756c74626c6f623a763100', 'hex'),
  noncePrefix,
  u64le(0),
  u64le(total),
]);
let rejected = false;
try {
  xchachaDecrypt(key, nonce0, chunk, aad0);
} catch {
  rejected = true;
}
if (!rejected) fail('tampered chunk was accepted by Poly1305');

// Негатив 2: подмена байта ломает и blob_id (провайдер не подменит молча).
const tampered = Buffer.from(fx.blob_hex, 'hex');
tampered[71 + 5] ^= 0x01;
if (sha256(tampered.subarray(71)).equals(tampered.subarray(15, 47))) {
  fail('tampered blob still matches blob_id');
}

console.log(
  `OK: VAULTBLOB1 Rust↔JS contract — ${parsed.chunkCount} chunks, blob_id=${fx.blob_id_hex.slice(0, 16)}…`,
);
