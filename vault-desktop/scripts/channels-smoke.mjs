// Node-смоук features/channels.js — чистая логика без Vue/Tauri.
// Мокаем invoke/api через подмену импортов (заглушки в tmp-модулях).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MOCKS = '/tmp/channels-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// api-мок (api.js экспортирует default api + db)
writeFileSync(path.join(MOCKS, 'api.js'), `
export const db = { kvGet: async () => null, kvSet: async () => {} };
export const sent = [];
export default { sendEmail: async (mode, msg) => { sent.push(msg); return { ok: true }; } };
`);
// relay-client-мок (динамический импорт в sendChannelPost)
writeFileSync(path.join(MOCKS, 'relay-client.js'), `
export const pubs = [];
export const relayChannelPublish = async (ch, env, body) => { pubs.push({ ch: ch.id, env, body }); return { ok: true }; };
`);
// crypto-мок (динамический импорт в sendChannelMeta)
writeFileSync(path.join(MOCKS, 'crypto.js'), `
export default { encryptWithGroupKey: async (plain, key) => 'ENC(' + key.slice(0, 4) + ')' + plain };
`);
// tauri core-мок (invoke)
writeFileSync(path.join(MOCKS, 'core.js'), `
export const invoke = async (cmd, args) => {
  if (cmd === 'channels_load') return [];
  throw new Error('unexpected invoke ' + cmd);
};
`);

// Подменяем спецификаторы через package.json imports нельзя (это не пакет),
// поэтому временный файл-обёртка: копируем модуль и правим импорты.
let src = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'features', 'channels.js'), 'utf8');
src = src.replace("from '@tauri-apps/api/core'", 'from "/tmp/channels-smoke-mocks/core.js"');
src = src.replace("from '../api.js'", 'from "/tmp/channels-smoke-mocks/api.js"');
src = src.replace("import('../api.js')", 'import("/tmp/channels-smoke-mocks/api.js")');
src = src.replace("import('../relay-client.js')", 'import("/tmp/channels-smoke-mocks/relay-client.js")');
src = src.replace("import('../crypto.js')", 'import("/tmp/channels-smoke-mocks/crypto.js")');
writeFileSync('/tmp/channels-smoke-feature.mjs', src);

const m = await import('/tmp/channels-smoke-feature.mjs');
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ok:', name); } else { fail++; console.log('FAIL:', name); } };

// ── link roundtrip ──
const fake = { id: 'chn_deadbeefcafe', key: 'a'.repeat(64), name: 'Тест канал', owner_fpr: 'f'.repeat(128) };
const link = m.buildJoinLink(fake);
ok('link строится', link.startsWith('vault://join-channel?c=chn_'));
const p = m.parseJoinLink(link);
ok('link парсится: id+key+name+fpr', p && p.id === fake.id && p.key === fake.key && p.name === fake.name && p.ownerFpr === fake.owner_fpr);
ok('мусор → null', m.parseJoinLink('hello') === null);
ok('плохой ключ → null', m.parseJoinLink('vault://join-channel?c=chn_x&k=zz&n=&o=') === null);
ok('не-chn id → null', m.parseJoinLink('vault://join-channel?c=grp_x&k=' + 'a'.repeat(64)) === null);
ok('пустой ввод → null', m.parseJoinLink('') === null && m.parseJoinLink(null) === null);

// ── payloads ──
const post = JSON.parse(m.buildPostPayload('chn_1', 'hello world', ['data:img1']));
ok('post: маркер channel:1', post.channel === 1);
ok('post: body+images', post.post.body === 'hello world' && post.post.images.length === 1);
ok('post: id post_*, ts now', post.id.startsWith('post_') && Math.abs(post.ts - Date.now()) < 5000);
ok('post: meta false', post.meta === false);
const meta = JSON.parse(m.buildMetaPayload({ id: 'chn_1', name: 'N', about: 'A', avatar: '', key_version: 1 }));
ok('meta: meta:1 + поля', meta.meta === 1 && meta.name === 'N' && meta.about === 'A' && meta.key_version === 1);
const hello = JSON.parse(m.buildHelloPayload('chn_1'));
ok('hello: hello:1', hello.hello === 1 && hello.id.startsWith('hello_'));
ok('isChannelEnvelope', m.isChannelEnvelope(hello) && m.isChannelEnvelope(post) && !m.isChannelEnvelope({ vault: 1 }) && !m.isChannelEnvelope(null));

// ── ingest ──
const calls = { posts: [], metas: 0, hellos: [] };
const ctx = {
  channels: [{ id: 'chn_1', key: 'k'.repeat(64), is_owner: false, name: 'C1' }],
  channelById: (id) => ctx.channels.find(c => c.id === id) || null,
  noteChannelPost: (id, ts, payload, sender) => calls.posts.push({ id, ts, payload, sender }),
  noteChannelHello: (id, sender) => calls.hellos.push({ id, sender }),
};
// подменяем invoke для update/addKnown
const core = await import('/tmp/channels-smoke-mocks/core.js');

ok('ingest post → kind post', m.ingestChannelEnvelope(ctx, post, 'owner@x.y') === 'post');
ok('ingest вызвал noteChannelPost', calls.posts.length === 1 && calls.posts[0].sender === 'owner@x.y');
ok('ingest meta → kind meta', m.ingestChannelEnvelope(ctx, meta, 'owner@x.y') === 'meta');
const ownHello = JSON.parse(m.buildHelloPayload('chn_1'));
const mkCtx = (owner) => {
  const c = { channels: [{ id: 'chn_1', is_owner: owner }], noteChannelPost: ctx.noteChannelPost, noteChannelHello: ctx.noteChannelHello };
  c.channelById = (id) => c.channels.find(x => x.id === id) || null; // без замыкания на внешний ctx
  return c;
};
ok('hello чужому каналу (не владелец) → null', m.ingestChannelEnvelope(mkCtx(false), ownHello, 'sub@x.y') === null);
ok('hello СВОЕМУ каналу → hello', m.ingestChannelEnvelope(mkCtx(true), ownHello, 'sub@x.y') === 'hello');
ok('не-канальный конверт → null', m.ingestChannelEnvelope(ctx, { vault: 1, text: 'hi' }, 'a@x.y') === null);
ok('канал не подписан → null', m.ingestChannelEnvelope(ctx, { ...post, chan: 'chn_unknown' }, 'a@x.y') === null);

// ── relay channel tokens: parity с Rust (golden vectors из tokens.rs) ──
// Node 24: globalThis.crypto — getter-only, определяем поверх (WebCrypto для channelTokens).
const { webcrypto } = await import('node:crypto');
Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
const GOLD = {
  key: Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(''),
  read: 'SV_HjXPp5iRj_____0lfx41z6eYkxBwsz_yjudMQsR5y1y_gjWtvThUEHsVi',
  write: 'SV_HjXPp5iRD_____wggA7nRt299pz5hlBU0WewQCsWWD7JgIIcmkz8csufh',
};
const tk = await m.channelTokens(GOLD.key);
ok('channelTokens read == Rust golden', tk.read === GOLD.read);
ok('channelTokens write == Rust golden', tk.write === GOLD.write);
ok('channelTokens кэш идемпотентен', (await m.channelTokens(GOLD.key)) === tk);
let threw = false; try { await m.channelTokens('zz'); } catch { threw = true; }
ok('bad key → throw', threw);

// ── sendChannelPost: relay-паб + email-дубли cap 50 ──
const apiMock = await import('/tmp/channels-smoke-mocks/api.js');
const rcMock = await import('/tmp/channels-smoke-mocks/relay-client.js');
const ch50 = { id: 'chn_1', key: GOLD.key, is_owner: true,
  known_subscribers: Array.from({ length: 60 }, (_, i) => `s${i}@x.y`) };
const res = await m.sendChannelPost(ch50, 'CIPHERTEXT', { id: 'post_x' });
ok('post: relay pub один', rcMock.pubs.length === 1 && rcMock.pubs[0].ch === 'chn_1' && rcMock.pubs[0].body === 'CIPHERTEXT');
ok('post: email cap 50', res.mailSent === 50 && apiMock.sent.length === 50);
ok('post: stealth-тема пуста', apiMock.sent.every(s => s.subject === '' && s.body === 'CIPHERTEXT'));

// ── sendChannelMeta: meta-конверт через тот же транспорт (t_09bf424a) ──
rcMock.pubs.length = 0; apiMock.sent.length = 0;
const chMeta = { id: 'chn_m', key: GOLD.key, is_owner: true, name: 'M', about: 'A', avatar: '', key_version: 1, known_subscribers: [] };
const mres = await m.sendChannelMeta(chMeta, 'me@x.y');
ok('meta: pub c meta:1 в payload', rcMock.pubs.length === 1 && rcMock.pubs[0].env.meta === 1 && rcMock.pubs[0].env.name === 'M');
ok('meta: тело зашифровано (мок ENC)', mres.relayOk && String(rcMock.pubs[0].body).startsWith('ENC('));
// ingest: meta обновляет name/about мгновенно + avatar в kv
const avatarKv = [];
apiMock.db.kvSet = async (acc, k, v) => { avatarKv.push([acc, k, v]); };
const chSub = { id: 'chn_1', key: 'k'.repeat(64), is_owner: false, name: 'C1', about: '' };
const ctxMeta = { channels: [chSub], channelById: (id) => chSub.id === id ? chSub : null };
const metaPayload = JSON.parse(m.buildMetaPayload({ id: 'chn_1', name: 'New', about: 'Desc', avatar: 'data:img', key_version: 1 }));
ok('ingest meta: kind + мгновенный мутейт', m.ingestChannelEnvelope(ctxMeta, metaPayload, 'o@x.y') === 'meta' && chSub.name === 'New' && chSub.about === 'Desc');
ok('ingest meta: avatar → kv channel-avatar:', avatarKv.some(([a, k, v]) => a === 'anon' && k === 'channel-avatar:chn_1' && v === 'data:img'));

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL ${pass} passed`);
process.exit(fail ? 1 : 0);
