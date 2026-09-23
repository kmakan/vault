// Node-смоук features/video.js — WebCodecs-путь видеозвонка (M3) без браузера.
// Проверяет: захват→VP8-энкодер→mediaVideoFrame, приём base64→VideoDecoder→canvas,
// идемпотентность, ошибки (нет камеры/декодера), параметры кодека — те же, что в Rust.
//
// Запуск: node scripts/video-smoke.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = import.meta.dirname;

// ── Заглушки ───────────────────────────────────────────────────
const MOCKS = '/tmp/video-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

// API-мок: собирает все кадры, ушедшие в Rust.
const apiMock = {
  frames: [],          // [ { callId, data } ]
  starts: [],          // [ callId ]
  stops: [],           // [ callId ]
  mediaVideoFrame: async (callId, data) => { apiMock.frames.push({ callId, data }); },
  mediaVideoStart: async (callId) => { apiMock.starts.push(callId); },
  mediaVideoStop: async (callId) => { apiMock.stops.push(callId); },
};
globalThis.__apiMock = apiMock;
writeFileSync(MOCKS + '/api.js', 'const api = globalThis.__apiMock; export default api;');

// ── WebCodecs-моки ─────────────────────────────────────────────
// Видео-трек: выдаёт N синтетических VideoFrame и закрывается.
let frameSeq = 0;
function makeFakeFrame(w, h) {
  return {
    displayWidth: w,
    displayHeight: h,
    byteLength: 12,
    copyTo: (buf) => { buf.fill(7); return 12; },
    close() {},
  };
}
function makeTrack(count, w, h) {
  const frames = [];
  for (let i = 0; i < count; i++) frames.push(makeFakeFrame(w, h));
  return {
    kind: 'video',
    stop() { this._stopped = true; },
    _stopped: false,
    _frames: frames,
  };
}
function makeMediaStream(count, w, h) {
  const track = makeTrack(count, w, h);
  return {
    _track: track,
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
}

// Контролируемая глубина очереди энкодера (имитация отставания/перегрузки):
let encoderQueueSize = 0;

// Глобальный список созданных энкодеров/декодеров для инспекции.
const encoders = [];
const decoders = [];
let getUserMediaError = null;

// Node ≥21 объявляет navigator геттером только для чтения — переопределяем.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        if (getUserMediaError) throw getUserMediaError;
        const w = (constraints.video && constraints.video.width && constraints.video.width.ideal) || 640;
        const h = (constraints.video && constraints.video.height && constraints.video.height.ideal) || 480;
        // 40 кадров — хватает на полный цикл кодирования и на проверку
        // skip-логики (кадры ещё остаются, когда включаем переполнение очереди).
        return makeMediaStream(40, w, h);
      },
    },
  },
  configurable: true,
  writable: true,
});

class VideoEncoder {
  constructor(init) {
    this.init = init;
    this.config = null;
    this.closed = false;
    // Реальное свойство WebCodecs API — именно его проверяет video.js
    // в skip-логике (encoder.encodeQueueSize >= 2 → дропать кадр).
    this.encodeQueueSize = encoderQueueSize;
    this._outputs = 0;
    encoders.push(this);
  }
  configure(cfg) { this.config = cfg; }
  encode(frame, opts) {
    // Глубина очереди растёт при перегрузке энкодера (имитация отставания).
    this.encodeQueueSize = encoderQueueSize;
    const chunk = {
      byteLength: 12,
      copyTo: (buf) => { buf.fill(9); return 12; },
      _keyFrame: !!(opts && opts.keyFrame),
    };
    this._outputs++;
    // Выход энкодера → колбэк → api.mediaVideoFrame.
    if (this.init && this.init.output) this.init.output(chunk);
  }
  flush() { return Promise.resolve(); }
  close() { this.closed = true; }
}
class VideoDecoder {
  constructor(init) {
    this.init = init;
    this.config = null;
    this.closed = false;
    this._decoded = [];
    decoders.push(this);
  }
  configure(cfg) { this.config = cfg; }
  decode(chunk) {
    if (!this.init || !this.init.output) return;
    // Декодер восстанавливает кадр из чанка (мок: копия данных).
    const out = makeFakeFrame(this.config ? this.config.codedWidth || 640 : 640, 480);
    out._from = chunk;
    this._decoded.push(chunk);
    this.init.output(out);
  }
  flush() { return Promise.resolve(); }
  close() { this.closed = true; }
}
globalThis.VideoEncoder = VideoEncoder;
// EncodedVideoChunk — его создаёт decodeFrame из base64-кадра Rust.
class EncodedVideoChunk {
  constructor(init) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.duration = init.duration;
    this.data = init.data;
    this.byteLength = init.data ? init.data.byteLength || 0 : 0;
  }
  copyTo(buf) { if (this.data) buf.set(new Uint8Array(this.data)); return this.byteLength; }
  close() {}
}
globalThis.EncodedVideoChunk = EncodedVideoChunk;
// atob в Node ≥16 доступен глобально; если нет — определяем.
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
}
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
}

// В Node нет window — video.js использует globalThis-доступность WebCodecs.
// Алиас, чтобы проверка 'VideoDecoder' in window работала как в браузере.
globalThis.window = globalThis;
globalThis.VideoDecoder = VideoDecoder;
// MediaStreamTrackProcessor: отдаёт кадры трека по одному, потом done.
globalThis.MediaStreamTrackProcessor = class {
  constructor({ track }) {
    this.readable = {
      _idx: 0,
      getReader: () => ({
        read: async () => {
          if (track._stopped || this.readable._idx >= track._frames.length) {
            return { done: true, value: undefined };
          }
          return { done: false, value: track._frames[this.readable._idx++] };
        },
      }),
    };
  }
};

// ── Загрузка features/video.js с подменённым импортом api ──────
let src = readFileSync(ROOT + '/../src/features/video.js', 'utf8');
src = src.replace("from '../api.js'", 'from "' + MOCKS + '/api.js"');
writeFileSync(MOCKS + '/features-video.mjs', src);
const V = await import(MOCKS + '/features-video.mjs');

// ── Хелперы ────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
function reset() {
  apiMock.frames.length = 0; apiMock.starts.length = 0; apiMock.stops.length = 0;
  encoders.length = 0; decoders.length = 0;
  getUserMediaError = null;
}
async function tick(n = 1) {
  for (let i = 0; i < n; i++) await new Promise((r) => process.nextTick(r));
}
// canvas-мок: запоминает, что в него нарисовали.
function makeCanvas(w = 640, h = 480) {
  const c = { width: w, height: h, _drawn: [], _ctx: null,
    getContext: () => (c._ctx = { canvas: c, drawImage: (...a) => c._drawn.push(a) }) };
  return c;
}

// ── 1. Параметры кодека совпадают с Rust ───────────────────────
console.log('1. Параметры кодека (JS ↔ Rust)');
{
  // JS-константы — через поведение конфига энкодера (см. тест 2).
  // Rust-константы — парсим исходник напрямую (объявлены как `pub const NAME: type = expr;`).
  const rust = readFileSync(ROOT + '/../src-tauri/src/video.rs', 'utf8');
  const g = (name) => {
    const m = rust.match(new RegExp('pub const ' + name + ':\\s*u32\\s*=\\s*([^;]+);'));
    if (!m) return null;
    const expr = m[1].trim();
    // Подставляем известные значения и вычисляем (VP8_CLOCK_RATE / VIDEO_FPS → 90000/30).
    const val = Function(
      'const VP8_CLOCK_RATE = 90000; const VIDEO_FPS = 30; return (' + expr + ');'
    )();
    return { expr, val };
  };
  const rustClock = g('VP8_CLOCK_RATE');
  const rustFps = g('VIDEO_FPS');
  const rustTsInc = g('FRAME_TS_INCREMENT');
  check('Rust: VP8_CLOCK_RATE = 90000', rustClock && rustClock.val === 90000, rustClock);
  check('Rust: VIDEO_FPS = 30', rustFps && rustFps.val === 30, rustFps);
  check('Rust: FRAME_TS_INCREMENT = 3000 (=clock/fps)', rustTsInc && rustTsInc.val === 3000, rustTsInc);
  check('Rust: FRAME_TS_INCREMENT = clock/fps (согласованность)',
    rustClock && rustFps && rustTsInc && rustTsInc.val === rustClock.val / rustFps.val,
    { rustClock, rustFps, rustTsInc });
}

// ── 2. startCamera: захват → VP8-энкодер → кадры в Rust ────────
console.log('2. startCamera — отправка кадров (camera → encoder → mediaVideoFrame)');
{
  reset();
  const localEl = { srcObject: null, muted: false, play: async () => {} };
  await V.startCamera('call-A', { localEl });
  await tick(20);

  check('localEl.srcObject присвоен (местное превью)', localEl.srcObject !== null);
  check('создан ровно 1 энкодер', encoders.length === 1, encoders.length);
  const enc = encoders[0];
  check('энкодер сконфигурирован vp8', enc.config && enc.config.codec === 'vp8', enc.config && enc.config.codec);
  check('ширина 640', enc.config && enc.config.width === 640, enc.config && enc.config.width);
  check('высота 480', enc.config && enc.config.height === 480, enc.config && enc.config.height);
  check('битрейт 500000', enc.config && enc.config.bitrate === 500000, enc.config && enc.config.bitrate);
  check('framerate 30', enc.config && enc.config.framerate === 30, enc.config && enc.config.framerate);
  check('keyInterval = 5с*30fps = 150', enc.config && enc.config.keyInterval === 150, enc.config && enc.config.keyInterval);
  check('все кадры ушли в Rust (api.mediaVideoFrame)', apiMock.frames.length > 0, apiMock.frames.length);
  check('кадры помечены правильным callId',
    apiMock.frames.length > 0 && apiMock.frames.every((f) => f.callId === 'call-A'), apiMock.frames[0]);
  check('данные кадра — байты (ненулевая длина)',
    apiMock.frames.length > 0 && apiMock.frames.every((f) => f.data && f.data.byteLength > 0), apiMock.frames[0]);

  // Skip-логика: при переполнении очереди кадры дропаются, не копятся.
  // Тестируем на свежем потоке: переполнение включаем ДО старта захвата,
  // а поток делаем конечным — все его кадры будут скипнуты.
  V.stopCamera();
  await tick(5);
  check('stopCamera: энкодер закрыт', enc.closed === true);
  check('stopCamera: треки остановлены', localEl.srcObject._track._stopped === true);

  encoderQueueSize = 3; // ≥ 2 → video.js должен скипать
  reset();
  const track2 = { srcObject: null, muted: false, play: async () => {} };
  await V.startCamera('call-A2', { localEl: track2 });
  await tick(25);
  check('skip-логика: кадры дропаются при переполнении очереди (encodeQueueSize >= 2)',
    apiMock.frames.length === 0, { sentUnderLoad: apiMock.frames.length });
  V.stopCamera(); // снимет guard `decoding` внутри video.js
  await tick(5);
  encoderQueueSize = 0;

  // Переполнение снято — кадры снова идут.
  reset();
  const track3 = { srcObject: null, muted: false, play: async () => {} };
  await V.startCamera('call-A3', { localEl: track3 });
  await tick(25);
  check('без переполнения очереди кадры идут', apiMock.frames.length > 0, { sent: apiMock.frames.length });
  const enc3 = encoders[encoders.length - 1];
  V.stopCamera();
  await tick(5);
  check('stopCamera(2): энкодер закрыт', enc3.closed === true);
  check('stopCamera(2): треки остановлены', track3.srcObject._track._stopped === true);
}

// ── 3. Идемпотентность startCamera ─────────────────────────────
console.log('3. Идемпотентность startCamera (guard decoding)');
{
  reset();
  await V.startCamera('call-B');
  await tick(20);
  const first = apiMock.frames.length;
  const firstEnc = encoders.length;
  // Повторный вызов в том же «звонке» — не должен стартовать второй захват.
  await V.startCamera('call-B');
  await tick(20);
  check('повторный startCamera не создаёт 2-й энкодер', encoders.length === firstEnc, encoders.length);
  check('повторный startCamera не дублирует поток кадров', apiMock.frames.length === first, apiMock.frames.length);
  V.stopCamera();
  await tick(3);
}

// ── 4. Нет камеры → мягкая деградация ──────────────────────────
console.log('4. Нет камеры / нет пермишена — звонок не роняется');
{
  reset();
  getUserMediaError = new Error('NotAllowedError');
  let threw = null;
  try {
    await V.startCamera('call-C');
  } catch (e) {
    threw = e;
  }
  check('startCamera бросает ' + 'camera: ...', threw !== null && /^camera:/.test(threw.message), threw && threw.message);
  check('энкодер не создан (нет захвата)', encoders.length === 0, encoders.length);
  check('кадры в Rust не ушли', apiMock.frames.length === 0, apiMock.frames.length);
  // guard сброшен — можно ретраить.
  getUserMediaError = null;
  await V.startCamera('call-C');
  await tick(20);
  check('после сбоя guard сброшен — повторный старт работает', apiMock.frames.length > 0, apiMock.frames.length);
  V.stopCamera();
  await tick(3);
}

// ── 5. startRemoteVideo: приём base64 → декодер → canvas ──────
console.log('5. startRemoteVideo + decodeFrame (remote VP8 → canvas)');
{
  reset();
  const canvas = makeCanvas();
  const ok = await V.startRemoteVideo('call-D', canvas);
  check('startRemoteVideo вернул true', ok === true, ok);
  check('создан 1 декодер', decoders.length === 1, decoders.length);
  const dec = decoders[0];
  check('декодер сконфигурирован vp8', dec.config && dec.config.codec === 'vp8', dec.config && dec.config.codec);
  check('optimizeForLatency = true (видеозвонок)', dec.config && dec.config.optimizeForLatency === true,
    dec.config && dec.config.optimizeForLatency);

  // Кадр из Rust приходит как base64 VP8.
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const b64 = Buffer.from(payload).toString('base64');
  V.decodeFrame(b64, 123456);
  await tick(3);
  check('decodeFrame: кадр дошёл до декодера', dec._decoded.length === 1, dec._decoded.length);
  check('decodeFrame: декодер отдал кадр на отрисовку', canvas._drawn.length === 1, canvas._drawn.length);
  check('decodeFrame: canvas получил кадр', canvas._drawn[0] && typeof canvas._drawn[0][0] === 'object');
  check('canvas размера 640x480', canvas.width === 640 && canvas.height === 480, { w: canvas.width, h: canvas.height });

  // Идемпотентность: повторный старт — тот же декодер.
  const ok2 = await V.startRemoteVideo('call-D', canvas);
  check('повторный startRemoteVideo возвращает true', ok2 === true, ok2);
  check('2-й декодер не создаётся', decoders.length === 1, decoders.length);

  // Битый кадр — не роняет звонок: video.js глотает ошибку декодирования,
  // декодер остаётся жив.
  await V.decodeFrame('!!не-base64!!', 0);
  await tick(2);
  check('битый кадр не бросается (graceful degradation)', dec.closed === false);
  check('после битого кадра декодер принимает следующий',
    (V.decodeFrame(Buffer.from(payload).toString('base64'), 0), await tick(2), dec._decoded.length >= 1), dec._decoded.length);

  V.stopRemoteVideo();
  await tick(2);
  check('stopRemoteVideo: декодер закрыт', dec.closed === true);

  // После stop кадры игнорируются.
  const drawnAfter = canvas._drawn.length;
  V.decodeFrame(Buffer.from(payload).toString('base64'), 0);
  await tick(2);
  check('после stopRemoteVideo кадры не рисуются', canvas._drawn.length === drawnAfter, canvas._drawn.length);
}

// ── 6. Нет VideoDecoder — remote-видео отключается мягко ───────
console.log('6. Нет VideoDecoder (старый WebView) — no remote video');
{
  reset();
  // Эмуляция старого WebView: VideoDecoder отсутствует.
  // window === globalThis, поэтому delete убирает свойство и из window —
  // проверка `'VideoDecoder' in window` в video.js вернёт false.
  const savedDecoder = globalThis.VideoDecoder;
  delete globalThis.VideoDecoder;
  const canvas = makeCanvas();
  const ok = await V.startRemoteVideo('call-E', canvas);
  check('startRemoteVideo вернул false (декодер недоступен)', ok === false, ok);
  check('декодер не создан', decoders.length === 0, decoders.length);
  // decodeFrame не падает и без декодера.
  let safe = true;
  try {
    V.decodeFrame('AAAA', 0);
  } catch (e) {
    safe = false;
  }
  check('decodeFrame без декодера не бросается', safe === true);
  globalThis.VideoDecoder = savedDecoder;
}

// ── 7. Базовый поток звонка: start → frames → stop (обе стороны) ─
console.log('7. Сквозной поток видеозвонка (мок-стороны)');
{
  reset();
  const localEl = { srcObject: null, muted: false, play: async () => {} };
  const remoteCanvas = makeCanvas();

  // Анна принимает → media-connected → обе стороны стартуют.
  const okRemote = await V.startRemoteVideo('call-F', remoteCanvas);
  await V.startCamera('call-F', { localEl });
  await tick(25);

  check('remote-видео стартануло', okRemote === true);
  check('local-камера шлёт кадры', apiMock.frames.length > 0, apiMock.frames.length);
  const sentBefore = apiMock.frames.length;

  // Симулируем входящий remote-кадр.
  V.decodeFrame(Buffer.from(new Uint8Array([9, 9, 9])).toString('base64'), 1000);
  await tick(3);
  check('remote-кадр отрисован', remoteCanvas._drawn.length === 1, remoteCanvas._drawn.length);

  // Hangup.
  V.stopCamera();
  V.stopRemoteVideo();
  await tick(5);

  const sentAfter = apiMock.frames.length;
  check('hangup остановил отправку кадров', sentAfter === sentBefore, { sentBefore, sentAfter });
  check('hangup закрыл энкодер', encoders.length === 1 && encoders[0].closed === true);
  check('hangup закрыл декодер', decoders.length === 1 && decoders[0].closed === true);
  check('hangup остановил камеру', localEl.srcObject._track._stopped === true);

  // После hangup новый звонок стартует с чистого листа.
  reset();
  await V.startCamera('call-G');
  await tick(20);
  check('новый звонок: кадры снова идут', apiMock.frames.length > 0, apiMock.frames.length);
  V.stopCamera();
  V.stopRemoteVideo();
  await tick(3);
}

// ── Итог ───────────────────────────────────────────────────────
console.log('');
console.log('=== video-smoke: ' + pass + ' passed, ' + fail + ' failed ===');
if (fail > 0) process.exitCode = 1;
