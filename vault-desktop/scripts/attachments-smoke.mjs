// Node-смоук features/attachments.js — домен «вложения» (ADR-001 пилот).
// Мокаем api/crypto/chatExport/mailProviders/@tauri-apps через подмену
// импортов (заглушки в tmp-модулях), без Vue/Tauri. Цель: застраховать
// ВЫНЕСЕННУЮ из App.vue логику от регрессий (кэш DoD, play/stop голосовых,
// лимиты провайдера, заметки) после декомпозиции.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
import { createChatStore } from '../src/chat-store.js';
import { createNotesStore } from '../src/features/notes-store.js';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/attachments-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Моки зависимостей attachments.js ───────────────────────────
// invoke (@tauri-apps/api/core): voicenote_* + email_fetch_body
const tauri = {
  calls: [],
  body: '',
  voicenoteResult: null, // null = успех, иначе throw
  invoke: async (cmd, args) => {
    tauri.calls.push([cmd, args]);
    if (cmd === 'voicenote_play' && tauri.voicenoteResult === 'throw') throw new Error('no media session');
    if (cmd === 'email_fetch_body') return tauri.body;
    return null;
  },
};
const cryptoMock = {
  decryptWithGroupKey: null,
  decryptVault: null,
  setPeerPublicKey: () => {},
};
const dl = { hits: [] };
const providers = { limitMb: 25 };

writeFileSync(MOCKS + '/core.js', 'export const invoke = (...a) => globalThis.__tauri.invoke(...a);');
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;');
writeFileSync(MOCKS + '/crypto.js', 'const crypto = globalThis.__cryptoMock; export default crypto;');
writeFileSync(MOCKS + '/chatExport.js', 'export const downloadBase64 = (...a) => globalThis.__dl.hits.push(a);');
writeFileSync(MOCKS + '/mailProviders.js', 'export const getAttachmentLimitMb = () => globalThis.__providers.limitMb;');

globalThis.__tauri = tauri;
globalThis.__cryptoMock = cryptoMock;
globalThis.__dl = dl;
globalThis.__providers = providers;

const apiMock = {
  sendCalls: [],
  sendMessage: async (...a) => { apiMock.sendCalls.push(['msg', ...a]); },
  sendGroupMessage: async (...a) => { apiMock.sendCalls.push(['grp', ...a]); },
  sendDodEmail: async (...a) => { apiMock.sendCalls.push(['dod', ...a]); },
  getGroupMembers: async () => ([{ email: 'peer@x.ru' }, { email: 'me@x.ru' }]),
};
globalThis.__apiMock = apiMock;

// ADR-004 A15: notes-store.js работает с глобальным localStorage.
// В Node его может не быть — подменяем in-memory хранилищем.
const _ls = {};
globalThis.localStorage ||= {
  getItem: (k) => (_ls[k] !== undefined ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
  clear: () => { for (const k in _ls) delete _ls[k]; },
  key: (i) => Object.keys(_ls)[i] || null,
  get length() { return Object.keys(_ls).length; },
};

prepareModuleCopy(
  ROOT + '/src/features/attachments.js',
  MOCKS + '/attachments.mjs',
  {
    '@tauri-apps/api/core': 'core.js',
    '../api.js': 'api.js',
    '../crypto.js': 'crypto.js',
    '../chatExport.js': 'chatExport.js',
    '../mailProviders.js': 'mailProviders.js',
  },
  MOCKS,
);
const A = await import(MOCKS + '/attachments.mjs');

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function makeCtx(over = {}) {
  return Object.assign({
    isAndroidClient: true,
    activeChat: 'peer@x.ru',
    activeChatType: 'peer',
    currentGroup: null,
    email: 'me@x.ru',
    cryptoReady: true,
    peerKeys: { 'peer@x.ru': 'PUB' },
    peerPqKeys: {},
    groupKeys: {},
    emails: [],
    dodCache: {},
    voicePlayingId: '',
    viewingImage: null,
    showAudioRecorder: true,
    showToast: () => {},
    $forceUpdate: () => {},
    t: (k) => k,
    parseEnvelope: (txt) => { try { return JSON.parse(txt); } catch (e) { return null; } },
    buildEnvelope: async (payload) => JSON.stringify({ id: 'env1', text: payload }),
    saveCurrentHistory: () => {},
    // ADR-004 A15: notes-store — mock localStorage для чтения/записи заметок.
    notes: createNotesStore(),
    markPending: () => {},
    scrollToBottom: () => {},
    // Модуль-владелец переписки (ADR-004, Этап A1). attachments.js пишет через
    // ctx.chat.set/append, а не напрямую в ctx.messages.
    chat: createChatStore(),
    mediaQuality: async () => 'original',
    compressImage: async () => '',
    isTextMime: () => false,
  }, over);
}
const att0 = () => ({ name: 'a.png', type: 'image/png', data: 'DATA', isImage: true });
// Реальный контракт fetchDodAttachment: crypto.decryptVault/WithGroupKey
// возвращают envelope-строку {vault:1, id, text:<JSON вложения>}; parseEnvelope
// вытаскивает .text, затем JSON.parse(inner) даёт {vault_dod_data:1, ref, data}.
const dodEnvelope = (ref, data) => JSON.stringify({ vault: 1, id: 'e1', text: JSON.stringify({ vault_dod_data: 1, ref, data }) });

// ── 1. downloadAttachment ────────────────────
console.log('1. downloadAttachment');
{
  dl.hits.length = 0;
  A.downloadAttachment(att0());
  check('скачивание через downloadBase64 с data/name/type',
    dl.hits.length === 1 && dl.hits[0][0] === 'DATA' && dl.hits[0][1] === 'a.png');
  A.downloadAttachment(null);
  A.downloadAttachment({ name: 'x' });
  check('нет data / нет attachment — тихий no-op', dl.hits.length === 1);
  // openImageViewer удалён (ADR-001): обёртка без логики, App.vue
  // присваивает viewingImage сам. Проверяем, что и правда удалён —
  // иначе кто-то добавит к нему ctx молча.
  check('openImageViewer больше не экспортируется (нет обёртки без логики)',
    typeof A.openImageViewer !== 'function');
}

// ── 2. toggleVoiceNote: play → stop ────────────────────────────
console.log('2. toggleVoiceNote (фон. плеер, Android)');
{
  tauri.calls.length = 0;
  const ctx = makeCtx();
  const deps = () => ({
    isAndroidClient: ctx.isAndroidClient, voicePlayingId: ctx.voicePlayingId,
    showToast: (m, ms) => ctx.showToast(m, ms), t: ctx.t,
  });
  ctx.voicePlayingId = await A.toggleVoiceNote(deps(), { id: 'm1' }, att0());
  check('play: voicenote_play вызван, voicePlayingId = m1',
    tauri.calls.some(c => c[0] === 'voicenote_play') && ctx.voicePlayingId === 'm1');
  ctx.voicePlayingId = await A.toggleVoiceNote(deps(), { id: 'm1' }, att0());
  check('повторный клик по активному треку → voicenote_stop, сброс id',
    tauri.calls.some(c => c[0] === 'voicenote_stop') && ctx.voicePlayingId === '');
  const desk = makeCtx({ isAndroidClient: false });
  tauri.calls.length = 0;
  const deskDeps = { isAndroidClient: false, voicePlayingId: '', showToast: () => {}, t: desk.t };
  await A.toggleVoiceNote(deskDeps, { id: 'm2' }, att0());
  check('не-Android — no-op (play не вызван)', !tauri.calls.some(c => c[0] === 'voicenote_play'));
  check('не-Android — значение voicePlayingId не меняется',
    deskDeps.voicePlayingId === '', deskDeps.voicePlayingId);
}

// ── 3. fetchDodAttachment: кэш / успех / ref-mismatch / not-dod ─
console.log('3. fetchDodAttachment (DoD-докачка)');
{
  const ctx = makeCtx({ dodCache: { '<dod@x>': 'CACHED' } });
  const a = { name: 'f.bin', type: 'application/octet-stream', isDod: true, dod: '<dod@x>' };
  await A.fetchDodAttachment(ctx, {}, a);
  check('dodCache попадание → data=кэш, dodStatus=ready', a.data === 'CACHED' && a.dodStatus === 'ready');

  tauri.calls.length = 0; tauri.body = 'ENCBODY';
  cryptoMock.decryptVault = async () => dodEnvelope('<d2@x>', 'REAL');
  cryptoMock.decryptWithGroupKey = null;
  const ctx2 = makeCtx({ emails: [{ message_id: '<d2@x>', uid: 7, folder: 'INBOX' }] });
  const a2 = { name: 'big.bin', type: 'application/octet-stream', isDod: true, dod: '<d2@x>' };
  await A.fetchDodAttachment(ctx2, {}, a2);
  check('успех: email_fetch_body + data=REAL + закэшировано',
    tauri.calls.some(c => c[0] === 'email_fetch_body') && a2.data === 'REAL' && a2.dodStatus === 'ready' && ctx2.dodCache['<d2@x>'] === 'REAL');

  cryptoMock.decryptVault = async () => dodEnvelope('<other@x>', 'X');
  const ctx3 = makeCtx({ emails: [{ message_id: '<d3@x>', uid: 8, folder: 'INBOX' }] });
  const a3 = { name: 'b.bin', type: 'x', isDod: true, dod: '<d3@x>' };
  await A.fetchDodAttachment(ctx3, {}, a3);
  check('ref-mismatch → dodStatus=error, data не подставлен', a3.dodStatus === 'error' && a3.data === undefined);

  cryptoMock.decryptVault = async () => dodEnvelope('<d4@x>', 'Y');
  const ctx4 = makeCtx({ emails: [] });
  const a4 = { name: 'c.bin', type: 'x', isDod: true, dod: '<d4@x>' };
  await A.fetchDodAttachment(ctx4, {}, a4);
  check('нет data-письма по Message-ID → dodStatus=error', a4.dodStatus === 'error');
}

// ── 4. downloadDodAttachment: fetch→download ───────────────────
console.log('4. downloadDodAttachment');
{
  dl.hits.length = 0;
  tauri.body = 'ENC'; cryptoMock.decryptVault = async () => dodEnvelope('<d5@x>', 'DL');
  const ctx = makeCtx({ emails: [{ message_id: '<d5@x>', uid: 9, folder: 'INBOX' }] });
  const a = { name: 'f.bin', type: 'x', isDod: true, dod: '<d5@x>' };
  await A.downloadDodAttachment(ctx, {}, a);
  check('сначала докачивает, затем downloadBase64(data=DL)',
    a.dodStatus === 'ready' && dl.hits.length === 1 && dl.hits[0][0] === 'DL');
}

// ── 5. sendAudioMessage: заметки (локально, без почты) ─────────
console.log('5. sendAudioMessage — «Заметки для себя»');
{
  const ctx = makeCtx({ activeChat: '__notes__' });
  // notes-store использует localStorage (мок globalThis.localStorage).
  // Чистим перед тестом: состояние изолировано per-email через keyFor(email).
  ctx.notes.clear(ctx.email);
  apiMock.sendCalls.length = 0;
  await A.sendAudioMessage(ctx, { duration: 3, size: 2048, base64: 'B64', mimeType: 'audio/webm' });
  check('заметка: сообщение в messages (audio), почта НЕ трогалась',
    ctx.chat.list().length === 1 && ctx.chat.list()[0].attachment.isAudio === true && apiMock.sendCalls.length === 0);
  check('заметка сохранена в notes-store', ctx.notes.load(ctx.email).length === 1);
  check('showAudioRecorder выключен', ctx.showAudioRecorder === false);
}

// ── 6. handleFileSelect: лимит провайдера ──────────────────────
console.log('6. handleFileSelect — лимит провайдера');
{
  const alerts = [];
  globalThis.alert = (m) => alerts.push(String(m));
  globalThis.FileReader = class {
    readAsDataURL() { if (this.onload) this.onload({ target: { result: 'data:image/png;base64,ZZZ' } }); }
  };
  const ctx = makeCtx();
  apiMock.sendCalls.length = 0;
  const event = { target: { files: [{ name: 'huge.bin', size: 30 * 1024 * 1024, type: 'application/octet-stream' }], value: 'x' } };
  await A.handleFileSelect(ctx, event);
  check('файл > 70% лимита → alert, почта НЕ трогалась, input сброшен',
    alerts.length === 1 && apiMock.sendCalls.length === 0 && event.target.value === '');
  delete globalThis.alert;
}

// ── 6. Порядок ветвей в MessageItem: DoD-картинка ≠ имя файла ─────
// Регрессия 14.10: fetchDodAttachment выставляет data/isImage/dodStatus,
// но НЕ снимает isDod (он нужен для кэша dodCache). Ветка DoD стояла выше
// ветки isImage, поэтому скачанная картинка навсегда оставалась именем.
// Гейт шаблонов такое не ловит — здесь проверяем условие напрямую.
console.log('7. MessageItem: порядок ветвей вложений');
{
  const itemSrc = readFileSync(path.join(ROOT, 'src/components/MessageItem.vue'), 'utf8');
  const appSrc = readFileSync(path.join(ROOT, 'src/App.vue'), 'utf8');
  const dodBranch = itemSrc.match(/<div[^>]*class="attachment-preview attachment-dod"/);
  check('ветка DoD-карточки найдена', !!dodBranch);

  const dodCond = itemSrc.match(/v-else-if="([^"]*isDod[^"]*)"/);
  check('условие ветки DoD найдено', !!dodCond, dodCond && dodCond[1]);
  check('ветка DoD требует ОТСУТСТВИЯ данных (!msg.attachment.data)',
    !!dodCond && /!\s*msg\.attachment\.data/.test(dodCond[1]), dodCond && dodCond[1]);

  const iDod = itemSrc.indexOf('attachment-preview attachment-dod');
  const iImg = itemSrc.search(/v-else-if="[^"]*\.isImage/);
  check('ветка isImage идёт после DoD (как в шаблоне сейчас)', iDod > 0 && iImg > iDod);

  // Ключевой инвариант фикса: скачанная картинка обязана попасть в <img>.
  const imgBranch = itemSrc.match(/v-else-if="[^"]*\.isImage[\s\S]{0,220}?<img/);
  check('ветка изображения рендерит <img> по данным вложения', !!imgBranch);
  check('просмотрщик открывается кликом по картинке (emit open-image)',
    /@click="\$emit\('open-image'/.test(itemSrc));
  check('просмотрщик в App.vue есть (viewingImage → overlay)',
    appSrc.includes('image-viewer-overlay') && /v-if="viewingImage"/.test(appSrc));
}

// buildVoiceOptimisticMsg: чистый factory (ADR-001 вынос duplicate msg).
{
  const audioData = { duration: 3, size: 204800, base64: 'AAAA', mimeType: 'audio/webm' };
  const msg = A.buildVoiceOptimisticMsg(audioData, {
    id: 'voice-1', timeStr: '12:00', name: 'voice-1.webm',
    status: 'sending', encrypted: true, _pendingAt: 1,
  });
  check('buildVoiceOptimisticMsg контент — 🎙️ + Voice', /🎙️ \[Voice 3s/.test(msg.content));
  check('buildVoiceOptimisticMsg attachment.isAudio', msg.attachment.isAudio === true);
  check('buildVoiceOptimisticMsg id/timeStr переданы', msg.id === 'voice-1' && msg.time === '12:00');
}

// decryptDodBody: чистый decrypt DoD-конверта (групповой/пир-ключ).
{
  const body = JSON.stringify({ vault_dod_data: 1, ref: 'd@x', data: 'AAAA' });
  // Групповой ключ: расшифровка сразу.
  globalThis.__cryptoMock.decryptWithGroupKey = async () => 'group-plain';
  check('decryptDodBody group → plain', await A.decryptDodBody(body, {
    activeChatType: 'group', currentGroup: { id: 'g1' },
    groupKeys: { g1: 'GK' }, senderEmail: '', peerKeys: {}, peerPqKeys: {}, crypto: globalThis.__cryptoMock,
  }) === 'group-plain');
  // 1:1: senderEmail + peerKey → decryptVault.
  globalThis.__cryptoMock.decryptWithGroupKey = null;
  globalThis.__cryptoMock.decryptVault = async () => 'peer-plain';
  check('decryptDodBody peer → plain', await A.decryptDodBody(body, {
    activeChatType: 'peer', currentGroup: null,
    groupKeys: {}, senderEmail: 'p@x', peerKeys: { 'p@x': 'PUB' }, peerPqKeys: {}, crypto: globalThis.__cryptoMock,
  }) === 'peer-plain');
  // Нет ключа → null (без исключения).
  globalThis.__cryptoMock.decryptVault = null;
  check('decryptDodBody no-key → null', await A.decryptDodBody(body, {
    activeChatType: 'peer', currentGroup: null,
    groupKeys: {}, senderEmail: 'p@x', peerKeys: {}, peerPqKeys: {}, crypto: globalThis.__cryptoMock,
  }) === null);
}

// encryptAttachmentEnvelope: чистый encrypt конверта (group/peer), чистый тест.
{
  const be = (p) => JSON.stringify({ vault:1, text:p });
  const cryptoMock2 = { setPeerPublicKey(){}, encryptWithGroupKey: async(e,_k)=>'GK:'+JSON.parse(e).text, encryptVault: async(e)=>'PV:'+JSON.parse(e).text };
  const envId = (e) => JSON.parse(e).text.slice(0,4);
  const base = { buildEnvelope: be, crypto: cryptoMock2, envelopeIdOf: envId };
  // group
  let r = await A.encryptAttachmentEnvelope('pl',{ activeChatType:'group', activeChat:'', currentGroup:{id:'g1'}, groupKeys:{g1:'GK'}, peerKeys:{}, peerPqKeys:{}, cryptoReady:true, ...base });
  check('encryptAttachmentEnvelope group wire', r.wire === 'GK:pl');
  check('encryptAttachmentEnvelope group envelopeId', r.envelopeId === 'pl');
  // peer
  r = await A.encryptAttachmentEnvelope('pl',{ activeChatType:'peer', activeChat:'p@x', currentGroup:null, groupKeys:{}, peerKeys:{'p@x':'PUB'}, peerPqKeys:{}, cryptoReady:true, ...base });
  check('encryptAttachmentEnvelope peer wire', r.wire === 'PV:pl');
  // no key (group без groupKey) → wire=payload, envelopeId=''
  r = await A.encryptAttachmentEnvelope('pl',{ activeChatType:'group', activeChat:'', currentGroup:{id:'gX'}, groupKeys:{}, peerKeys:{}, peerPqKeys:{}, cryptoReady:true, ...base });
  check('encryptAttachmentEnvelope no-key passthrough', r.wire === 'pl' && r.envelopeId === '');
}

// findDodLetter (чистый поиск DoD-письма по Message-ID)
check('findDodLetter находит по message_id (trim/ignore case not applied)',
  A.findDodLetter([{ message_id: 'dod@x' }], '  dod@x  ') &&
  A.findDodLetter([{ message_id: 'dod@x' }], '  dod@x  ').message_id === 'dod@x');
check('findDodLetter нет совпадения → undefined',
  A.findDodLetter([{ message_id: 'a@x' }], 'b@x') === undefined);
check('findDodLetter пустой emails → undefined (no throw)',
  (() => { try { A.findDodLetter(null, 'x'); return true; } catch { return false; } })());

// isDodReady
check('isDodReady true (ready)', A.isDodReady({ dodStatus: 'ready' }) === true);
check('isDodReady true (loading)', A.isDodReady({ dodStatus: 'loading' }) === true);
check('isDodReady false (idle)', A.isDodReady({ dodStatus: 'idle' }) === false);
check('isDodReady false (null)', A.isDodReady(null) === false);

// buildNoteWithAttachment
const nmFile = { name: 'v.webm', type: 'audio/webm', size: 100 };
const nm = A.buildNoteWithAttachment(nmFile, { displayContent: '📎 v.webm', base64: 'AA', isImage: false, isAudio: true, isText: false, textContent: '', timeStr: '11:00' });
check('buildNoteWithAttachment content+from+notes', nm.content === '📎 v.webm' && nm.from === 'me' && nm._notes === true);
check('buildNoteWithAttachment attachment passthrough', nm.attachment.name === 'v.webm' && nm.attachment.isAudio === true);

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
;
