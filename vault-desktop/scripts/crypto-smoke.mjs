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
  // ФОРМАТ БЕРЁТСЯ ИЗ ОБЩЕЙ ФИКСТУРЫ, а не копируется здесь: раньше формат
  // был продублирован в этом смоуке, и расхождение с продовой сборкой Rust
  // проходило незамеченным (тест проверял копию правила). Теперь правка
  // формата в Rust ломает и его тест, и этот.
  const fixture = JSON.parse(readFileSync(
    ROOT + '/../../vault-client/tests/fixtures/pq-body-contract.json', 'utf8'));
  const [kemct, pq, wire] = fixture.sample_parts;
  const hybrid = fixture.prefix + [kemct, pq, wire].join(fixture.separator);
  check('формат Rust распознаётся', c.isEncrypted(hybrid) === true);
  check('поля по разделителю из фикстуры',
    hybrid.slice(fixture.prefix.length).split(fixture.separator).length === fixture.field_count);
  check('префикс фикстуры — тот же, что у Rust', hybrid.startsWith(fixture.prefix));
}

// ── 5. пэйдинг base64 (decode_quoted_printable съедал '=') ──────
console.log('5. re-pad: тело без пэйдинга');
{
  // Старые сборки съедали '=' на конце тела. Без восстановления пэйдинга atob
  // бросает, и письмо молча считается незашифрованным (isEncrypted → false).
  const noPad = Buffer.from('x'.repeat(41), 'binary').toString('base64').replace(/=+$/, '');
  check('тело без пэйдинга распознаётся (re-pad)', c.isEncrypted(noPad) === true);
  check('тело без пэйдинга и без ключа — false', nokey.isEncrypted(noPad) === false);
}

// ── 6. isValidKeypair — контракт сохранённой пары ключей ──────
console.log('6. isValidKeypair');
{
  const pk = 'a'.repeat(64);
  check('валидная пара принимается',
    mod.isValidKeypair({ public_key: 'b'.repeat(64), private_key: pk }) === true);
  check('приватный = публичный — невалидна (такая пара в хранилище — мусор)',
    mod.isValidKeypair({ public_key: pk, private_key: pk }) === false);
  check('не-hex — невалидна',
    mod.isValidKeypair({ public_key: 'z'.repeat(64), private_key: pk }) === false);
  check('не-hex — невалидна (и публичный)',
    mod.isValidKeypair({ public_key: pk, private_key: 'z'.repeat(64) }) === false);
  check('короткий ключ — невалидна',
    mod.isValidKeypair({ public_key: 'ab', private_key: pk }) === false);
  check('не объект — невалидна',
    mod.isValidKeypair(null) === false && mod.isValidKeypair('ключ') === false);
  check('без private_key — невалидна',
    mod.isValidKeypair({ public_key: pk }) === false);
}

// ── save_peer_key: OWN-ADDRESS GUARD моста ────────────────────
// Командный аргумент `own_email` — Option, и `gate:tauri-args` разрешает его
// не писать. Молча выключенный страж = свой аккаунт снова в контактах, поэтому
// форма вызова меряется здесь, а не «надеясь на фронт».
console.log('save_peer_key: своя почта уходит в команду');
{
  const calls = [];
  globalThis.__invoke = async (cmd, args) => { calls.push([cmd, args]); return null; };
  const cli = new C();
  await cli.savePeerKey('peer@x.y', 'PEERPK', 'Peer', 'PEERPQ', 'me@x.y');
  await cli.savePeerKey('p2@x.y', 'PEERPK2');
  check('команда вызвана дважды', calls.length === 2 && calls[0][0] === 'save_peer_key', calls.map((x) => x[0]));
  check('своя почта ушла как ownEmail', calls[0][1].ownEmail === 'me@x.y', calls[0][1]);
  check('PQ-ключ и метка на месте', calls[0][1].pqPublicKey === 'PEERPQ' && calls[0][1].label === 'Peer', calls[0][1]);
  check('без своей почты — null, а не пустая строка', calls[1][1].ownEmail === null, calls[1][1]);
}

console.log('');
console.log('ИТОГО: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);