// Feature module: видеозвонки (M3, шаг 3/3) — WebView-сторона.
//
// WebRTC живёт в Rust (webrtc-rs): JS обменивается SDP-строками через
// media_start_outgoing/accept_incoming/set_remote. Кадры камер туда не
// попадают — нет RTCPeerConnection в JS. Поэтому видео идёт тем же путём,
// что и аудио: кадры → Rust → E2E-шифр → RTP-трек.
//
// Захват и кодирование — WebCodecs в WebView (Chrome 151 на Android):
//   getUserMedia({video}) → VideoFrame → VideoEncoder('vp8')
//   → invoke('media_video_frame', ...) → write_video_loop (Rust)
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

let encoder = null;       // VideoEncoder
let mediaStream = null;   // MediaStream с камеры
let frameTicker = null;   // requestVideoFrameCallback-цикл
let decoding = false;     // guard: startCamera один раз на звонок
let activeCallId = null;  // звонок, чей Rust-writer открыт (для mediaCameraStop)
let videoEl = null;       // <video> камеры — источник VideoFrame (desktop-путь)
let frameCbId = null;     // requestVideoFrameCallback-id
let frameTimer = null;    // setInterval-id (fallback, если нет rVFC)

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

  // Местное превью (опционально): caller видит себя.
  if (opts.localEl && mediaStream) {
    opts.localEl.srcObject = mediaStream;
    opts.localEl.muted = true;
    try { await opts.localEl.play(); } catch (e) { /* autoplay — не критично */ }
  }

  // 2. VP8-энкодер. WebCodecs требует явного конфига — совпадает с Rust.
  encoder = new VideoEncoder({
    output: (chunk) => {
      // EncodedVideoChunk → байты → Rust (там E2E-шифр + RTP-пакетизация).
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      // fire-and-forget: 30fps, ожидать ответ на каждый кадр = падение fps.
      api.mediaVideoFrame(callId, data).catch((e) => {
        console.warn('[video] frame send failed:', e);
      });
    },
    error: (e) => {
      console.error('[video] encoder error:', e);
    },
  });

  encoder.configure({
    codec: 'vp8',
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    bitrate: VIDEO_BITRATE,
    framerate: VIDEO_FPS,
    // Keyframe каждые KEYFRAME_INTERVAL*fps кадров — для устойчивости
    // к потере пакетов (NACK/PLI пока не реализованы, ключевой кадр
    // через 5с гарантирует восстановление картинки).
    keyInterval: KEYFRAME_INTERVAL * VIDEO_FPS,
  });

  // 3. Цикл кодирования: кадр камеры → VideoFrame → encode.
  // Источник кадров зависит от движка (проверено зондом на живых движках):
  //  - Android WebView (Chrome): MediaStreamTrackProcessor (Insertable Streams);
  //  - desktop WebKitGTK: его НЕТ (VideoFrame/VideoEncoder/VideoDecoder есть,
  //    MediaStreamTrackProcessor отсутствует) → берём <video> с камерой и
  //    `new VideoFrame(videoEl)`, кадры читает requestVideoFrameCallback.
  const [track] = mediaStream.getVideoTracks();
  const keyEvery = KEYFRAME_INTERVAL * VIDEO_FPS;

  const sendFrame = (frame, isKey) => {
    // Пропускаем лишние кадры, если энкодер отстаёт — лучше понизить fps,
    // чем копить задержку (как FRAME_CHANNEL_DEPTH=4 в Rust: drop > latency).
    if (!encoder || encoder.encodeQueueSize >= 2) {
      frame.close();
      return;
    }
    try {
      encoder.encode(frame, { keyFrame: isKey });
    } finally {
      frame.close();
    }
  };

  if (typeof MediaStreamTrackProcessor !== 'undefined' && track) {
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
  } else {
    // desktop-путь: <video> вне экрана (display:none останавливает декод).
    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:240px;';
    videoEl.srcObject = mediaStream;
    document.body.appendChild(videoEl);
    try { await videoEl.play(); } catch (e) { /* autoplay — не критично */ }

    let frameNum = 0;
    const tick = () => {
      if (!encoder || !videoEl) return;
      // readyState < 2 — кадр ещё не декодирован: VideoFrame бросит.
      if (videoEl.readyState < 2) return;
      try {
        const frame = new VideoFrame(videoEl, {
          timestamp: Math.round(performance.now() * 1000),
        });
        sendFrame(frame, frameNum % keyEvery === 0);
        frameNum++;
      } catch (e) {
        // Кадр не готов/размер меняется — пропускаем тик, не роняем звонок.
      }
    };
    if (typeof videoEl.requestVideoFrameCallback === 'function') {
      const pump = () => {
        tick();
        frameCbId = videoEl ? videoEl.requestVideoFrameCallback(pump) : null;
      };
      frameCbId = videoEl.requestVideoFrameCallback(pump);
    } else {
      frameTimer = setInterval(tick, Math.round(1000 / VIDEO_FPS));
    }
    frameTicker = Promise.resolve();
    console.log('[video] desktop capture path: <video> + VideoFrame (no MediaStreamTrackProcessor)');
  }
}

/**
 * Остановить камеру и энкодер (hangup / camera off).
 */
export function stopCamera() {
  decoding = false;
  try { if (frameTicker) frameTicker.catch(() => {}); frameTicker = null; } catch (e) {}
  if (frameCbId != null && videoEl && typeof videoEl.cancelVideoFrameCallback === 'function') {
    try { videoEl.cancelVideoFrameCallback(frameCbId); } catch (e) {}
  }
  frameCbId = null;
  try { if (frameTimer) clearInterval(frameTimer); } catch (e) {}
  frameTimer = null;
  try { if (encoder) { encoder.flush().catch(() => {}); encoder.close(); } } catch (e) {}
  encoder = null;
  try {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {}
  mediaStream = null;
  try {
    if (videoEl) {
      videoEl.srcObject = null;
      videoEl.remove();
    }
  } catch (e) {}
  videoEl = null;
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
    decoder.decode(new EncodedVideoChunk({
      type: 'key',
      timestamp: performance.now() * 1000,
      data,
    }));
  } catch (e) {
    // Битый/пропущенный кадр — следующий key-frame восстановит поток.
  }
}

function drawFrame(canvasEl, frame) {
  if (!canvasEl) return;
  if (!canvasCtx || canvasCtx.canvas !== canvasEl) {
    canvasEl.width = frame.displayWidth || VIDEO_WIDTH;
    canvasEl.height = frame.displayHeight || VIDEO_HEIGHT;
    canvasCtx = canvasEl.getContext('2d');
  }
  canvasCtx.drawImage(frame, 0, 0, canvasEl.width, canvasEl.height);
}

/**
 * Остановить приём remote-видео (hangup).
 */
export function stopRemoteVideo() {
  try { if (decoder) { decoder.flush().catch(() => {}); decoder.close(); } } catch (e) {}
  decoder = null;
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
    canvasCtx.putImageData(imageData, 0, 0);
  } catch (e) {
    // Потерянный/битый кадр — пропускаем, следующий всё исправит.
  }
}
