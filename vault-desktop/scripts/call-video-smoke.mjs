// Node-смоук features/call-video.js — видео в звонке.
//
// ADR-005 W3 (`t_b1bdbb99`), партия 1: логика видео уехала из App.vue в
// фичу. Проверяем контракт: переключатель, старт/стоп потоков, отказы
// (удалённый декодер недоступен / камера отказала) и идемпотентность стопа.
//
// Моки: api.js (mediaVideoStart/mediaVideoStop) и video.js (движок).
// Настоящие: session-store.js (тосты) и call-session.js (владелец состояния).
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = import.meta.dirname;
const MOCKS = '/tmp/call-video-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// ── Мок api ──────────────────────────────────────────────────────────────
globalThis.__apiMock = {
  calls: [],
  mediaVideoStart: async (cid) => { globalThis.__apiMock.calls.push(['start', cid]); },
  mediaVideoStop: async (cid) => { globalThis.__apiMock.calls.push(['stop', cid]); },
};
writeFileSync(MOCKS + '/api.js',
  'const api = globalThis.__apiMock; export const db = { kvGet: async () => null, kvSet: async () => {} };\nexport default api;\n');

// ── Мок видео-движка ─────────────────────────────────────────────────────
globalThis.__videoMock = {
  calls: [],
  remoteOk: true,
  cameraThrows: false,
  remoteThrows: false,
  startRemoteVideo: async (cid, canvas) => {
    globalThis.__videoMock.calls.push(['startRemote', cid, !!canvas]);
    if (globalThis.__videoMock.remoteThrows) throw new Error('remote decoder failed');
    return globalThis.__videoMock.remoteOk;
  },
  startCamera: async (cid) => {
    globalThis.__videoMock.calls.push(['startCamera', cid]);
    if (globalThis.__videoMock.cameraThrows) throw new Error('no camera');
  },
  stopCamera: () => { globalThis.__videoMock.calls.push(['stopCamera']); },
  stopRemoteVideo: () => { globalThis.__videoMock.calls.push(['stopRemoteVideo']); },
  decodeFrame: (p) => { globalThis.__videoMock.calls.push(['decodeFrame', p]); },
};
writeFileSync(MOCKS + '/video.js',
  'export const startRemoteVideo = (...a) => globalThis.__videoMock.startRemoteVideo(...a);\n'
  + 'export const startCamera = (...a) => globalThis.__videoMock.startCamera(...a);\n'
  + 'export const stopCamera = () => globalThis.__videoMock.stopCamera();\n'
  + 'export const stopRemoteVideo = () => globalThis.__videoMock.stopRemoteVideo();\n'
  + 'export const decodeFrame = (p) => globalThis.__videoMock.decodeFrame(p);\n');

prepareModuleCopy(
  ROOT + '/../src/features/call-video.js',
  MOCKS + '/features-call-video.mjs',
  {
    '../api.js': 'api.js',
    './video.js': 'video.js',
  },
  MOCKS,
);
const V = await import(MOCKS + '/features-call-video.mjs');
const { callSession } = await import(ROOT + '/../src/features/call-session.js');
const { uiStore } = await import(ROOT + '/../src/features/session-store.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

// Тосты — в стенд (как это делает App.vue через setShowToast).
const toasts = [];
uiStore.setShowToast((msg) => { toasts.push(msg); });

function reset(over = {}) {
  globalThis.__apiMock.calls.length = 0;
  globalThis.__videoMock.calls.length = 0;
  globalThis.__videoMock.remoteOk = true;
  globalThis.__videoMock.cameraThrows = false;
  globalThis.__videoMock.remoteThrows = false;
  toasts.length = 0;
  callSession.state.currentCall = over.currentCall === undefined ? { call_id: 'c1', peer: 'p@x.ru' } : over.currentCall;
  callSession.state.callMediaConnected = over.callMediaConnected === undefined ? true : over.callMediaConnected;
  callSession.state.callVideoOn = over.callVideoOn === undefined ? false : over.callVideoOn;
}
const deps = {
  nextTick: async () => {},
  getRemoteCanvas: () => ({ tag: 'CANVAS' }),
};
const has = (name) => globalThis.__videoMock.calls.some((c) => c[0] === name);
const apiHas = (name) => globalThis.__apiMock.calls.some((c) => c[0] === name);

// 1. Без звонка — переключатель ничего не делает
console.log('1. Без звонка — no-op');
{
  reset({ currentCall: null });
  V.toggleCallVideo(deps);
  check('нет звонка → видео не включается', !has('startRemote') && callSession.state.callVideoOn === false);
}

// 2. Медиа не подключено — no-op
console.log('2. Медиа не подключено — no-op');
{
  reset({ callMediaConnected: false });
  V.toggleCallVideo(deps);
  check('медиа не подключено → no-op', !has('startRemote') && callSession.state.callVideoOn === false);
}

// 3. Переключатель ВКЛЮЧАЕТ видео
console.log('3. Переключатель включает видео');
{
  reset();
  await V.startCallVideo(deps);
  check('флаг видео поднят', callSession.state.callVideoOn === true);
  check('remote-декодер запущен с canvas', has('startRemote'), globalThis.__videoMock.calls);
  check('mediaVideoStart вызван', apiHas('start'));
  check('камера запущена', has('startCamera'));
  check('тостов нет', toasts.length === 0, toasts);
}

// 4. Переключатель ВЫКЛЮЧАЕТ видео
console.log('4. Переключатель выключает видео');
{
  reset({ callVideoOn: true });
  V.toggleCallVideo(deps);
  check('камера остановлена', has('stopCamera'));
  check('remote-декодер остановлен', has('stopRemoteVideo'));
  check('флаг видео опущен', callSession.state.callVideoOn === false);
  check('mediaVideoStop вызван', apiHas('stop'));
}

// 5. Стоп идемпотентен: видео не было включено — ничего не делаем
console.log('5. Стоп без включённого видео — no-op');
{
  reset({ callVideoOn: false });
  V.stopCallVideo(deps);
  check('видео не было включено → ни стопа камеры, ни mediaVideoStop',
    !has('stopCamera') && !apiHas('stop'));
}

// 6. Remote-декодер недоступен → видео выключается, тост
console.log('6. Remote-декодер недоступен');
{
  reset();
  globalThis.__videoMock.remoteOk = false;
  await V.startCallVideo(deps);
  check('флаг видео опущен', callSession.state.callVideoOn === false);
  check('mediaVideoStart НЕ вызван', !apiHas('start'));
  check('тост «видео недоступно»', toasts.length === 1 && /недоступно|unavailable/i.test(toasts[0]), toasts);
}

// 7. Remote-декодер упал (исключение) → видео выключается, тост
console.log('7. Remote-декодер упал');
{
  reset();
  globalThis.__videoMock.remoteThrows = true;
  await V.startCallVideo(deps);
  check('флаг видео опущен', callSession.state.callVideoOn === false);
  check('remote-декодер остановлен', has('stopRemoteVideo'));
  check('тост «не удалось включить видео»', toasts.length === 1 && /не удалось|failed/i.test(toasts[0]), toasts);
}

// 8. Камера отказала, но remote работает → видео ОСТАЁТСЯ включённым
console.log('8. Камера отказала — видео остаётся включённым');
{
  reset();
  globalThis.__videoMock.cameraThrows = true;
  await V.startCallVideo(deps);
  check('флаг видео поднят (remote работает)', callSession.state.callVideoOn === true);
  check('mediaVideoStart вызван', apiHas('start'));
  check('тост «камера недоступна»', toasts.length === 1 && /камера|camera/i.test(toasts[0]), toasts);
}

// 9. Видео уже включено → повторный старт ничего не делает
console.log('9. Повторный старт при включённом видео — no-op');
{
  reset({ callVideoOn: true });
  await V.startCallVideo(deps);
  check('повторный старт не трогает движок', !has('startRemote') && !has('startCamera'));
}

// 10. decodeFrame/stopVideoTracks — делегаты движку
console.log('10. Кадры и остановка треков');
{
  reset();
  V.decodeFrame({ x: 1 });
  check('кадр передан декодеру', has('decodeFrame'));
  V.stopVideoTracks();
  check('треки остановлены', has('stopCamera') && has('stopRemoteVideo'));
}

console.log('\n=== ИТОГ: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
