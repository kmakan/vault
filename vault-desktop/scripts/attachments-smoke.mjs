// Node-смоук features/attachments.js — домен «вложения» (ADR-001 пилот).
// Мокаем api/crypto/chatExport/mailProviders/@tauri-apps через подмену
// импортов (заглушки в tmp-модулях), без Vue/Tauri. Цель: застраховать
// ВЫНЕСЕННУЮ из App.vue логику от регрессий (кэш DoD, play/stop голосовых,
// лимиты провайдера, заметки) после декомпозиции.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

let att = readFileSync(ROOT + '/src/features/attachments.js', 'utf8');
att = att
  .replace("from '@tauri-apps/api/core'", 'from "' + MOCKS + '/core.js"')
  .replace("from '../api.js'", 'from "' + MOCKS + '/api.js"')
  .replace("from '../crypto.js'", 'from "' + MOCKS + '/crypto.js"')
  .replace("from '../chatExport.js'", 'from "' + MOCKS + '/chatExport.js"')
  .replace("from '../mailProviders.js'", 'from "' + MOCKS + '/mailProviders.js"');
writeFileSync(MOCKS + '/attachments.mjs', att);
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
    messages: [],
    showAudioRecorder: true,
    showToast: () => {},
    $forceUpdate: () => {},
    t: (k) => k,
    parseEnvelope: (txt) => { try { return JSON.parse(txt); } catch (e) { return null; } },
    buildEnvelope: async (payload) => JSON.stringify({ id: 'env1', text: payload }),
    saveCurrentHistory: () => {},
    saveNotes: () => true,
    loadNotes: () => [],
    markPending: () => {},
    scrollToBottom: () => {},
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

// ── 1. downloadAttachment / openImageViewer ────────────────────
console.log('1. downloadAttachment + openImageViewer');
{
  dl.hits.length = 0;
  A.downloadAttachment(makeCtx(), att0());
  check('скачивание через downloadBase64 с data/name/type',
    dl.hits.length === 1 && dl.hits[0][0] === 'DATA' && dl.hits[0][1] === 'a.png');
  A.downloadAttachment(makeCtx(), null);
  A.downloadAttachment(makeCtx(), { name: 'x' });
  check('нет data / нет attachment — тихий no-op', dl.hits.length === 1);
  const ctx = makeCtx();
  A.openImageViewer(ctx, att0());
  check('openImageViewer кладёт вложение в ctx.viewingImage', ctx.viewingImage && ctx.viewingImage.name === 'a.png');
}

// ── 2. toggleVoiceNote: play → stop ────────────────────────────
console.log('2. toggleVoiceNote (фон. плеер, Android)');
{
  tauri.calls.length = 0;
  const ctx = makeCtx();
  await A.toggleVoiceNote(ctx, { id: 'm1' }, att0());
  check('play: voicenote_play вызван, voicePlayingId = m1',
    tauri.calls.some(c => c[0] === 'voicenote_play') && ctx.voicePlayingId === 'm1');
  await A.toggleVoiceNote(ctx, { id: 'm1' }, att0());
  check('повторный клик по активному треку → voicenote_stop, сброс id',
    tauri.calls.some(c => c[0] === 'voicenote_stop') && ctx.voicePlayingId === '');
  const desk = makeCtx({ isAndroidClient: false });
  tauri.calls.length = 0;
  await A.toggleVoiceNote(desk, { id: 'm2' }, att0());
  check('не-Android — no-op (play не вызван)', !tauri.calls.some(c => c[0] === 'voicenote_play'));
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
  const ctx = makeCtx({ activeChat: '__notes__', messages: [] });
  let saved = null;
  ctx.saveNotes = (list) => { saved = list; return true; };
  ctx.loadNotes = () => [];
  apiMock.sendCalls.length = 0;
  await A.sendAudioMessage(ctx, { duration: 3, size: 2048, base64: 'B64', mimeType: 'audio/webm' });
  check('заметка: сообщение в messages (audio), почта НЕ трогалась',
    ctx.messages.length === 1 && ctx.messages[0].attachment.isAudio === true && apiMock.sendCalls.length === 0);
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

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
