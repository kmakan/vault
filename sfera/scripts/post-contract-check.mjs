#!/usr/bin/env node
// Контракт богатого поста Rust ↔ JS (ADR-006 §3).
//
// Проверяет, что JS-адаптер:
//   1) канонизирует пост с аудиторией и медиа ровно как Rust (JCS);
//   2) принимает ed25519-подпись Rust по байтам «домен ‖ JCS»;
//   3) видит ожидаемую форму полей (audience.epoch, media[].blob_id, fp);
//   4) отвергает правку тела.
// Решения о правах/ключах JS не принимает — только проверяет форму.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  '..',
  'crates',
  'social-post',
  'tests',
  'fixtures',
  'post-contract.json',
);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// JCS (RFC 8785) для полей этой фикстуры: строки, целые, массивы, объекты.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));
const post = fx.post;

// 1. Канонический JSON совпадает с эталоном Rust.
const canonical = canonicalize(post);
if (canonical !== fx.canonical_post) {
  fail(`JCS разошёлся.\n  Rust: ${fx.canonical_post}\n  JS:   ${canonical}`);
}

// 2. Подпись Rust проверяется по тем же байтам.
const domain = Buffer.from(fx.domain, 'utf8');
const publicKey = createPublicKey({
  key: {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(post.author.pub_key, 'hex').toString('base64url'),
  },
  format: 'jwk',
});
const sig = Buffer.from(fx.sig_hex, 'hex');
if (!cryptoVerify(null, Buffer.concat([domain, Buffer.from(canonical, 'utf8')]), publicKey, sig)) {
  fail('JS не принял подпись богатого поста (домен/JCS/pub_key разошлись)');
}

// 3. Форма полей, которую ждёт UI.
if (post.v !== 1) fail(`bad version ${post.v}`);
if (post.type !== 'social_post') fail(`bad type ${post.type}`);
if (typeof post.body !== 'string') fail('body must be a string');
if (!post.audience || typeof post.audience.id !== 'string' || post.audience.id === '') {
  fail('audience.id missing');
}
if (!Number.isInteger(post.audience.epoch) || post.audience.epoch < 1) {
  fail('audience.epoch must be >= 1');
}
const kinds = new Set(['all_contacts', 'sphere', 'selected', 'all_except']);
if (!post.audience.spec || !kinds.has(post.audience.spec.kind)) {
  fail('audience.spec.kind invalid');
}
if (!/^([0-9a-f]{2}:){7}[0-9a-f]{2}:\*{4}$/.test(post.author.fp)) {
  fail(`author.fp must be xx:...:****, got ${post.author.fp}`);
}
if (!Array.isArray(post.media) || post.media.length === 0) fail('media must be non-empty');
for (const m of post.media) {
  if (!/^[0-9a-f]{64}$/.test(m.blob_id)) fail(`bad blob_id ${m.blob_id}`);
  if (m.thumb_blob_id !== undefined && !/^[0-9a-f]{64}$/.test(m.thumb_blob_id)) {
    fail(`bad thumb_blob_id ${m.thumb_blob_id}`);
  }
  if (typeof m.mime !== 'string' || m.mime === '') fail('media.mime empty');
  if (!(m.size > 0)) fail('media.size must be > 0');
}

// 4. Негатив: правка тела ломает подпись и в JS.
const evil = JSON.parse(JSON.stringify(post));
evil.body += '!';
if (
  cryptoVerify(
    null,
    Buffer.concat([domain, Buffer.from(canonicalize(evil), 'utf8')]),
    publicKey,
    sig,
  )
) {
  fail('tampered body was accepted');
}

console.log(
  `OK: post contract — audience=${post.audience.spec.kind} epoch=${post.audience.epoch}, media=${post.media.length}`,
);
