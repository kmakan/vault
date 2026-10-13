// Node-смоук src/crypto.js — гейт isEncrypted() на разных форматах тела.
// Мотивация (инцидент 12.10.2026): PQ-гибридный конверт "PQ1:k|s|wire" не
// base64, старая проверка через atob() возвращала false, и classify()
// отбрасывал ВСЕ гибридные конверты молча — получатель переставал понимать
// отправителя целиком, как только у того появлялся PQ-ключ.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = import.meta.dirname;
const MOCKS = '/tmp/crypto-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// atob/btoa — Node 16+ есть глобально, но подстрахуемся для старых.
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
}

let src = readFileSync(ROOT + '/../src/crypto.js', 'utf8');
src = src.replace("from '@tauri-apps/api/core'", 'from "' + MOCKS + '/core.js"');
writeFileSync(MOCKS + '/crypto.mjs', src);
writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__invoke(...a);');

const mod = await import(MOCKS + '/crypto.mjs');
const C = mod.CryptoClient;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' — ' + JSON.stringify(extra) : '')); }
}

const c = new C();
c.privateKey = 'A'.repeat(64);      // ключ есть → гейт «мы вообще в системе»
const nokey = new C();               // ключа нет → ничего не принимаем

// ── 1. legacy X25519 (base64) ─────────────────────────────────
console.log('1. legacy-конверт (base64)');
{
  const body = Buffer.from('x'.repeat(40), 'binary').toString('base64');
  check('base64 принимается', c.isEncrypted(body) === true);
  check('переносы строк не мешают (SMTP folding)', c.isEncrypted(body.replace(/(.{20})/g, '$1\r\n')) === true);
  check('без приватного ключа — false', nokey.isEncrypted(body) === false);
  check('слишком короткое тело — false', c.isEncrypted(Buffer.from('short').toString('base64')) === false);
  check('пустое тело — false', c.isEncrypted('') === false);
}

// ── 2. мусор ──────────────────────────────────────────────────
console.log('2. мусор и не-конверты');
{
  check('обычный текст — false', c.isEncrypted('Привет, это письмо') === false);
  check('HTML — false', c.isEncrypted('<html><body>hi</body></html>') === false);
  check('DSN — false', c.isEncrypted('Final-Recipient: rfc822; a@b.ru') === false);
}

// ── 3. PQ-гибрид (регресс 12.10.2026) ─────────────────────────
console.log('3. PQ-гибрид "PQ1:<kemct>|<sender_ek>|<wire>"');
{
  const hybrid = 'PQ1:' + 'K'.repeat(64) + '|' + 'E'.repeat(64) + '|' + Buffer.from('w'.repeat(40), 'binary').toString('base64');
  check('PQ1 принимается (было false → конверт терялся молча)', c.isEncrypted(hybrid) === true, { got: c.isEncrypted(hybrid) });
  check('PQ1 без приватного ключа — false', nokey.isEncrypted(hybrid) === false);
  check('PQ1 с лишним разделителем — false', c.isEncrypted(hybrid + '|extra') === false);
  check('PQ1 без полей — false', c.isEncrypted('PQ1:') === false);
  check('PQ1 с ведущими пробелами/переносами — true', c.isEncrypted('\r\n  ' + hybrid + '  \r\n') === true);
}

// ── 4. формат, который реально шлёт lib.rs ───────────────────
console.log('4. сверка с форматом lib.rs::encrypt_vault_message');
{
  // Ровно то, что собирает Rust: format!("PQ1:{kemct}|{pq}|{wire}")
  const kemct = 'A1B2C3', pq = 'D4E5F6', wire = 'WIREBASE64==';
  const hybrid = `PQ1:${kemct}|${pq}|${wire}`;
  check('формат Rust распознаётся', c.isEncrypted(hybrid) === true);
  check('3 поля по разделителю', hybrid.split('|').length === 3);
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);