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

  // 3. Цикл кодирования: track → VideoFrame → encode.
  const [track] = mediaStream.getVideoTracks();
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();

  frameTicker = (async () => {
    let frameNum = 0;
    try {
      while (true) {
        const { done, value: frame } = await reader.read();
        if (done) break;
        // Пропускаем лишние кадры, если энкодер отстаёт — лучше
        // понизить fps, чем копить задержку (как FRAME_CHANNEL_DEPTH=4
        // в Rust: drop frame > latency).
        if (encoder.encodeQueueSize >= 2) {
          frame.close();
          continue;
        }
        encoder.encode(frame, { keyFrame: frameNum % (KEYFRAME_INTERVAL * VIDEO_FPS) === 0 });
        frame.close();
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
  try { if (frameTicker) frameTicker.catch(() => {}); frameTicker = null; } catch (e) {}
  try { if (encoder) { encoder.flush().catch(() => {}); encoder.close(); } } catch (e) {}
  encoder = null;
  try {
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
    }
  } catch (e) {}
  mediaStream = null;
}

// ---------------------------------------------------------------------------
// Приём: base64 VP8-фреймы из Rust → VideoDecoder → canvas
// ---------------------------------------------------------------------------

let decoder = null;
let canvasCtx = null;

/**
 * Запустить приём remote-видео: Rust-reader (media_video_start) шлёт
 * событие 'call-video-frame' — App.vue роутит кадры в decodeFrame.
 *
 * @param {string} callId
 * @param {HTMLCanvasElement} canvasEl — куда рисовать remote-кадры
 * @returns {boolean} true если декодер запущен
 */
export async function startRemoteVideo(callId, canvasEl) {
  if (!('VideoDecoder' in window)) {
    console.warn('[video] VideoDecoder unavailable — no remote video');
    return false;
  }
  if (decoder) return true;

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
  canvasCtx = null;
}

/**
 * Декодировать один base64-кадр (обработчик события call-video-frame).
 * VP8-фрейм из Rust уже депакетизирован и расшифрован (E2E).
 */
export function decodeFrame(base64Frame, timestamp) {
  if (!decoder) return;
  try {
    // base64 → байты. STANDARD (не url-safe) — Rust кодирует general_purpose::STANDARD.
    // atob бросает InvalidCharacterError на битом кадре — вся обёртка под try,
    // иначе один мусорный пакет роняет listener звонка (App.vue зовёт без catch).
    const raw = atob(base64Frame);
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);

    const chunk = new EncodedVideoChunk({
      type: 'delta', // VP8-депакетизатор не различает key/delta в payload —
                     // декодер сам определит по битстриму
      timestamp: timestamp || 0,
      duration: Math.round(1_000_000 / VIDEO_FPS),
      data,
    });
    decoder.decode(chunk);
  } catch (e) {
    // Потерянный/битый кадр — пропускаем, следующий keyframe всё исправит.
  }
}
