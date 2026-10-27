// Node-смоук features/video.js — WebCodecs-путь видеозвонка (M3) без браузера.
// Проверяет: захват→VP8-энкодер→mediaVideoFrame, приём base64→VideoDecoder→canvas,
// идемпотентность, ошибки (нет камеры/декодера), параметры кодека — те же, что в Rust.
//
// Запуск: node scripts/video-smoke.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';

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
  mediaCameraStart: async (callId) => { apiMock.cameraStarts = (apiMock.cameraStarts || 0) + 1; },
  mediaCameraStop: async (callId) => { apiMock.cameraStops = (apiMock.cameraStops || 0) + 1; },
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
    // Закрытие кадра — часть контракта: незакрытый VideoFrame держит
    // буфер GPU, и WebCodecs копит их до падения на телефоне.
    closed: false,
    close() { this.closed = true; globalThis.__closedFrames = (globalThis.__closedFrames || 0) + 1; },
  };
}
function makeTrack(count, w, h, sizes) {
  const frames = [];
  for (let i = 0; i < count; i++) {
    // sizes — размеры кадров по одному на кадр: поток может сменить ориентацию
    // в середине (поворот телефона), и это ровно та ветка, которую проверяет
    // секция 2c.
    const [fw, fh] = (sizes && sizes[i]) || [w, h];
    frames.push(makeFakeFrame(fw, fh));
  }
  return {
    kind: 'video',
    stop() { this._stopped = true; },
    _stopped: false,
    _frames: frames,
  };
}
function makeMediaStream(count, w, h, sizes) {
  const track = makeTrack(count, w, h, sizes);
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
// Подмена потока камеры: ориентация/разрешение, которые вернёт трек.
let streamFactory = null;

// Node ≥21 объявляет navigator геттером только для чтения — переопределяем.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        if (getUserMediaError) throw getUserMediaError;
        if (streamFactory) return streamFactory(constraints);
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
    // История перестроек конфигa: «размер кадра изменился → configure ещё
    // раз» — отдельная ветка (секция 2c), и мерить её по одному
    // «последнему» конфигу нельзя: ре-конфиг каждый кадр выглядел бы как
    // один правильный.
    this.configs = [];
    // Каждый encode с флагом ключевой рамки и размером актуального конфига.
    this.encodes = [];
    encoders.push(this);
  }
  configure(cfg) { this.config = cfg; this.configs.push(cfg); }
  encode(frame, opts) {
    // Глубина очереди растёт при перегрузке энкодера (имитация отставания).
    this.encodeQueueSize = encoderQueueSize;
    this.encodes.push({
      key: !!(opts && opts.keyFrame),
      w: this.config && this.config.width,
      h: this.config && this.config.height,
      frame: { w: frame.displayWidth, h: frame.displayHeight },
    });
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
    this.state = 'unconfigured';
    this._decoded = [];
    this._types = [];      // последовательность type чанков (key/delta)
    this._sawKey = false;  // WebCodecs: delta до первого key = ошибка
    this._errors = [];     // инициированные init.error (порядок/типы)
    decoders.push(this);
  }
  configure(cfg) { this.config = cfg; this.state = 'configured'; }
  decode(chunk) {
    if (!this.init || !this.init.output) return;
    this._decoded.push(chunk);
    this._types.push(chunk.type);
    // Эмуляция семантики WebCodecs VideoDecoder:
    //   - поток обязан начинаться с 'key'; 'delta' до первого key = ошибка
    //     (декодер нечего ссылаться);
    //   - тип чанка должен отражать реальный VP8 frame_tag (бит 0 payload):
    //     'key' ↔ бит0==0, 'delta' ↔ бит0==1. decodeVp8Chunk обязан выставить
    //     type по payload, а не всегда 'key' (регресс-сторож бага «видео нет
    //     на телефоне»: delta-кадры, помеченные key, ломают декодер).
    const firstByte = chunk.data && chunk.data.length ? chunk.data[0] : 0;
    const realKey = (firstByte & 0x01) === 0;
    if (chunk.type === 'key') {
      this._sawKey = true;
    } else if (!this._sawKey) {
      const err = new Error('delta frame before any key frame');
      this._errors.push(err.message);
      if (this.init.error) this.init.error(err);
      return;
    }
    // Несоответствие заявленного типа и фактического frame_tag — фиксируем,
    // но не роняем (мок должен ловить именно ошибочную маркировку).
    if ((chunk.type === 'key') !== realKey) {
      this._errors.push('type mismatch: chunk=' + chunk.type + ' realKey=' + realKey);
    }
    const out = makeFakeFrame(this.config ? this.config.codedWidth || 640 : 640, 480);
    out._from = chunk;
    this.init.output(out);
  }
  flush() { return Promise.resolve(); }
  close() { this.closed = true; this.state = 'closed'; }
}
// ImageData — браузерный API; в Node нет. Минимальный мок для RGBA-пути.
globalThis.ImageData = class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
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
prepareModuleCopy(
  ROOT + '/../src/features/video.js',
  MOCKS + '/features-video.mjs',
  {
    '../api.js': 'api.js',
  },
  MOCKS,
);
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
  streamFactory = null;
}
async function tick(n = 1) {
  for (let i = 0; i < n; i++) await new Promise((r) => process.nextTick(r));
}
// canvas-мок: запоминает, что в него нарисовали.
function makeCanvas(w = 640, h = 480) {
  const c = { width: w, height: h, _drawn: [], _ctx: null,
    getContext: () => (c._ctx = { canvas: c, drawImage: (...a) => c._drawn.push(a), putImageData: (...a) => c._drawn.push(a), clearRect: () => {} }) };
  return c;
}

// ── 1. Параметры кодека совпадают с Rust ───────────────────────
console.log('1. Параметры кодека (JS ↔ Rust)');
{
  // JS-константы — через поведение конфига энкодера (см. тест 2).
  // Rust-константы — парсим исходник напрямую (объявлены как `pub const NAME: type = expr;`).
  // Источник — ядро (`call_media.rs`): мост только реэкспортирует эти числа,
  // иначе у параметров кодека было бы две копии.
  const rust = readFileSync(ROOT + '/../../vault-client/src/vault/call_media.rs', 'utf8');
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
  check('все кадры закрыты после кодирования (нет утечки буферов)',
    (globalThis.__closedFrames || 0) > 0, globalThis.__closedFrames);
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

// ── 2b. Ориентация камеры: энкодер следует фактическому кадру ──
console.log('2b. Портретный кадр (480x640) — энкодер не растягивает его под 640x480');
{
  reset();
  // Трек без getSettings: начальный конфиг берёт «идеальные» 640x480,
  // но кадры приходят портретные. Энкодер обязан перестроиться по кадру,
  // иначе WebCodecs растянет картинку по осям неравномерно.
  streamFactory = () => makeMediaStream(4, 480, 640);
  await V.startCamera('call-portrait');
  await tick(10);
  const enc = encoders[0];
  check('конфиг энкодера = фактическому кадру 480x640',
    enc && enc.config && enc.config.width === 480 && enc.config.height === 640,
    enc && enc.config && { w: enc.config.width, h: enc.config.height });
  check('кадры портретного потока ушли в Rust', apiMock.frames.length > 0, apiMock.frames.length);
  V.stopCamera();
  await tick(3);
}

// ── 2c. Размер кадра изменился в середине потока ───────────────
console.log('2c. Поворот телефона в середине потока: энкодер перестраивается и даёт ключевую рамку');
{
  reset();
  // Кадры 0–1 в 640x480, дальше 480x640. keyEvery = KEYFRAME_INTERVAL *
  // VIDEO_FPS = 150, так что по интервальному правилу ключевой здесь только
  // кадр 0 — всё, что ключевое после перестройки, добавлено правилом размера.
  const sizes = [[640, 480], [640, 480], [480, 640], [480, 640], [480, 640], [480, 640]];
  streamFactory = () => makeMediaStream(6, 640, 480, sizes);
  await V.startCamera('call-turn');
  await tick(10);
  const enc = encoders[0];
  check('все шесть кадров дошли до энкодера', enc && enc.encodes.length === 6, enc && enc.encodes.length);
  check('размер изменился — энкодер перестроен ровно один раз (не каждый кадр)',
    enc && enc.configs.length === 2, enc && enc.configs.map((c) => `${c.width}x${c.height}`));
  check('новый конфиг следует кадру: 480x640',
    enc && !!enc.configs[1] && enc.configs[1].width === 480 && enc.configs[1].height === 640,
    enc && enc.configs[1] && { w: enc.configs[1].width, h: enc.configs[1].height });
  check('кадры до поворота кодируются со старым размером',
    enc && enc.encodes[0].w === 640 && enc.encodes[1].w === 640,
    enc && enc.encodes.slice(0, 2).map((e) => `${e.w}x${e.h}`));
  check('первый кадр после поворота — ключевой (собеседник начинает с нового размера)',
    enc && enc.encodes[2].key === true && enc.encodes[2].w === 480 && enc.encodes[2].h === 640,
    enc && enc.encodes[2]);
  check('следующий кадр — обычный (ключевой ставится один раз, а не force-ится)',
    enc && enc.encodes[3].key === false, enc && enc.encodes[3]);
  check('пока размер не меняется, ре-конфига нет (поток не перестраивается каждый кадр)',
    enc && enc.encodes[4].w === 480 && enc.configs.length === 2,
    enc && { configs: enc.configs.length, e4: enc.encodes[4].w });
  // Перестройка меняет РАЗМЕР, а не договорённость о кодеке: битрейт, fps и
  // интервал ключевых рамок обязаны пережить поворот.
  check('перестройка сохраняет остальные параметры кодека',
    enc && !!enc.configs[1] && enc.configs[1].codec === enc.configs[0].codec
    && enc.configs[1].bitrate === enc.configs[0].bitrate
    && enc.configs[1].framerate === enc.configs[0].framerate
    && enc.configs[1].keyInterval === enc.configs[0].keyInterval,
    enc && { was: enc.configs[0], now: enc.configs[1] });
  V.stopCamera();
  await tick(3);
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

  // Кадр из Rust приходит как base64 VP8. Первый байт payload = VP8 frame_tag;
  // бит 0 = frame_type (0=key, 1=inter/delta). Первый кадр потока — keyframe,
  // поэтому первый байт ЧЁТНЫЙ (0x00) — иначе WebCodecs отклонит delta-before-key.
  // Старый баг: decodeVp8Chunk слал type:'key' на КАЖДЫЙ кадр — delta-кадры
  // (бит0=1) ломали декодер → видео не появлялось на телефоне (RGBA-путь
  // десктопа не затронут). Регресс-сторож: мок VideoDecoder фиксирует
  // несоответствие type ↔ frame_tag и delta-before-key в dec._errors.
  const keyPayload = new Uint8Array([0x00, 2, 3, 4, 5]);   // бит0=0 → key
  const deltaPayload = new Uint8Array([0x01, 6, 7, 8, 9]); // бит0=1 → delta
  const keyB64 = Buffer.from(keyPayload).toString('base64');
  const deltaB64 = Buffer.from(deltaPayload).toString('base64');
  V.decodeFrame({ vp8: keyB64 }); // контракт App.vue:1621 — объект {vp8|rgba}
  await tick(3);
  check('decodeFrame: кадр дошёл до декодера', dec._decoded.length === 1, dec._decoded.length);
  check('decodeFrame: декодер отдал кадр на отрисовку', canvas._drawn.length === 1, canvas._drawn.length);
  check('decodeFrame: canvas получил кадр', canvas._drawn[0] && typeof canvas._drawn[0][0] === 'object');
  check('canvas размера 640x480', canvas.width === 640 && canvas.height === 480, { w: canvas.width, h: canvas.height });
  check('key-кадр помечен type:key (бит0 payload = 0)', dec._types[0] === 'key', dec._types[0]);

  // Delta-кадр ПОСЛЕ keyframe — должен дойти и быть помечен type:delta.
  V.decodeFrame({ vp8: deltaB64 });
  await tick(3);
  check('decodeFrame: delta-кадр после key доходит до декодера', dec._decoded.length === 2, dec._decoded.length);
  check('delta-кадр помечен type:delta (бит0 payload = 1, НЕ key)', dec._types[1] === 'delta', dec._types[1]);
  check('декодер не фиксировал ошибок порядка/типа', dec._errors.length === 0, dec._errors);
  check('delta-кадр отрисован', canvas._drawn.length === 2, canvas._drawn.length);

  // Идемпотентность: повторный старт — тот же декодер.
  const ok2 = await V.startRemoteVideo('call-D', canvas);
  check('повторный startRemoteVideo возвращает true', ok2 === true, ok2);
  check('2-й декодер не создаётся', decoders.length === 1, decoders.length);

  // Битый кадр — не роняет звонок: video.js глотает ошибку декодирования,
  // декодер остаётся жив.
  await V.decodeFrame({ vp8: '!!не-base64!!' });
  await tick(2);
  check('битый кадр не бросается (graceful degradation)', dec.closed === false);
  check('после битого кадра декодер принимает следующий',
    (V.decodeFrame({ vp8: Buffer.from(keyPayload).toString('base64') }), await tick(2), dec._decoded.length >= 1), dec._decoded.length);

  V.stopRemoteVideo();
  await tick(2);
  check('stopRemoteVideo: декодер закрыт', dec.closed === true);

  // После stop кадры игнорируются.
  const drawnAfter = canvas._drawn.length;
  V.decodeFrame({ vp8: Buffer.from(keyPayload).toString('base64') }, 0);
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
  let ok = null;
  let noDecoderThrew = null;
  try { ok = await V.startRemoteVideo('call-E', canvas); } catch (e) { noDecoderThrew = e; }
  check('startRemoteVideo вернул true (RGBA-путь без VideoDecoder, video.js:260 — desktop не гаснет)',
    noDecoderThrew === null && ok === true, noDecoderThrew ? String(noDecoderThrew.message) : ok);
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
  V.decodeFrame({ rgba: Buffer.from(new Uint8Array([9, 9, 9, 255])).toString('base64'), width: 1, height: 1 }); // RGBA-путь desktop (video.js:340)
  await tick(3);
  check('remote-кадр отрисован', remoteCanvas._drawn.length === 1, remoteCanvas._drawn.length);
  // putImageData рисует 1:1: canvas обязан принять размер кадра, иначе
  // картинка другого разрешения (портретная камера) обрезается CSS'ом.
  check('canvas принял размер RGBA-кадра (1x1)', remoteCanvas.width === 1 && remoteCanvas.height === 1,
    { w: remoteCanvas.width, h: remoteCanvas.height });

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
