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
// identity-мок (accountNamespace — чистая функция namespace'а)
writeFileSync(path.join(MOCKS, 'identity.js'), `
export async function accountNamespace(email){ return 'ns:' + String(email || '').toLowerCase(); }
`);
// tauri core-мок (invoke)
// Мок invoke. channels_tokens — НЕ заглушка: считаем токены независимой
// реализацией на node:crypto. Это отдельный оракул — если клиентский Rust,
// этот мок и зафиксированные golden-векторы разойдутся, тест это увидит.
// Раньше JS счита HMAC сам, и «золотом» служили значения, вычисленные тем же
// кодом (то есть тест ничего не проверял).
writeFileSync(path.join(MOCKS, 'core.js'), `
import { createHmac } from 'node:crypto';
function channelTokensOracle(keyHex) {
  const key = Buffer.from(keyHex.trim(), 'hex');
  if (key.length !== 32) throw new Error('bad channel key');
  const rd = createHmac('sha256', key).update('vault-relay-channel-read').digest();
  const wr = createHmac('sha256', key).update('vault-relay-channel-write').digest();
  const kid = rd.subarray(0, 8);
  const pack = (scope, mac) => Buffer.concat([
    kid, Buffer.from([scope]),
    Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]), // sentinel expiry u32::MAX
    mac,
  ]).toString('base64url');
  return [pack(0x63, rd), pack(0x43, wr)]; // 'c' read, 'C' write
}
export const invoke = async (cmd, args) => {
  // Перехватчик сценария (ADR-005 W3 п.2): apiMock заморожен, а сценарии
  // UI-части грузят/создают/удаляют каналы — их ответы задаёт globalThis.
  const over = globalThis.__invokeOverride;
  if (over) {
    const r = await over(cmd, args);
    if (r !== undefined) return r;
  }
  if (cmd === 'channels_load') return [];
  if (cmd === 'channels_tokens') return channelTokensOracle(args.keyHex);
  throw new Error('unexpected invoke ' + cmd);
};
export { channelTokensOracle };
`);

// Подменяем спецификаторы через package.json imports нельзя (это не пакет),
// поэтому временный файл-обёртка: копируем модуль и правим импорты.
let src = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'features', 'channels.js'), 'utf8');
src = src.replace("from '@tauri-apps/api/core'", 'from "/tmp/channels-smoke-mocks/core.js"');
src = src.replace("from '../api.js'", 'from "/tmp/channels-smoke-mocks/api.js"');
src = src.replace("import('../api.js')", 'import("/tmp/channels-smoke-mocks/api.js")');
src = src.replace("import('../relay-client.js')", 'import("/tmp/channels-smoke-mocks/relay-client.js")');
src = src.replace("import('../crypto.js')", 'import("/tmp/channels-smoke-mocks/crypto.js")');
// ADR-005 W3 п.2: UI-оркестрация каналов переехала в фичу — она тянет
// владельцев (session-store/channels-store/mailbox-store) и примитивы
// (crypto/identity/message-format). Владельцы и message-format — НАСТОЯЩИЕ
// (мок-владелец проверял бы не тот объект); crypto и identity — моки.
const SRC = path.resolve(import.meta.dirname, '..', 'src');
src = src.replace("from '../crypto.js'", 'from "/tmp/channels-smoke-mocks/crypto.js"');
src = src.replace("from '../identity.js'", 'from "/tmp/channels-smoke-mocks/identity.js"');
src = src.replace("from '../message-format.js'", 'from "' + SRC + '/message-format.js"');
src = src.replace("from './session-store.js'", 'from "' + SRC + '/features/session-store.js"');
src = src.replace("from './channels-store.js'", 'from "' + SRC + '/features/channels-store.js"');
src = src.replace("from './mailbox-store.js'", 'from "' + SRC + '/features/mailbox-store.js"');
writeFileSync('/tmp/channels-smoke-feature.mjs', src);

const m = await import('/tmp/channels-smoke-feature.mjs');

// ADR-001 Этап 2: channelTokens уехал из фичи в примитив channels-tokens.js
// (транспорт не должен зависеть от features/*). Тест грузит примитив по его
// НОВОМУ месту — иначе он проверял бы копию фичи, где функции уже нет, и
// зелёный прогон означал бы «протестировали не то».
let tokSrc = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'channels-tokens.js'), 'utf8');
tokSrc = tokSrc.replace("from '@tauri-apps/api/core'", 'from "/tmp/channels-smoke-mocks/core.js"');
writeFileSync('/tmp/channels-smoke-tokens.mjs', tokSrc);
const tokens = await import('/tmp/channels-smoke-tokens.mjs');
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
const mkDeps = (owner) => {   // ADR-005 W2 (партия 13): контракт deps
  const c = { channels: [{ id: 'chn_1', is_owner: owner }], noteChannelPost: ctx.noteChannelPost, noteChannelHello: ctx.noteChannelHello };
  c.channelById = (id) => c.channels.find(x => x.id === id) || null; // без замыкания на внешний ctx
  return c;
};
ok('hello чужому каналу (не владелец) → null', m.ingestChannelEnvelope(mkDeps(false), ownHello, 'sub@x.y') === null);
ok('hello СВОЕМУ каналу → hello', m.ingestChannelEnvelope(mkDeps(true), ownHello, 'sub@x.y') === 'hello');
ok('не-канальный конверт → null', m.ingestChannelEnvelope(ctx, { vault: 1, text: 'hi' }, 'a@x.y') === null);
// Конверт с полем chan, но БЕЗ channel:1 — обычное сообщение, не канальное:
// гвард isChannelEnvelope обязан его отбросить. Без этой проверки гварда
// (мутация) такое письмо применилось бы как пост канала.
ok('конверт с chan, но без channel:1 → null (не канальный)',
  m.ingestChannelEnvelope(ctx, { vault: 1, chan: 'chn_1', post: { body: 'x' } }, 'a@x.y') === null);
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
const tk = await tokens.channelTokens(GOLD.key);
ok('channelTokens read == Rust golden', tk.read === GOLD.read);
ok('channelTokens write == Rust golden', tk.write === GOLD.write);
ok('channelTokens кэш идемпотентен', (await tokens.channelTokens(GOLD.key)) === tk);
let threw = false; try { await tokens.channelTokens('zz'); } catch { threw = true; }
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

// ── ADR-005 W3 п.2: UI-оркестрация каналов (было 13 методов в App.vue) ──
// Проверяем на НАСТОЯЩИХ владельцах (channels-store/mailbox-store/uiStore/
// chatStore) — мок-владелец проверял бы не тот объект.
{
  const { channelsStore } = await import(SRC + '/features/channels-store.js');
  const { mailboxState } = await import(SRC + '/features/mailbox-store.js');
  const { uiStore, chatStore, sessionStore } = await import(SRC + '/features/session-store.js');

  const chatStub = {
    state: { newMessage: '' },
    set(next) { this.state.messages = next; },
    setDraft(t) { this.state.newMessage = t == null ? '' : String(t); },
  };
  const calls = { saved: 0, reply: 0, mobile: 0, seq: 0, starred: null, closed: 0, clip: [], confirm: true, prompt: '', toasts: [], updates: [], errors: [] };
  uiStore.setShowToast((msg) => { calls.toasts.push(msg); });
  // Ловим console.error: гвард «плохая ссылка» отличается от «исключение
  // внутри try» именно ОШИБКОЙ В КОНСОЛИ (catch её глотает и показывает тот
  // же тост) — без этого два пути неразличимы.
  const realError = console.error;
  console.error = (...a) => { calls.errors.push(a.map(String).join(' ').slice(0, 120)); };
  const deps = {
    chat: chatStub,
    saveDraft: () => { calls.saved++; },
    cancelReply: () => { calls.reply++; },
    openMobileChat: () => { calls.mobile++; },
    setShowStarredOnly: (v) => { calls.starred = v; },
    bumpLoadSeq: () => { calls.seq++; },
    fingerprint: () => 'FP1',
    nextTick: async () => {},
    confirm: () => calls.confirm,
    prompt: () => calls.prompt,
    writeClipboard: (t) => { calls.clip.push(t); },
    closeChatMenu: () => { calls.closed++; },
  };
  const resetUi = () => {
    globalThis.__invokeOverride = null;
    channelsStore.reset();
    mailboxState.state.channels = [];
    sessionStore.setCurrentEmail('me@x.ru');
    uiStore.setFormField('newChannelName', '');
    uiStore.setFormField('newChannelAbout', '');
    uiStore.setFormField('joinChannelLink', '');
    uiStore.setModal('showCreateChannel', false);
    uiStore.setModal('showJoinChannel', false);
    uiStore.setModal('postingChannel', false);
    chatStore.setActiveChat(null);
    chatStore.setActiveChatType('chat');
    chatStore.setCurrentGroup(null);
    calls.saved = calls.reply = calls.mobile = calls.seq = calls.closed = 0;
    calls.starred = null; calls.clip = []; calls.confirm = true; calls.prompt = '';
    calls.toasts = []; calls.updates = []; calls.errors = [];
    chatStub.state.newMessage = '';
    chatStub.state.messages = [];
  };

  // 1. channelById — поиск по списку владельца
  resetUi();
  mailboxState.state.channels = [{ id: 'chn_1', name: 'C1' }];
  ok('channelById: находит по id', m.channelById('chn_1') && m.channelById('chn_1').name === 'C1');
  ok('channelById: неизвестный → null', m.channelById('chn_x') === null);

  // 2. noteChannelPost: дедуп по id, сортировка по ts, счётчик, запись в kv
  resetUi();
  mailboxState.state.channels = [{ id: 'chn_1', name: 'C1' }];
  m.noteChannelPost('chn_1', 100, { id: 'p2', post: { body: 'B2' } }, 'peer@x.ru');
  m.noteChannelPost('chn_1', 50, { id: 'p1', post: { body: 'B1' } }, 'peer@x.ru');
  m.noteChannelPost('chn_1', 150, { id: 'p2', post: { body: 'B2' } }, 'peer@x.ru'); // дубль
  const posts = channelsStore.state.channelPosts.chn_1 || [];
  ok('noteChannelPost: дедуп по post.id', posts.length === 2, posts);
  ok('noteChannelPost: сортировка по ts', posts[0].ts === 50 && posts[1].ts === 100);
  ok('noteChannelPost: счётчик непрочитанных', channelsStore.state.channelUnread.chn_1 === 2, channelsStore.state.channelUnread);
  await new Promise((r) => setTimeout(r, 50)); // запись в kv — асинхронная (then)
  ok('noteChannelPost: пост сохранён в kv (с namespace аккаунта)',
    avatarKv.some(([a, k]) => k === 'channel-posts:chn_1' && a === 'ns:me@x.ru'), avatarKv);

  // 3. channelPostsToMessages: формат и «свой пост»
  resetUi();
  mailboxState.state.channels = [{ id: 'chn_1', name: 'C1', owner: 'own@x.ru', is_owner: true }];
  m.noteChannelPost('chn_1', 100, { id: 'p1', post: { body: 'B1' } }, 'own@x.ru');
  m.noteChannelPost('chn_1', 200, { id: 'p2', post: { body: 'B2' } }, 'peer@x.ru');
  const msgs = m.channelPostsToMessages(mailboxState.state.channels[0]);
  ok('channelPostsToMessages: свой пост → from=me', msgs[0].from === 'me', msgs);
  ok('channelPostsToMessages: чужой пост → отправитель', msgs[1].from === 'peer@x.ru');
  ok('channelPostsToMessages: тело/время/метки', msgs[0].content === 'B1' && msgs[0].encrypted === true && msgs[0].vault === true && !!msgs[0].time);

  // 4. syncChannels: список + посты + счётчики + аватары
  resetUi();
  apiMock.db.kvGet = async (acc, k) => {
    if (k === 'channel-posts:chn_1') return JSON.stringify([{ id: 'p1', ts: 5, body: 'B' }]);
    if (String(k).startsWith('channel-avatar:')) return 'AV';
    return null;
  };
  const chList = [{ id: 'chn_1', name: 'C1', last_ts: 0 }];
  globalThis.__invokeOverride = async (cmd) => (cmd === 'channels_load' ? chList : undefined);
  await m.syncChannels(deps);
  ok('syncChannels: список в owner', mailboxState.state.channels.length === 1);
  ok('syncChannels: посты загружены', (channelsStore.state.channelPosts.chn_1 || []).length === 1);
  ok('syncChannels: счётчик непрочитанных посчитан', channelsStore.state.channelUnread.chn_1 === 1, channelsStore.state.channelUnread);
  ok('syncChannels: аватар загружен', channelsStore.state.channelAvatars.chn_1 === 'AV');

  // 5. selectChannel: переключение чата, сброс счётчика, сообщения
  resetUi();
  mailboxState.state.channels = [{ id: 'chn_1', name: 'C1', is_owner: true }];
  channelsStore.setChannelPosts('chn_1', [{ id: 'p1', ts: 5, body: 'B', sender: 'peer@x.ru' }]);
  channelsStore.setUnread('chn_1', 7);
  globalThis.__invokeOverride = async (cmd, args) => {
    if (cmd === 'channels_update') { calls.updates.push(args); return true; }
    return undefined;
  };
  await m.selectChannel(mailboxState.state.channels[0], deps);
  ok('selectChannel: last_ts записан (монотонность непрочитанных)',
    calls.updates.some((a) => a.patch && a.patch.last_ts === 5), calls.updates);
  ok('selectChannel: активный чат = channel:chn_1', chatStore.state.activeChat === 'channel:chn_1', chatStore.state);
  ok('selectChannel: тип чата = channel', chatStore.state.activeChatType === 'channel');
  ok('selectChannel: активный канал в owner', channelsStore.state.currentChannel && channelsStore.state.currentChannel.id === 'chn_1');
  ok('selectChannel: счётчик сброшен', channelsStore.state.channelUnread.chn_1 === 0);
  ok('selectChannel: сообщения показаны', Array.isArray(chatStub.state.messages) && chatStub.state.messages.length === 1);
  ok('selectChannel: черновик сохранён и очищен', calls.saved === 1 && chatStub.state.newMessage === '');
  ok('selectChannel: мобильный чат открыт, звёзды сняты', calls.mobile === 1 && calls.starred === false);

  // 6. publishChannelPost: пост уходит, эхо локально, черновик очищен
  resetUi();
  const ownerCh = { id: 'chn_1', key: 'k'.repeat(64), is_owner: true, name: 'C1', known_subscribers: [] };
  mailboxState.state.channels = [ownerCh];
  channelsStore.setCurrentChannel(ownerCh);
  chatStub.state.newMessage = '  привет  ';
  rcMock.pubs.length = 0;
  await m.publishChannelPost(deps);
  ok('publishChannelPost: пост ушёл в транспорт', rcMock.pubs.length === 1, rcMock.pubs);
  ok('publishChannelPost: локальное эхо появилось', (channelsStore.state.channelPosts.chn_1 || []).length === 1);
  ok('publishChannelPost: черновик очищен', chatStub.state.newMessage === '');
  ok('publishChannelPost: флаг posting снят', uiStore.getModal('postingChannel') === false);

  // 6b. Пустой текст — пост не отправляется
  resetUi();
  const emptyCh = { id: 'chn_3', key: 'k'.repeat(64), is_owner: true, name: 'C3', known_subscribers: [] };
  mailboxState.state.channels = [emptyCh];
  channelsStore.setCurrentChannel(emptyCh);
  chatStub.state.newMessage = '   ';
  rcMock.pubs.length = 0;
  await m.publishChannelPost(deps);
  ok('publishChannelPost: пустой текст → не отправляется', rcMock.pubs.length === 0);

  // 6c. Не владелец — пост не отправляется
  resetUi();
  const subCh = { id: 'chn_2', key: 'k'.repeat(64), is_owner: false, name: 'C2', known_subscribers: [] };
  mailboxState.state.channels = [subCh];
  channelsStore.setCurrentChannel(subCh);
  chatStub.state.newMessage = 'нельзя';
  rcMock.pubs.length = 0;
  await m.publishChannelPost(deps);
  ok('publishChannelPost: не владелец → не отправляется', rcMock.pubs.length === 0);

  // 7. createChannelAndClose: канал создан, форма очищена, канал открыт
  resetUi();
  globalThis.__invokeOverride = async (cmd, args) => {
    if (cmd === 'channels_create') return { id: 'chn_new', name: args.name, key: 'k'.repeat(64), is_owner: true, owner_fpr: 'FP1' };
    if (cmd === 'channels_load') return [{ id: 'chn_new', name: 'Мой канал', key: 'k'.repeat(64), is_owner: true }];
    return undefined;
  };
  uiStore.setFormField('newChannelName', '  Мой канал  ');
  uiStore.setFormField('newChannelAbout', ' про канал ');
  uiStore.setModal('showCreateChannel', true);
  await m.createChannelAndClose(deps);
  ok('createChannelAndClose: канал создан и выбран', chatStore.state.activeChat === 'channel:chn_new', chatStore.state);
  ok('createChannelAndClose: модалка закрыта', uiStore.getModal('showCreateChannel') === false);
  ok('createChannelAndClose: форма очищена', uiStore.getFormField('newChannelName') === '' && uiStore.getFormField('newChannelAbout') === '');
  ok('createChannelAndClose: флаг posting снят', uiStore.getModal('postingChannel') === false);

  // 8. joinChannelAndClose: плохая ссылка — тост, ничего не импортируем
  resetUi();
  uiStore.setFormField('joinChannelLink', 'не-ссылка');
  let threw = null;
  let importCalled = false;
  globalThis.__invokeOverride = async (cmd) => { if (cmd === 'channels_import') { importCalled = true; return true; } return undefined; };
  try { await m.joinChannelAndClose(deps); } catch (e) { threw = e; }
  ok('joinChannelAndClose: плохая ссылка → без исключения', threw === null, threw && String(threw));
  ok('joinChannelAndClose: плохая ссылка → модалка не закрыта', uiStore.getModal('showJoinChannel') === false);
  ok('joinChannelAndClose: плохая ссылка → тост и НЕ импорт',
    calls.toasts.length === 1 && importCalled === false, { toasts: calls.toasts, importCalled });
  ok('joinChannelAndClose: плохая ссылка → БЕЗ ошибки в консоли (гвард, а не исключение)',
    calls.errors.length === 0, calls.errors);

  // 8b. Валидная ссылка → импорт выполнен, модалка закрыта
  resetUi();
  uiStore.setFormField('joinChannelLink', 'vault://join-channel?c=chn_j&k=' + 'a'.repeat(64) + '&n=J&o=FP');
  uiStore.setModal('showJoinChannel', true);
  let imported = null;
  globalThis.__invokeOverride = async (cmd, args) => {
    if (cmd === 'channels_import') { imported = args; return true; }
    if (cmd === 'channels_load') return [];
    return undefined;
  };
  await m.joinChannelAndClose(deps);
  ok('joinChannelAndClose: канал импортирован по ссылке', !!imported && imported.channelId === 'chn_j', imported);
  ok('joinChannelAndClose: модалка закрыта, поле очищено',
    uiStore.getModal('showJoinChannel') === false && uiStore.getFormField('joinChannelLink') === '');

  // 9. copyChannelLink / copyChannelLinkById: ссылка в буфер
  resetUi();
  const linkCh = { id: 'chn_1', key: 'k'.repeat(64), name: 'C1', owner_fpr: 'FP1' };
  mailboxState.state.channels = [linkCh];
  channelsStore.setCurrentChannel(linkCh);
  m.copyChannelLink(deps);
  ok('copyChannelLink: ссылка скопирована', calls.clip.length === 1 && calls.clip[0].startsWith('vault://join-channel?c=chn_1'), calls.clip);
  m.copyChannelLinkById(deps, 'chn_1');
  ok('copyChannelLinkById: ссылка скопирована, меню закрыто', calls.clip.length === 2 && calls.closed === 1);

  // 10. deleteChannelConfirmed: подтверждение → удаление
  resetUi();
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'channel', id: 'chn_1' } });
  globalThis.__invokeOverride = async (cmd) => { if (cmd === 'channels_delete') return true; if (cmd === 'channels_load') return []; return undefined; };
  await m.deleteChannelConfirmed(deps);
  ok('deleteChannelConfirmed: канал удалён, меню закрыто', calls.closed === 1);

  // 10b. Без подтверждения — НЕ удаляем
  resetUi();
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'channel', id: 'chn_1' } });
  calls.confirm = false;
  let deleted = false;
  globalThis.__invokeOverride = async (cmd) => { if (cmd === 'channels_delete') { deleted = true; return true; } return undefined; };
  await m.deleteChannelConfirmed(deps);
  ok('deleteChannelConfirmed: без подтверждения → не удаляется', deleted === false);

  // 10c. Удаление ОТКРЫТОГО канала — активный чат сбрасывается
  resetUi();
  chatStore.setActiveChat('channel:chn_1');
  chatStore.setActiveChatType('channel');
  channelsStore.setCurrentChannel({ id: 'chn_1' });
  uiStore.setFormField('chatMenu', { show: true, target: { type: 'channel', id: 'chn_1' } });
  globalThis.__invokeOverride = async (cmd) => { if (cmd === 'channels_delete') return true; if (cmd === 'channels_load') return []; return undefined; };
  await m.deleteChannelConfirmed(deps);
  ok('deleteChannelConfirmed: открытый канал закрыт (активный чат сброшен)',
    chatStore.state.activeChat === '' && chatStore.state.activeChatType === 'chat' && channelsStore.state.currentChannel === null,
    { activeChat: chatStore.state.activeChat, type: chatStore.state.activeChatType, current: channelsStore.state.currentChannel });

  // 11. renameChannel: новое имя → обновление
  resetUi();
  const renCh = { id: 'chn_1', key: 'k'.repeat(64), name: 'Старое', is_owner: true, known_subscribers: [] };
  mailboxState.state.channels = [renCh];
  calls.prompt = '  Новое  ';
  globalThis.__invokeOverride = async (cmd) => { if (cmd === 'channels_update') return true; return undefined; };
  await m.renameChannel(deps, 'chn_1');
  ok('renameChannel: имя обрезано и применено', renCh.name === 'Новое', renCh.name);

  // 11b. Переименование не владельцем — запрещено
  resetUi();
  const notOwner = { id: 'chn_1', key: 'k'.repeat(64), name: 'Чужой', is_owner: false, known_subscribers: [] };
  mailboxState.state.channels = [notOwner];
  calls.prompt = 'Взлом';
  globalThis.__invokeOverride = async (cmd) => { if (cmd === 'channels_update') return true; return undefined; };
  await m.renameChannel(deps, 'chn_1');
  ok('renameChannel: не владелец → имя не меняется', notOwner.name === 'Чужой', notOwner.name);

  console.error = realError;
}

console.log(fail ? `\n${fail} FAILED, ${pass} passed` : `\nALL ${pass} passed`);
process.exit(fail ? 1 : 0);
