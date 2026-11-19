// Контракт между Rust (social-model) и JS.
//
// Проверяет, что JS-адаптер канонического JSON даёт ровно ту же форму, что
// Rust-ядро (serde_jcs / RFC 8785) для общей фикстуры. Если расходятся —
// подпись поста, посчитанная на телефоне, не пройдёт проверку на десктопе.
//
// Это адаптер протокольному решению ядра, а не вторая реализация правила:
// эталон — canonical_post из фикстуры, зафиксированный Rust-тестами.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'crates', 'social-model', 'tests', 'fixtures', 'author-contract.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

// JCS (RFC 8785): ключи сортируются по UTF-16, числа — как в JSON.stringify,
// строки экранируются JSON.stringify. Для полей этой фикстуры (строки и
// целые) достаточно сортировки ключей + компактного вывода.
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

const actual = canonicalize(fixture.post);
const expected = fixture.canonical_post;

if (actual !== expected) {
  console.error('КОНТРАКТ НАРУШЕН: канонический JSON разошёлся между Rust и JS.');
  console.error(`  Rust (эталон): ${expected}`);
  console.error(`  JS (факт):     ${actual}`);
  process.exit(1);
}

// Отпечаток — ID пользователя: проверяем, что он не похож на email и имеет
// форму xx:...:**** (значение из фикстуры зафиксировано Rust-тестами).
const fp = fixture.author.fp;
if (!/^([0-9a-f]{2}:){7}[0-9a-f]{2}:\*{4}$/.test(fp) || fp.includes('@')) {
  console.error(`КОНТРАКТ НАРУШЕН: fp должен быть отпечатком xx:...:****, получен ${fp}`);
  process.exit(1);
}

console.log('OK: контракт Rust↔JS зелёный (.canonical_post, fingerprint form)');
