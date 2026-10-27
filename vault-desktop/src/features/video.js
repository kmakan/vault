// Feature module: видеозвонки (M3, шаг 3/3) — WebView-сторона.
//
// WebRTC живёт в Rust (webrtc-rs): JS обменивается SDP-строками через
// media_start_outgoing/accept_incoming/set_remote. Кадры камер туда не
// попадают — нет RTCPeerConnection в JS. Поэтому видео идёт тем же путём,
// что и аудио: кадры → Rust → E2E-шифр → RTP-трек.
//
// Захват и кодирование камеры — платформозависимо:
//   Android (Chrome WebView): getUserMedia({video}) → VideoFrame
//     → VideoEncoder('vp8') → invoke('media_video_frame') (здесь, в JS).
//   Desktop (WebKitGTK): JS не может — движок не декодирует MediaStream в
//     <video> (readyState остаётся 0, `new VideoFrame(videoEl)` бросает
//     InvalidStateError). Поэтому камеру и VP8-энкод делает Rust
//     (V4L2 + libvpx, `video.rs`), а JS лишь открывает writer звонка
//     `media_camera_start` (ADR-005: логика — в Rust).
//
// Приём — событие 'call-video-frame' из Rust (media_video_start):
//   base64 VP8-фрейм → VideoDecoder('vp8') → VideoFrame → <canvas>
//
// Почему не MediaCodec/JNI: MediaCodec требует ~400 строк unsafe-JNI и
// рантайм-пермишена через активность; WebCodecs — кросс-платформенный
// (desktop WebView тоже умеет), новый код в Rust не нужен.

import api from '../api.js';

// Параметры кодека — должны совпадать с Rust (video.rs):
// VP8, 640x480, 30fps, 500kbps, keyframe каждые 5с.
const VIDEO_WIDTH = 640;
const VIDEO_HEIGHT = 480;
const VIDEO_FPS = 30;
const VIDEO_BITRATE = 500_000;
const KEYFRAME_INTERVAL = 5; // секунд

let encoder = null;       // VideoEncoder (только Android/WebView-путь)
let mediaStream = null;   // MediaStream с камеры (только Android)
let frameTicker = null;   // цикл чтения кадров (MediaStreamTrackProcessor)
let decoding = false;     // guard: startCamera один раз на звонок
let activeCallId = null;  // звонок, чей Rust-writer открыт (для mediaCameraStop)
// Поколение захвата: stopCamera() его повышает. Старт, который «завис» на
// await (getUserMedia / mediaCameraStart), видит чужое поколение и
// прекращается, не трогая уже остановленные ресурсы: иначе старт камеры,
// завершившийся уже после отбоя, обращался к обнулённым полям
// (`null is not an object`), и звонок оставался без видео (frames=0).
let captureGen = 0;

/**
 * Захват камеры + кодирование VP8 → Rust.
 * Вызывается на media-connected (после того, как медиа-канал установился).
 *
 * @param {string} callId — звонок, в который уходят кадры
 * @param {object} [opts] — { localEl }: <video> для местного превью (mirror)
 */
export async function startCamera(callId, opts = {}) {
  if (decoding) return;
  decoding = true;
  const gen = ++captureGen;
  const stale = () => gen !== captureGen;

  // Десктоп (WebKitGTK): MediaStreamTrackProcessor отсутствует, а <video> из
  // MediaStream не декодируется вовсе — JS-путь кадров невозможен. Захват и
  // VP8-энкод делает Rust; здесь только открываем writer звонка (без него
  // Rust отбрасывает кадры с «camera not started for this call»).
  if (typeof MediaStreamTrackProcessor === 'undefined') {
    try {
      await api.mediaCameraStart(callId);
    } catch (e) {
      decoding = false;
      throw new Error('camera writer: ' + (e && e.message || e));
    }
    if (stale()) {
      api.mediaCameraStop(callId).catch(() => {});
      return;
    }
    activeCallId = callId;
    console.log('[video] capture in Rust (WebKitGTK: JS frames unavailable)');
    return;
  }

  try {
    // 1. Захват камеры. facingMode:'user' — фронталка для звонков.
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: VIDEO_WIDTH },
        height: { ideal: VIDEO_HEIGHT },
        facingMode: 'user',
      },
      audio: false, // аудио идёт своим путём (Oboe/cpal в Rust)
    });
  } catch (e) {
    decoding = false;
    // Нет камеры / нет пермишена — звонок остаётся аудио, не роняем.
    console.warn('[video] camera unavailable:', e && e.message || e);
    throw new Error('camera: ' + (e && e.message || e));
  }

  // За время getUserMedia звонок могли свернуть/завершить — тогда поток
  // нужно сразу погасить, иначе камера останется включённой без потребителя.
  if (stale()) {
    try { mediaStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    mediaStream = null;
    return;
  }

  // 1.5. Открыть Rust-писатель кадров ЭТОГО звонка (RTP-writer + видео-трек).
  // Без этого вызова `session.camera` в Rust = None, и КАЖДЫЙ кадр от
  // WebCodecs отбрасывается с «camera not started for this call»: видео не
  // уходило собеседнику ни на одной платформе (аудио идёт своим путём —
  // поэтому звук был, а картинки не было). Нативный capture Rust'а при этом
  // не нужен: на Android он недоступен, на desktop кадры даёт WebCodecs.
  try {
    await api.mediaCameraStart(callId);
    activeCallId = callId;
  } catch (e) {
    stopCamera();
    throw new Error('camera writer: ' + (e && e.message || e));
  }
  if (stale()) return;

  // Местное превью (опционально): caller видит себя.
  if (opts.localEl && mediaStream) {
    opts.localEl.srcObject = mediaStream;
    opts.localEl.muted = true;
    try { await opts.localEl.play(); } catch (e) { /* autoplay — не критично */ }
  }

  // 2. VP8-энкодер. Размер конфига — по фактическому кадру камеры.
  // «Идеальные» 640x480 из constraints не гарантированы: в портретной
  // ориентации трек отдаёт 480x640, и WebCodecs с конфигом 640x480 растянул
  // бы кадр по осям неравномерно (собеседник видел искажённые пропорции).
  const [track] = mediaStream.getVideoTracks();
  const trackSettings = (track && track.getSettings && track.getSettings()) || {};
  const even = (n) => Math.max(2, Number(n) - (Number(n) % 2));
  let encW = even(trackSettings.width || VIDEO_WIDTH);
  let encH = even(trackSettings.height || VIDEO_HEIGHT);
  let encoded = 0;
  try {
    encoder = new VideoEncoder({
      output: (chunk) => {
        // EncodedVideoChunk → байты → Rust (там E2E-шифр + RTP-пакетизация).
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        encoded++;
        // Первый кадр и далее раз в 100 — видно в логе, что камера реально
        // кодирует и кадры уходят в Rust (writer frames=0 больше не «молчит»).
        if (encoded === 1 || encoded % 100 === 0) {
          console.log('[video] encoded frames=' + encoded + ' bytes=' + chunk.byteLength);
        }
        // fire-and-forget: 30fps, ожидать ответ на каждый кадр = падение fps.
        api.mediaVideoFrame(callId, data).catch((e) => {
          console.warn('[video] frame send failed:', e);
        });
      },
      error: (e) => {
        console.error('[video] encoder error:', e);
      },
    });
  } catch (e) {
    // Нет WebCodecs-энкодера в движке — звонок остаётся аудио, ресурсы
    // (камера, Rust-writer) закрываем: иначе камера горит без потребителя.
    stopCamera();
    throw new Error('encoder: ' + (e && e.message || e));
  }

  try {
    encoder.configure({
      codec: 'vp8',
      width: encW,
      height: encH,
      bitrate: VIDEO_BITRATE,
      framerate: VIDEO_FPS,
      // Keyframe каждые KEYFRAME_INTERVAL*fps кадров — для устойчивости
      // к потере пакетов (NACK/PLI пока не реализованы, ключевой кадр
      // через 5с гарантирует восстановление картинки).
      keyInterval: KEYFRAME_INTERVAL * VIDEO_FPS,
    });
  } catch (e) {
    stopCamera();
    throw new Error('encoder configure: ' + (e && e.message || e));
  }

  // 3. Цикл кодирования (Android/WebView): кадр камеры → VideoFrame → encode.
  // Источник — MediaStreamTrackProcessor (Insertable Streams, Chrome 94+).
  // На десктопе сюда не доходим: WebKitGTK не имеет ни MSTP, ни кадров из
  // <video> — захват и энкод там в Rust (см. начало startCamera).
  const keyEvery = KEYFRAME_INTERVAL * VIDEO_FPS;

  const sendFrame = (frame, isKey) => {
    // Пропускаем лишние кадры, если энкодер отстаёт — лучше понизить fps,
    // чем копить задержку (как FRAME_CHANNEL_DEPTH=4 в Rust: drop > latency).
    if (!encoder || encoder.encodeQueueSize >= 2) {
      frame.close();
      return;
    }
    try {
      // Поворот устройства/смена разрешения: конфиг обязан следовать кадру,
      // иначе WebCodecs масштабирует его неравномерно. После перестройки
      // шлём ключевой кадр — декодер собеседника должен начать с нового
      // размера, а не тянуть старые delta-кадры.
      const fw = even(frame.displayWidth || frame.codedWidth || encW);
      const fh = even(frame.displayHeight || frame.codedHeight || encH);
      if (fw !== encW || fh !== encH) {
        try {
          encoder.configure({
            codec: 'vp8',
            width: fw,
            height: fh,
            bitrate: VIDEO_BITRATE,
            framerate: VIDEO_FPS,
            keyInterval: KEYFRAME_INTERVAL * VIDEO_FPS,
          });
          encW = fw;
          encH = fh;
          isKey = true;
        } catch (e) {
          console.warn('[video] encoder reconfigure failed:', e && e.message || e);
        }
      }
      encoder.encode(frame, { keyFrame: isKey });
    } finally {
      frame.close();
    }
  };

  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  frameTicker = (async () => {
    let frameNum = 0;
    try {
      while (true) {
        const { done, value: frame } = await reader.read();
        if (done) break;
        sendFrame(frame, frameNum % keyEvery === 0);
        frameNum++;
      }
    } catch (e) {
      console.warn('[video] capture loop ended:', e && e.message || e);
    }
  })();
}

/**
 * Остановить камеру и энкодер (hangup / camera off).
 */
export function stopCamera() {
  decoding = false;
  captureGen++; // любой незавершённый startCamera() теперь видит чужое поколение
  try { if (frameTicker) frameTicker.catch(() => {}); frameTicker = null; } catch (e) {}
  try { if (encoder) { encoder.flush().catch(() => {}); encoder.close(); } } catch (e) {}
  encoder = null;
  try {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {}
  mediaStream = null;
  // Закрыть Rust-писатель звонка: writer + RTP-трек (идемпотентно).
  if (activeCallId) {
    const cid = activeCallId;
    activeCallId = null;
    api.mediaCameraStop(cid).catch((e) => console.warn('[video] camera stop failed:', e));
  }
}

// ---------------------------------------------------------------------------
// Приём: base64 VP8-фреймы из Rust → VideoDecoder → canvas
// ---------------------------------------------------------------------------

let decoder = null;
let canvasCtx = null;
let remoteCanvasEl = null; // canvas для remote-видео (RGBA path)
// Монотонный микросекундный timestamp для WebCodecs VP8-пути (Android).
// performance.now() на быстрых кадрах даёт нестрого возрастающие значения —
// WebCodecs VideoDecoder это отвергает, поэтому держим свой счётчик с шагом кадра.
let vp8TsUs = 0;
const VP8_FRAME_US = Math.round(1_000_000 / VIDEO_FPS); // 33333 @ 30fps

/**
 * Запустить приём remote-видео: Rust-reader (media_video_start) шлёт
 * событие 'call-video-frame' — App.vue роутит кадры в decodeFrame.
 *
 * @param {string} callId
 * @param {HTMLCanvasElement} canvasEl — куда рисовать remote-кадры
 * @returns {boolean} true если декодер запущен
 */
export async function startRemoteVideo(callId, canvasEl) {
  if (decoder) return true;

  // Сохраняем canvas для RGBA path (Rust vp8_decoder шлёт RGBA, не VP8)
  remoteCanvasEl = canvasEl;
  if (canvasEl) {
    canvasEl.width = VIDEO_WIDTH;
    canvasEl.height = VIDEO_HEIGHT;
    canvasCtx = canvasEl.getContext('2d');
  }

  // WebCodecs нужен ТОЛЬКО для VP8-пути (Android: Rust шлёт VP8-битстрим).
  // На desktop кадры приходят готовым RGBA из Rust vp8_decoder, а WebKitGTK
  // VideoDecoder не имеет вовсе — ранний return по его отсутствию гасил
  // desktop-видео целиком (startCallVideo получал false и выключал videoOn).
  if (!('VideoDecoder' in window)) {
    console.log('[video] VideoDecoder unavailable — RGBA path (Rust decoder)');
    return true;
  }

  decoder = new VideoDecoder({
    output: (frame) => {
      drawFrame(canvasEl, frame);
      frame.close();
    },
    error: (e) => {
      console.error('[video] decoder error:', e);
    },
  });

  decoder.configure({
    codec: 'vp8',
    // Размер кадра приходит в EncodedVideoChunk (VP8 его несёт),
    // но canvas создаётся под ожидаемый размер — Rust шлёт 640x480.
    optimizeForLatency: true, // видеозвонок: задержка важнее качества
  });
  return true;
}

/**
 * Обработчик события 'call-video-frame'.
 *
 * Два формата от Rust (media.rs):
 *   - { rgba, width, height } — desktop: VP8 уже декодирован в Rust (libvpx).
 *   - { vp8 }                — Android: сырой VP8, декодируем здесь WebCodecs.
 */
export function decodeFrame(payload) {
  const p = payload || {};
  if (p.vp8) { decodeVp8Chunk(p.vp8); return; }
  if (p.rgba) decodeRgbaFrame(p.rgba, p.width, p.height);
}

function decodeVp8Chunk(base64Vp8) {
  if (!decoder || decoder.state !== 'configured') return;
  try {
    const raw = atob(base64Vp8);
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    // VP8 frame header: первый байт payload — frame_tag. Бит 0 (младший):
    //   0 = key frame, 1 = inter frame (delta).
    // WebCodecs VideoDecoder ТРЕБУЕТ чередования key→delta: поток обязан
    // начинаться с 'key', и 'delta' ссылается на предыдущий кадр. Прежний код
    // слал type:'key' на КАЖДЫЙ кадр — декодер VP8 на такой последовательности
    // либо падал с ошибкой, либо не отдавал кадры (баг: видео есть на десктопе
    // через RGBA-путь, на телефоне через этот VP8-путь — нет). Определяем
    // реальный тип по биту 0 VP8 frame_tag.
    const isKey = data.length > 0 && (data[0] & 0x01) === 0;
    // Монотонный timestamp: WebCodecs требует строго возрастающих значений.
    vp8TsUs += VP8_FRAME_US;
    decoder.decode(new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: vp8TsUs,
      duration: VP8_FRAME_US,
      data,
    }));
  } catch (e) {
    // Битый/пропущенный кадр — следующий key-frame восстановит поток.
  }
}

function drawFrame(canvasEl, frame) {
  if (!canvasEl) return;
  const fw = frame.displayWidth || VIDEO_WIDTH;
  const fh = frame.displayHeight || VIDEO_HEIGHT;
  if (!canvasCtx || canvasCtx.canvas !== canvasEl) {
    canvasCtx = canvasEl.getContext('2d');
  }
  // Размер кадра может смениться (поворот телефона) — canvas следует за ним,
  // иначе drawImage растянет кадр под старые пропорции.
  if (canvasEl.width !== fw || canvasEl.height !== fh) {
    canvasEl.width = fw;
    canvasEl.height = fh;
  }
  canvasCtx.drawImage(frame, 0, 0, canvasEl.width, canvasEl.height);
}

/**
 * Остановить приём remote-видео (hangup).
 */
export function stopRemoteVideo() {
  try { if (decoder) { decoder.flush().catch(() => {}); decoder.close(); } } catch (e) {}
  decoder = null;
  vp8TsUs = 0; // новый звонок/повторный старт — с чистого счётчика timestamp
  // Очищаем canvas: убираем последний кадр (чёрный экран), иначе
  // при hangup остаётся «замёрзшее» видео.
  if (canvasCtx && canvasCtx.canvas) {
    canvasCtx.clearRect(0, 0, canvasCtx.canvas.width, canvasCtx.canvas.height);
  }
  canvasCtx = null;
}

/**
 * Отрисовать готовый RGBA-кадр (desktop: Rust vp8_decoder декодировал VP8).
 */
function decodeRgbaFrame(base64Rgba, width, height) {
  if (!canvasCtx || !canvasCtx.canvas) return;
  try {
    // base64 → Uint8Array → ImageData → canvas
    const raw = atob(base64Rgba);
    const data = new Uint8ClampedArray(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    const imageData = new ImageData(data, width, height);
    // Canvas подстраивается под фактический размер кадра: putImageData
    // пишет пиксели 1:1, и при другом размере кадра (портретная камера
    // собеседника) картинка обрезалась бы, а CSS растянул бы остаток.
    const canvasEl = canvasCtx.canvas;
    if (canvasEl.width !== width || canvasEl.height !== height) {
      canvasEl.width = width;
      canvasEl.height = height;
    }
    canvasCtx.putImageData(imageData, 0, 0);
  } catch (e) {
    // Потерянный/битый кадр — пропускаем, следующий всё исправит.
  }
}
