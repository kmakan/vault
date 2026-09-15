// E2E-смоук доставки каналов (t_09bf424a): ВЛАСНЫЕ функции клиента
// (channelTokens/send-путь из features/channels.js через smoke-обёртку)
// против ЖИВОГО relay-сервера. Криптография здесь непрозрачна (body —
// opaque), фокус — контракт транспорта: авторизация канала, fan-out,
// курсор since, изоляция каналов. Запуск:
//   cd relay-server && cargo build && ./target/debug/vault-relay &
//   RELAY_E2E_URL=http://127.0.0.1:PORT node scripts/channels-relay-e2e.mjs
// без RELAY_E2E_URL скрипт сам поднимает ./relay-server/target/debug/vault-relay
// на случайном порту (CI-режим) и убирает его в конце.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');

// ── реальный фича-модуль (те же channelTokens, что в приложении) ──
const MOCKS = '/tmp/channels-e2e-mocks';
mkdirSync(MOCKS, { recursive: true });
writeFileSync(path.join(MOCKS, 'api.js'), 'export const db = { kvGet: async () => null, kvSet: async () => {} }; export default { sendEmail: async () => ({ ok: true }) };');
writeFileSync(path.join(MOCKS, 'core.js'), 'export const invoke = async () => null;');
let src = readFileSync(ROOT + '/src/features/channels.js', 'utf8')
  .replace("from '@tauri-apps/api/core'", `from "${MOCKS}/core.js"`)
  .replace("from '../api.js'", `from "${MOCKS}/api.js"`);
writeFileSync(MOCKS + '/channels.js', src);
const { webcrypto } = await import('node:crypto');
if (!globalThis.crypto || !globalThis.crypto.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const chan = await import(MOCKS + '/channels.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok:', name); } else { fail++; console.log('FAIL:', name); } };

// ── сервер: внешний URL или автостарт ──
let srv = null, base = process.env.RELAY_E2E_URL;
if (!base) {
  const port = await new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { res(s.address().port); s.close(); }); });
  srv = spawn(path.join(ROOT, '..', 'relay-server', 'target', 'debug', 'vault-relay'), [], {
    env: { ...process.env, VAULT_RELAY_KEY: 'aa'.repeat(32), VAULT_RELAY_ADDR: `127.0.0.1:${port}`, VAULT_RELAY_ANON_PUB: '1', VAULT_RELAY_NTFY_URL: '' },
    stdio: 'ignore',
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
}
const up = await fetch(base + '/health').then(r => r.ok).catch(() => false);
if (!up) { console.error('relay не отвечает на', base); process.exit(1); }

try {
  // broadcast-ключи канала A и «чужого» канала B (32B hex, как channels.rs)
  const keyA = 'aa'.repeat(32), keyB = 'bb'.repeat(32);
  const tokA = await chan.channelTokens(keyA);
  const tokB = await chan.channelTokens(keyB);
  ok('токены A≠B', tokA.read !== tokB.read && tokA.write !== tokB.write);

  const pub = (body, auth) => fetch(base + '/relay/pub', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'VaultRelay ' + auth } : {}) },
    body: JSON.stringify({ v: 1, to: tokA.read, exp: Math.floor(Date.now() / 1000) + 3600, ...body }),
  });
  const poll = async (token) => {
    const r = await fetch(`${base}/relay/poll?wait=0`, { headers: { Authorization: 'VaultRelay ' + token } });
    return r.status === 204 ? [] : r.json();
  };

  // 1. анонимный pub в канал → 401 (write-токен канала обязателен всегда)
  ok('anon pub в канал → 401', (await pub({ id: 'x1', body: 'YQ' })).status === 401);
  // 2. write-токен чужого канала → 403
  ok('чужой write → 403', (await pub({ id: 'x2', body: 'YQ' }, tokB.write)).status === 403);
  // 3. пост + meta владельческим write → 200
  const post = JSON.parse(chan.buildPostPayload('chn_e2e', 'e2e post', []));
  const meta = JSON.parse(chan.buildMetaPayload({ id: 'chn_e2e', name: 'E2E', about: 'test', avatar: '', key_version: 1 }));
  ok('post pub → 200', (await pub({ id: post.id, body: Buffer.from(JSON.stringify(post)).toString('base64') }, tokA.write)).status === 200);
  ok('meta pub → 200', (await pub({ id: meta.id, body: Buffer.from(JSON.stringify(meta)).toString('base64') }, tokA.write)).status === 200);
  // 4. fan-out: два «подписчика» читают одну очередь
  const s1 = await poll(tokA.read), s2 = await poll(tokA.read);
  ok('fan-out: оба видят оба конверта', s1.length === 2 && s2.length === 2 &&
     [post.id, meta.id].every(id => s1.some(e => e.id === id) && s2.some(e => e.id === id)));
  // 5. since-курсор: только более новые
  const maxts = Math.max(...s1.map(e => e.ts));
  const r5 = await fetch(`${base}/relay/poll?wait=0&since=${maxts}`, { headers: { Authorization: 'VaultRelay ' + tokA.read } });
  ok('since=now → пусто', r5.status === 204 || (await r5.json()).length === 0);
  // 6. дедуп: второй pub того же id не удваивает очередь
  await pub({ id: post.id, body: Buffer.from('{}').toString('base64') }, tokA.write);
  ok('дедуп по env.id', (await poll(tokA.read)).length === 2);
  // 7. метрика канала выросла (3 успешных pub: post+meta+дедуп-повтор не в счётчик? — проверяем >=2)
  const m = await (await fetch(base + '/metrics')).text();
  const cp = Number((m.match(/^channel_pub (\d+)$/m) || [])[1] || 0);
  ok('channel_pub >= 2', cp >= 2);
  // 8. roundtrip payload-контракта: post содержит channel:1/chan/id
  ok('post payload wire-контракт', post.channel === 1 && post.chan === 'chn_e2e' && !!post.id && !!post.post);
} finally {
  if (srv) srv.kill('SIGTERM');
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL ${pass} passed`);
process.exit(fail ? 1 : 0);
