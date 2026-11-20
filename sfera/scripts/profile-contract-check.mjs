#!/usr/bin/env node
// Контракт профиля Rust ↔ JS (ADR-006 §7.6).
//
// Проверяет, что JS-адаптер:
//   1) канонизирует профиль ровно как Rust (JCS);
//   2) принимает ed25519-подпись Rust по байтам «домен ‖ JCS»;
//   3) видит ожидаемую форму полей (v/type/fp/blob_id/ссылки);
//   4) не принимает подпись из домена поста и правку имени.
// Решения о видимости профиля JS не принимает — только проверяет форму.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  '..',
  'crates',
  'social-profile',
  'tests',
  'fixtures',
  'profile-contract.json',
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
const profile = fx.profile;

// 1. Канонический JSON совпадает с эталоном Rust.
const canonical = canonicalize(profile);
if (canonical !== fx.canonical_profile) {
  fail(`JCS разошёлся.\n  Rust: ${fx.canonical_profile}\n  JS:   ${canonical}`);
}

// 2. Подпись Rust проверяется по тем же байтам.
const domain = Buffer.from(fx.domain, 'utf8');
if (domain.toString('utf8') !== 'sfera-profile:v1\0') {
  fail(`-profile domain mismatch: ${JSON.stringify(fx.domain)}`);
}
const publicKey = createPublicKey({
  key: {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(profile.author.pub_key, 'hex').toString('base64url'),
  },
  format: 'jwk',
});
const sig = Buffer.from(fx.sig_hex, 'hex');
const signedBytes = Buffer.concat([domain, Buffer.from(canonical, 'utf8')]);
if (!cryptoVerify(null, signedBytes, publicKey, sig)) {
  fail('JS не принял подпись профиля (домен/JCS/pub_key разошлись)');
}

// 3. Форма полей, которую ждёт UI.
if (profile.v !== 1) fail(`bad version ${profile.v}`);
if (profile.type !== 'social_profile') fail(`bad type ${profile.type}`);
if (typeof profile.display_name !== 'string' || profile.display_name === '') {
  fail('display_name missing');
}
if (typeof profile.bio !== 'string') fail('bio must be a string');
if (!/^([0-9a-f]{2}:){7}[0-9a-f]{2}:\*{4}$/.test(profile.author.fp)) {
  fail(`author.fp must be xx:...:****, got ${profile.author.fp}`);
}
if (profile.avatar !== undefined) {
  if (!/^[0-9a-f]{64}$/.test(profile.avatar.blob_id)) {
    fail(`bad avatar.blob_id ${profile.avatar.blob_id}`);
  }
  if (typeof profile.avatar.mime !== 'string' || profile.avatar.mime === '') {
    fail('avatar.mime empty');
  }
  if (!(profile.avatar.size > 0)) fail('avatar.size must be > 0');
}
if (!Array.isArray(profile.links) || profile.links.length > 8) fail('bad links');
for (const link of profile.links) {
  if (typeof link.label !== 'string' || link.label === '') fail('link.label empty');
  if (!/^(https?:\/\/\S+|mailto:\S+@\S+)$/.test(link.url)) {
    fail(`bad link url ${link.url}`);
  }
}

// 4. Негатив: подпись из домена поста и правка имени не принимаются.
const postDomain = Buffer.from('sfera-post:v1\0', 'utf8');
if (cryptoVerify(null, Buffer.concat([postDomain, Buffer.from(canonical, 'utf8')]), publicKey, sig)) {
  fail('profile signature was accepted under post domain');
}
const evil = JSON.parse(JSON.stringify(profile));
evil.display_name += '!';
if (
  cryptoVerify(
    null,
    Buffer.concat([domain, Buffer.from(canonicalize(evil), 'utf8')]),
    publicKey,
    sig,
  )
) {
  fail('tampered display_name was accepted');
}

console.log(
  `OK: profile contract — domain=${JSON.stringify(fx.domain)} links=${profile.links.length} avatar=${profile.avatar ? 'yes' : 'no'}`,
);
