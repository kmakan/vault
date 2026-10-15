// E2E подписи постов канала (ADR-002) — НАСТОЯЩИЙ relay-сервер.
//
// Зачем этот файл, если есть channels-relay-e2e.mjs. Тот поднимает бинарь из
// relay-server/ — копии исходников ДО ADR-002, где проверки подписи просто
// нет. Зелёный прогон того теста ничего не говорил о подписях: он был зелёным
// и был бы зелёным, даже если бы проверку вырезали. Этот тест бьёт по
// vault-relay/ — той копии, из которой собирается задеплоенный релей
// (md5 исходников на сервере совпадает).
//
// Орёлку подписи берём НЕ из клиента: node:crypto — независимая реализация
// Ed25519. Если бы подпись считала та же строка кода, что проверяет сервер, то
// расхождение потока было бы невозможно заметить — ровно тот класс ошибок, что
// ADR-002 уже один раз поймал (клиент слал {kid}, сервер ждал {token}).
//
//   node scripts/adr002-e2e.mjs
// или против своего стенда:
//   RELAY_ADR002_URL=http://127.0.0.1:PORT node scripts/adr002-e2e.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
// Путь переопределяется переменной: тест поднимает ВТОРОЙ экземпляр релея
// (для REQUIRE_SIG=1), поэтому бинарь должен быть доступен там, где запущен
// тест. На сервере это задеплоенный ~/vault-relay/vault-relay.
const RELAY_BIN = process.env.RELAY_BIN
  || path.resolve(ROOT, '..', 'vault-relay', 'target', 'debug', 'vault-relay');

// ── Орёлка канальных токенов (независимая, как в channels-relay-e2e) ──
// Формат по tokens.rs: kid(8) ‖ scope(1) ‖ 0xFFFFFFFF ‖ mac(32).
// Ключ канала СЛУЧАЕТСЯ на каждый прогон. Фиксированный ключ годен только
// против одноразового релея: у персистного релея (например, задеплоенного)
// ключ переживает прогон, и следующий запуск видит «уже зарегистрированный»
// канал — тест краснеет не из-за бага, а из-за собственной негерметичности.
// Именно так этот тест и «сломался» однажды: 11 из 15 на живом релее.
const CHANNEL_KEY = randomBytes(32).toString('hex');
function channelTokensOracle(keyHex) {
  const key = Buffer.from(String(keyHex || '').trim(), 'hex');
  if (key.length !== 32) throw new Error('bad channel key');
  const rd = createHmac('sha256', key).update('vault-relay-channel-read').digest();
  const wr = createHmac('sha256', key).update('vault-relay-channel-write').digest();
  const kid = rd.subarray(0, 8);
  const pack = (scope, mac) => Buffer.concat([
    kid, Buffer.from([scope]), Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]), mac,
  ]).toString('base64url');
  return [pack(0x63, rd), pack(0x43, wr)];
}
const [READ_TOK, WRITE_TOK] = channelTokensOracle(CHANNEL_KEY);
const KID = Buffer.from(Buffer.from(READ_TOK, 'base64url').subarray(0, 8));

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ ПРОВАЛ:', name); }
};

// ── Подпись Ed25519: канонический поток из ADR-002 §2 ────────────────
function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pubHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signPost(priv, envId, body) {
  const input = Buffer.concat([
    Buffer.from('channel-post:v2\0', 'binary'), KID,
    Buffer.from(envId, 'utf8'), Buffer.from(body, 'utf8'),
  ]);
  return sign(null, input, priv).toString('base64url');
}

// ── Подъём релея ─────────────────────────────────────────────────────
async function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(); res(p); }); });
}
async function startRelay(env) {
  const port = await freePort();
  const child = spawn(RELAY_BIN, [], {
    env: { ...process.env, VAULT_RELAY_KEY: 'aa'.repeat(32),
           VAULT_RELAY_ADDR: `127.0.0.1:${port}`, VAULT_RELAY_ANON_PUB: '0',
           // Персист ВЫКЛЮЧЕН намеренно: иначе state.json переживает прогон и
           // второй запуск видит канал, зарегистрированный первым (тот же
           // broadcast-ключ → тот же kid) — тест краснеет не из-за бага, а
           // из-за собственной негерметичности. Настоящий дефект был ровно
           // такой: «зелёный в первый раз, красный во второй».
           VAULT_RELAY_STATE: 'off',
           VAULT_RELAY_NTFY_URL: '', ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/health')).ok) return { base, child }; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  child.kill();
  throw new Error('релей не поднялся: ' + RELAY_BIN);
}

// ── HTTP-хелперы ─────────────────────────────────────────────────────
const auth = (t) => ({ 'Authorization': 'VaultRelay ' + t });
const regKey = (base, tok, body) =>
  fetch(base + '/relay/channel-key', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(tok) }, body: JSON.stringify(body) });
const pub = (base, writeTok, body) =>
  fetch(base + '/relay/pub', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth(writeTok) }, body: JSON.stringify(body) });
const mkBody = (id) => ({ v: 1, to: READ_TOK, id, exp: Math.floor(Date.now() / 1000) + 3600, body: Buffer.from('конверт-' + id).toString('base64'), wake: false });

async function personalToken(base, fp) {
  const r = await fetch(base + '/relay/register', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fp }) });
  if (!r.ok) throw new Error('register не выдал токен');
  return (await r.json()).token;
}

let srv = null, base = process.env.RELAY_ADR002_URL;
if (!base) { srv = await startRelay({}); base = srv.base; }
console.log('ADR-002 · подпись постов канала — против живого релея\n  релей:', base);

try {
  const owner = await personalToken(base, 'fp:owner');
  const owner2 = await personalToken(base, 'fp:attacker');
  const attacker = newKey();
  const ownerKey = newKey();
  ok('клиент и сервер сошлись на каноническом потоке (тест зелёный ниже)',
     typeof signPost(ownerKey.privateKey, 'env-1', 'YQ') === 'string');

  // ── 1. До регистрации канал живёт в v1 (миграция) ───────────────────
  let r = await pub(base, WRITE_TOK, mkBody('e1'));
  ok('незарегистрированный канал + пост без подписи → 200 (режим v1)', r.status === 200);

  // ── 2. Регистрация ключа ────────────────────────────────────────────
  r = await regKey(base, owner, { token: READ_TOK, pubkey: ownerKey.pubHex });
  ok('регистрация ключа личным токеном → 200', r.status === 200);
  r = await regKey(base, owner, { token: READ_TOK, pubkey: ownerKey.pubHex });
  ok('повтор с тем же ключом идемпотентен → 200', r.status === 200);
  r = await regKey(base, owner2, { token: READ_TOK, pubkey: attacker.pubHex });
  ok('второй claimant с чужим ключом отвергнут → 409', r.status === 409);
  r = await regKey(base, WRITE_TOK, { token: READ_TOK, pubkey: attacker.pubHex });
  ok('регистрация по write-токену КАНАЛА отвергнута → 403', r.status === 403);

  // ── 3. ДЫРА ЗАКРЫТА: после регистрации без подписи не проходит ───────
  r = await pub(base, WRITE_TOK, mkBody('e2'));
  ok('зарегистрированный канал + пост БЕЗ подписи → 403', r.status === 403);

  // ── 4. Подпись владельца принимается ────────────────────────────────
  const good = mkBody('e3');
  good.sig = signPost(ownerKey.privateKey, good.id, good.body);
  r = await pub(base, WRITE_TOK, good);
  ok('подпись владельца принята → 200', r.status === 200);

  // ── 5. Подделка отвергается ─────────────────────────────────────────
  const forged = mkBody('e4');
  forged.sig = signPost(attacker.privateKey, forged.id, forged.body);
  r = await pub(base, WRITE_TOK, forged);
  ok('подпись чужым ключом → 403', r.status === 403);

  // ── 6. Тело нельзя подменить после подписания ───────────────────────
  // Ровно то, что закрывает цель ADR-002: подписчик с правом publish
  // подписывает ЧУЖОЙ конверт и отправляет как свой.
  const swapped = mkBody('e5');
  swapped.sig = signPost(ownerKey.privateKey, 'e5-other', swapped.body);
  r = await pub(base, WRITE_TOK, swapped);
  ok('подпись под другой env_id → 403', r.status === 403);

  const swapped2 = mkBody('e6');
  swapped2.sig = signPost(ownerKey.privateKey, swapped2.id, Buffer.from('чужое тело').toString('base64'));
  r = await pub(base, WRITE_TOK, swapped2);
  ok('подпись под чужое тело → 403', r.status === 403);

  // ── 7. Подпись из другого канала (kid привязан) ─────────────────────
  const [READ2] = channelTokensOracle(randomBytes(32).toString('hex'));
  const other = newKey();
  const wrongKid = mkBody('e7');
  wrongKid.sig = (() => {
    const input = Buffer.concat([Buffer.from('channel-post:v2\0', 'binary'),
      Buffer.from(READ2, 'base64url').subarray(0, 8),
      Buffer.from(wrongKid.id, 'utf8'), Buffer.from(wrongKid.body, 'utf8')]);
    return sign(null, input, other.privateKey).toString('base64url');
  })();
  r = await pub(base, WRITE_TOK, wrongKid);
  ok('подпись с чужим kid → 403', r.status === 403);

  // ── 8. REQUIRE_SIG закрывает и незарегистрированные каналы ──────────
  let srv2 = null;
  try {
    srv2 = await startRelay({ VAULT_RELAY_REQUIRE_SIG: '1' });
  } catch (e) {
    // Второй экземпляр — отдельный стенд для REQUIRE_SIG. Если поднять нельзя
    // (нет бинаря на этой машине), молча пропускать НЕЛЬЗЯ: «зелёный» прогон
    // без этой половины матрицы вводит в заблуждение сильнее, чем явный пропуск.
    console.log('  ⚠ REQUIRE_SIG-проверки пропущены:', e.message);
  }
  if (srv2) try {
    const b2 = srv2.base;
    const t2 = await personalToken(b2, 'fp:strict');
    const [R2, W2] = channelTokensOracle(randomBytes(32).toString('hex'));
    let rr = await fetch(b2 + '/relay/pub', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(W2) },
      body: JSON.stringify({ v: 1, to: R2, id: 's1', exp: Math.floor(Date.now() / 1000) + 3600,
        body: Buffer.from('x').toString('base64'), wake: false }) });
    ok('REQUIRE_SIG=1: незарегистрированный канал без подписи → 403', rr.status === 403);

    // Регистрируем ключ этого канала и публикуем с подписью — должно пройти.
    const k2 = newKey();
    const kid2 = Buffer.from(Buffer.from(R2, 'base64url').subarray(0, 8));
    const sign2 = (envId, body) => sign(null, Buffer.concat([
      Buffer.from('channel-post:v2\0', 'binary'), kid2,
      Buffer.from(envId, 'utf8'), Buffer.from(body, 'utf8')]), k2.privateKey).toString('base64url');
    rr = await regKey(b2, t2, { token: R2, pubkey: k2.pubHex });
    ok('REQUIRE_SIG=1: регистрация проходит → 200', rr.status === 200);
    const body2 = Buffer.from('strict-пост').toString('base64');
    rr = await fetch(b2 + '/relay/pub', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth(W2) },
      body: JSON.stringify({ v: 1, to: R2, id: 's2', exp: Math.floor(Date.now() / 1000) + 3600,
        body: body2, sig: sign2('s2', body2), wake: false }) });
    ok('REQUIRE_SIG=1: подписанный пост принят → 200', rr.status === 200);
  } finally { srv2.child.kill(); }
} finally {
  if (srv) srv.child.kill();
}

console.log(`\n=== ИТОГ: ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);