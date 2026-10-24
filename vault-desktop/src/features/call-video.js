// Feature module: видео в звонке (переключение, старт/стоп потоков).
//
// ADR-005 W3 (`t_b1bdbb99`), партия 1: логика видео уехала из App.vue в фичу,
// App.vue — только делегаты. Состояние звонка — у владельца call-session
// (callVideoOn/callMediaConnected/currentCall), сам видео-движок — в
// features/video.js, тосты — у владельца форм (uiStore).
//
// ДВА ЭФФЕКТА ОСТАЮТСЯ В КОМПОНЕНТЕ (их не знает модуль):
//   nextTick()        — после смены флага v-if рендерит canvas;
//   getRemoteCanvas() — <canvas> из оверлея звонка ($refs.callOverlay).
import api from '../api.js';
import * as Video from './video.js';
import { uiStore } from './session-store.js';
import { callSession } from './call-session.js';

// Переключатель видео: включить/выключить. Без активного звонка или без
// подключённого медиа — ничего (как раньше в App.vue).
export function toggleCallVideo(deps) {
  if (!callSession.state.currentCall || !callSession.state.callMediaConnected) return;
  if (callSession.state.callVideoOn) stopCallVideo(deps);
  else startCallVideo(deps);
}

// Старт видео: сначала поднимаем флаг (canvas рендерится по v-if=videoOn),
// и только когда DOM готов — стартуем remote-декодер.
//
// Гейт экспериментальной возможности: без включённого тумблера видео не
// поднимается НИКАКИМ путём — ни кнопкой, ни auto-start при чужих кадрах
// (иначе собеседник с включённым тумблером включал бы видео собеседнику,
// который его выключал).
export async function startCallVideo(deps) {
  const c = callSession.state.currentCall;
  if (!c || callSession.state.callVideoOn) return;
  if (!deps.expVideo()) return;
  const cid = c.call_id;
  callSession.state.callVideoOn = true;
  await deps.nextTick();
  const canvasEl = deps.getRemoteCanvas();
  try {
    const ok = await Video.startRemoteVideo(cid, canvasEl);
    if (!ok) {
      callSession.state.callVideoOn = false;
      uiStore.toast(uiStore.tr('video_unavailable') || 'Видео недоступно в этом WebView', 3000);
      return;
    }
    await api.mediaVideoStart(cid);
  } catch (e) {
    console.error('[video] remote start failed:', e);
    callSession.state.callVideoOn = false;
    Video.stopRemoteVideo();
    uiStore.toast(uiStore.tr('video_start_failed') || 'Не удалось включить видео', 3000);
    return;
  }
  // Локальная камера: кадры → Rust → собеседник (превью нет — air).
  try {
    await Video.startCamera(cid);
  } catch (e) {
    // Камера недоступна/отказала — remote-видео собеседника всё равно
    // работает; переключатель остается «вкл», звонок не роняем.
    console.warn('[video] camera unavailable, remote-only:', e && e.message || e);
    uiStore.toast(uiStore.tr('video_camera_off') || 'Камера недоступна — видно только собеседника', 3000);
  }
}

// Стоп видео: камера, декодер, флаг и команда медиа-каналу.
// Идемпотентно: если видео не было включено — ничего не делаем (иначе
// повторный вызов после «звонок окончен» слал бы лишний mediaVideoStop).
export function stopCallVideo(deps) {
  const c = callSession.state.currentCall;
  if (!c || !callSession.state.callVideoOn) return;
  Video.stopCamera();
  Video.stopRemoteVideo();
  callSession.state.callVideoOn = false;
  api.mediaVideoStop(c.call_id).catch((e) => console.warn('[video] stop failed:', e));
}

// Кадр от собеседника → декодер (вызывается из слушателя Tauri-события).
export function decodeFrame(payload) {
  Video.decodeFrame(payload);
}

// Гасить видеотракт при размонтировании компонента: камера и remote-декодер
// не должны пережить UI (иначе энкодер держит камеру после закрытия окна).
export function stopVideoTracks() {
  Video.stopCamera();
  Video.stopRemoteVideo();
}
