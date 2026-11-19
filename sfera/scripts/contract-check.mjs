// Контракт между Rust (social-model) и JS.
//
// Проверяет, что JS-адаптер:
//   1) даёт ровно ту же каноническую форму JCS, что Rust (serde_jcs / RFC 8785);
//   2) проверяет ed25519-подпись, сделанную Rust, по тем же байтам (домен ‖ JCS);
//   3) видит fp как отпечаток xx:...:****, а не email.
// Если расходятся — подпись поста с телефона не пройдёт проверку на десктопе.
//
// Это адаптер к протокольным решениям ядра, а не вторая реализация правила:
// эталоны (canonical_post, sig_hex) зафиксированы Rust-тестами в фикстуре.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'crates', 'social-model', 'tests', 'fixtures', 'author-contract.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

// JCS (RFC 8785): ключи сортируются по UTF-16, числа — как в JSON.stringify,
// строки экранируются JSON.stringify. Для полей этой фикстуры (строки и целые)
// достаточно сортировки ключей + компактного вывода.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const keys = Object.keys(value).sort(); // UTF-16 порядок — как требует JCS
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

function fail(msg) {
  console.error(`КОНТРАКТ НАРУШЕН: ${msg}`);
  process.exit(1);
}

// 1. Канонический JSON поста совпадает с эталоном Rust.
const actualCanonical = canonicalize(fixture.post);
if (actualCanonical !== fixture.canonical_post) {
  fail(
    `канонический JSON разошёлся между Rust и JS.\n` +
      `  Rust (эталон): ${fixture.canonical_post}\n  JS (факт):     ${actualCanonical}`,
  );
}

// 2. Подпись, сделанная Rust, проверяется JS по тем же байтам: домен ‖ JCS.
//    Домен из фикстуры — с NUL на конце (в JSON записан как \u0000).
const domain = Buffer.from(fixture.signing.domain, 'utf8');
const signedBytes = Buffer.concat([domain, Buffer.from(actualCanonical, 'utf8')]);
const pubKeyHex = fixture.author.pub_key;
const sigHex = fixture.signing.sig_hex;

// Node принимает ed25519-ключ как SPKI DER или как raw 32 байта через JWK.
const publicKey = createPublicKey({
  key: {
    kty: 'OKP',
    crv: 'Ed25519',
    x: Buffer.from(pubKeyHex, 'hex').toString('base64url'),
  },
  format: 'jwk',
});

if (!cryptoVerify(null, signedBytes, publicKey, Buffer.from(sigHex, 'hex'))) {
  fail('JS не принял ed25519-подпись, сделанную Rust (домен/JCS/pub_key разошлись)');
}

// 3. fp — отпечаток xx:...:****, не email.
const fp = fixture.author.fp;
if (!/^([0-9a-f]{2}:){7}[0-9a-f]{2}:\*{4}$/.test(fp) || fp.includes('@')) {
  fail(`fp должен быть отпечатком xx:...:****, получен ${fp}`);
}

console.log('OK: контракт Rust↔JS зелёный (JCS, ed25519-подпись, fingerprint)');
