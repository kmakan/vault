// Feature module: звонки (сигнализация конвертами call_* + state machine).
// Этап 5 декомпозиции App.vue — изоляция фич-доменов (ctx-паттерн).
//
// Срезы домена:
//  - дедуп: isCallSeen/rememberCallSeen (persist kv 'call-seen', 100 id);
//  - сигнализация: parseCallSignal, sendCallEnvelope (релей+SMTP-дубль,
//    ретраи 3×3с в фоне), handleCallSignal (router входящих сигналов);
//  - lifecycle: startCall/acceptCall/rejectCall/endCall/cancelCall/hangup;
//  - пилюли: recordCallEvent, callEventLabel, callPillIcon, canCallBack;
//  - ретрансляция: startSignalResend/stopSignalResend/sendTerminalRepeat;
//  - watchdog: armMediaFallback («Соединение…» 90с), часы разговора;
//  - звук: playCallSound/stopCallSound (Android HTML5 / desktop cpal).
//
// Инвариант: ошибки канала НЕ роняют state machine — релей-копия уходит
// первой (~1с), SMTP-письмо — фоновый дублирующий канал с ретраями.

import api, { db } from '../api.js';
import * as relay from '../relay-client.js';
import crypto from '../crypto.js';
import { saveHistory, loadHistory } from '../history.js';

// ── Дедуп звонков (persist kv 'call-seen') ─────────────────────
// call_id обработанного звонка (request/accept/end/reject). После
// перезапуска не даёт старым конвертам снова дёргать state machine.
export async function isCallSeen(ctx, callId) {
  try {
    const raw = await db.kvGet(ctx.email || 'anon', 'call-seen');
    const set = raw ? new Set(JSON.parse(raw)) : new Set();
    return set.has(callId);
  } catch (e) { return false; }
}

export async function rememberCallSeen(ctx, callId) {
  try {
    const raw = await db.kvGet(ctx.email || 'anon', 'call-seen');
    const set = raw ? new Set(JSON.parse(raw)) : new Set();
    set.add(callId);
    // Храним последние 100 call_id (старые не нужны)
    if (set.size > 100) {
      const arr = Array.from(set);
      arr.splice(0, arr.length - 100);
      await db.kvSet(ctx.email || 'anon', 'call-seen', JSON.stringify(arr));
    } else {
      await db.kvSet(ctx.email || 'anon', 'call-seen', JSON.stringify(Array.from(set)));
    }
  } catch (e) { /* тихо */ }
}

// ── Сигнализация ───────────────────────────────────────────────
// Распознавание сигнального конверта: {vault:1, type:'call_*', call_id,...}.
// Такие письма НЕ рендерятся сообщениями (как квитанции) — уходят в
// state machine звонка. Медиа (webrtc-rs) подключается в Фазе 2.
export function parseCallSignal(decrypted) {
  if (!decrypted || typeof decrypted !== 'string') return null;
  try {
    const obj = JSON.parse(decrypted);
    if (obj && obj.vault === 1 && typeof obj.type === 'string'
        && obj.type.indexOf('call_') === 0 && obj.call_id) {
      return obj;
    }
  } catch (e) { /* не сигнал */ }
  return null;
}

// Отправка сигнала звонка (stealth-письмо с пустой темой — как квитанции).
export async function sendCallEnvelope(ctx, peer, payload, opts = {}) {
  const body = {
    vault: 1,
    id: payload.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)),
    type: payload.type,
    call_id: payload.call_id,
    ts: Date.now(),
    ...(payload.sdp ? { sdp: payload.sdp } : {}),
    ...(payload.role ? { role: payload.role } : {}),
    // PQ: kemct звонящего едет в call_request; принимающий
    // собирает гибридный media_key декапсуляцией. sender_ek — чтобы
    // contact сохранялся и для ответного гибрида.
    ...(payload.kemct ? { kemct: payload.kemct } : {}),
    ...(payload.sender_ek ? { sender_ek: payload.sender_ek } : {}),
  };
  const content = await crypto.encryptVault(JSON.stringify(body));
  // M2.2: дублируем сигнал звонка на релей (критично для скорости
  // установления: email-сигнал идёт 20-60с, релей ~1с). Получатель
  // заберёт его relayConsume'ом (parseCallSignal работает и на
  // relay-конвертах — тот же зашифрованный wire-формат). Дедуп по
  // call_id (isCallSeen) — дубль через email безопасен.
  //
  // ntfy wake-семантика (fix 09.09): будим пушем ТОЛЬКО call_request —
  // остальные сигналы (accept/answer/end/reject) адресат получает,
  // когда уже активен на звонке, и каждый ntfy-wake рисовал лишнее
  // «Новое сообщение» ПОСЛЕ принятия/завершения звонка.
  // viaRelay=false — ретранслируем ТОЛЬКО почтой (call_request
  // повторяется каждые 15с: релей-копия уже лежит в очереди, повтор
  // жёг суточный лимит издателя и плодил дубль-пуши).
  const viaRelay = opts.viaRelay !== false;
  const wake = payload.type === 'call_request';
  if (viaRelay) {
    try {
      relay.relayPublish(ctx.email, peer, { id: body.id }, content, { wake });
    } catch (e) { /* релей опционален — email путь живёт */ }
  }
  // Релей-копия уже ушла выше (не блокирует). SMTP-письмо — медленный
  // дублирующий канал: НЕ ждём его завершения, чтобы не блокировать
  // звонковую state machine (раньше accept-цепочка могла ждать до
  // 3×3с ретраев, а при зависшем Gmail — минуту). Ретраи оставляем
  // внутри фоновой задачи.
  (async () => {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        await api.sendReadReceipt(peer, content); // stealth: пустая тема
        if (i > 0) console.log('[call] envelope sent on retry', i);
        return;
      } catch (e) {
        lastErr = e;
        console.warn(`[call] envelope send attempt ${i + 1}/3 failed:`, e && e.message || e);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    console.error('[call] SMTP envelope failed after retries:', lastErr && lastErr.message);
  })();
  // SMTP ушёл в фон — ошибки канала не роняют звонок (релей-копия уже
  // доставлена; письмо — догоняющий дубль). Больше не бросаем lastErr.
}

// Входящий сигнал → state machine. MVP: один звонок одновременно.
export async function handleCallSignal(ctx, sig, from) {
  const { call_id, type } = sig;
  if (!call_id || !from) return;
  // Ignore-лист: звонки заблокированного гасятся до state machine —
  // ни рингтона, ни оверлея, ни «пропущенного» в истории.
  if (ctx.isIgnored(from)) return;
  console.log('[call] signal', type, call_id, 'from', from, 'state=' + ctx.callState,
    'current=' + (ctx.currentCall ? ctx.currentCall.call_id : 'null'));
  // после перезапуска приложение
  // заново сканирует Спам, и старые call_* письма (прошлых сессий) снова
  // попадают в processIncoming. Без этой защиты «зомби-звонок» вешал
  // state machine в incoming_ringing, и НОВЫЙ звонок, пришедший в это
  // время, молча отбрасывался (callState !== 'idle') — вызовы пропадали.
  // Звонок живёт ≤45с (ring-таймер) + запас на доставку почты и на вход
  // в аккаунт после перезапуска окна (пользователь мог перезапустить
  // окно, и собеседник залогинился позже звонка) — конверты старше 10
  // минут неактуальны — игнорируем (и запоминаем call_id).
  if (sig.ts && Date.now() - sig.ts > 600000) {
    console.log('[call] stale envelope ignored', call_id, type, 'age_ms=' + (Date.now() - sig.ts));
    const alreadySeen = await isCallSeen(ctx, call_id);
    await rememberCallSeen(ctx, call_id);
    // Пропущенные вызовы: звонок пришёл, пока нас не было
    // (офлайн/перезапуск) — записываем «Пропущенный звонок» в историю
    // чата. Только при ПЕРВОМ появлении call_id (alreadySeen=false) —
    // иначе повторный фетч Спада после рестарта плодил дубли пилюль.
    if (type === 'call_request' && !alreadySeen) {
      await recordCallEvent(ctx, from, 'missed', sig.ts, 0, call_id);
    }
    return;
  }
  // ДЕДУП + ПОВТОРНЫЙ ПОКАЗ: call_id уже показанного звонка
  // из повторного фетча гасится — НО только если звонок ещё «жив» в системе
  // (not cancelled). Ретрансляция call_request (каждые 15с) того же call_id
  // после ЛОКАЛЬНОГО отклонения обязана СНОВА поднять экран звонка? НЕТ:
  // юзер уже решил судьбу звонка — гасим. А вот РЕТРАНСЛЯЦИИ ДО отклонения
  // дедупятся через currentCall check (4800) — они безопасны.
  // Зомби-гвард: терминальные cancel/end/reject запоминаются
  // request, приехавший ПОЗЖЕ своего cancel, гасится здесь.
  if (type === 'call_request' && !(ctx.currentCall && ctx.currentCall.call_id === call_id)) {
    if (await isCallSeen(ctx, call_id)) return;
    await rememberCallSeen(ctx, call_id);
  }
  // Чужой звонок во время активного — отвечаем занято (call_reject).
  if (ctx.callState !== 'idle' && ctx.currentCall
      && ctx.currentCall.call_id !== call_id && type === 'call_request') {
    await sendCallEnvelope(ctx, from, { type: 'call_reject', call_id });
    // Пропущенные вызовы: мы говорили по другому звонку
    await recordCallEvent(ctx, from, 'missed', sig.ts, 0, call_id);
    return;
  }
  switch (type) {
    case 'call_request': {
      // РЕТРАНСЛЯЦИЯ: звонящий повторяет call_request каждые 15с
      // (письма теряются в транзите). Если тот же call_id УЖЕ звонит у
      // нас — это дубль: игнорируем.
      if (ctx.currentCall && ctx.currentCall.call_id === call_id) return;
      // ГАРАНТИЯ ПОКАЗА: НОВЫЙ call_request ВСЕГДА вытесняет любое
      // состояние, кроме реального разговора (active) — даже если state
      // machine зависла в ringing от старого конверта без currentCall.
      if (ctx.callState !== 'idle' && ctx.callState !== 'active') {
        console.warn('[call] forcing reset before new request (state=' + ctx.callState + ')');
        await hangup(ctx, 'preempt');
      }
      if (ctx.callState !== 'idle') return;
      // OFFER В call_request: звонящий создаёт offer ДО набора
      // он едет в первом письме. Сохраняем: при accept сразу создадим
      // answer (1 hop вместо 2). Если sdp нет (старая версия/fallback) —
      // acceptCall создаст offer сам (старая схема).
      ctx.currentCall = {
        call_id, peer: from, offerSdp: sig.sdp || null,
        // PQ: kemct звонящего — в mediaAcceptIncoming при accept.
        kemct: sig.kemct || null, senderEk: sig.sender_ek || null,
      };
      ctx.lastCallId = call_id;
      ctx.callState = 'incoming_ringing';
      ctx.callMuted = false;
      ctx.callStartedAt = Date.now();
      console.log('[call] incoming_ringing SET for', call_id, 'from', from);
      // Звук входящего: WAV-рингтон «кристальный чайм».
      // Desktop — cpal в Rust (слышен при свёрнутом окне).
      // Android: рингтон играет НАТИВНЫЙ MediaPlayer в сервисе
      // (запускается в mediaShowIncomingCall) — HTML5 Audio в WebView
      // глохнет в фоне и играл ОДИН раз. Поэтому HTML5-луп входящего
      // на Android пропускаем, чтобы не было двойного звука.
      if (!ctx.isAndroid) {
        playCallSound(ctx, 'incoming', true);
      }
      // Full-screen уведомление: Android — системный звонок
      // поверх локскрина (рингтон+вибрация канала уведомлений).
      // Desktop — no-op. Снимается в hangup().
      api.mediaShowIncomingCall(ctx.callPeerName || from);
      startFastPolling(ctx);
      // Таймер гудка 180с: было 90с, но call_accept/answer по
      // почте могут идти дольше (SMTP+доставка+IMAP), звонок «сгорал» до
      // того, как собеседник успевал ответить.
      ctx.callRingTimer = setTimeout(() => cancelCall(ctx, 'timeout'), 180000);
      break;
    }
    case 'call_accept': {
      if (ctx.currentCall && ctx.currentCall.call_id === call_id
          && ctx.callState === 'outgoing_ringing') {
        // Собеседник принял — таймер отмены больше не нужен.
        clearTimeout(ctx.callRingTimer);
        ctx.callRingTimer = null;
        if (ctx.callResendTimer) {
          clearInterval(ctx.callResendTimer);
          ctx.callResendTimer = null;
        }
        // Гудки исходящего → чайм соединения. stop не нужен
        // play сам останавливает предыдущий звук (Rust/HTML5).
        playCallSound(ctx, 'connect', false);
        ctx.callState = 'active';
        // Таймер НЕ запускаем: ждём событие call-media-connected
        // из Rust (реальный звук). Предохранитель 120с — если событие
        // потерялось, показываем таймер хоть когда-нибудь.
        ctx.callMediaConnected = false;
        armMediaFallback(ctx);
        // OFFER В call_request: если мы создали offer при наборе
        // (hasLocalOffer) — sdp в call_accept это ANSWER: ставим remote,
        // DTLS-SRTP устанавливается. Fallback (старая схема): sdp это
        // offer принимающего — принимаем его и шлём answer.
        if (sig.sdp) {
          if (ctx.currentCall && ctx.currentCall.hasLocalOffer) {
            try {
              await api.mediaSetRemote(call_id, sig.sdp);
              console.log('[call] remote answer set — DTLS handshake should follow');
            } catch (e) {
              console.error('[call] media set remote (answer) failed:', e && e.message || e);
            }
          } else {
            try {
              const r = await api.mediaAcceptIncoming(call_id, sig.sdp, ctx.peerKeys[from] || '', sig.kemct || null, true);
              console.log('[call] callee offer accepted, answer created,', (r.sdp || '').length, 'bytes');
              const answerPayload = { type: 'call_sdp', call_id, sdp: r.sdp, role: 'answer' };
              await sendCallEnvelope(ctx, from, answerPayload);
              console.log('[call] answer sent OK — waiting for DTLS');
              // Ретрансляция answer: если письмо потеряется
              // принимающий зависнет в «Соединение…». Повторяем каждые
              // 10с до соединения медиа.
              startSignalResend(ctx, from, answerPayload, call_id);
            } catch (e) {
              console.error('[call] media accept failed:', e && e.message || e);
            }
          }
        }
      }
      break;
    }
    case 'call_reject':
    case 'call_end':
    case 'call_cancel': {
      // call_cancel — собеседник отменил/завершил звонок (или у него
      // сработал таймаут): кладём трубку автоматически.
      // Гонка: пользователь мог уже повесить трубку вручную
      // (state=idle) до того, как call_end дошёл — проверяем и по
      // lastCallId, чтобы не оставить трубку у собеседника.
      if (ctx.currentCall && ctx.currentCall.call_id === call_id) {
        // remote_reject — отдельно от remote: звонящий увидит
        // «Вызов отклонён», а не «Нет ответа».
        hangup(ctx, type === 'call_reject' ? 'remote_reject' : 'remote');
      } else if (ctx.lastCallId === call_id && ctx.callState === 'idle') {
        console.log('[call] remote end after local hangup — ensuring cleanup');
        hangup(ctx, 'remote_late');
      }
      // ЗАПОМНИТЬ ТЕРМИНАЛЬНЫЙ call_id ВСЕГДА
      // доставки (INBOX/All Mail/Спам — разные копии, порядок не
      // гарантирован). Без помни later call_request поднимал звонок,
      // которого уже нет (запомненные терминалы гасят его в guard
      // isCallSeen ниже). Свежие cancel не попадали в stale-ветку —
      // потому и не запоминались.
      await rememberCallSeen(ctx, call_id);
      if (ctx.lastCallId !== call_id) ctx.lastCallId = call_id;
      break;
    }
    case 'call_sdp': {
      // Фаза 2: SDP-обмен после call_accept. offer — сторона получателя
      // (создаёт answer и шлёт обратно), answer — сторона звонящего
      // (завершает handshake, DTLS-SRTP устанавливается).
      console.log('[call] sdp received', call_id, 'role=' + sig.role, 'state=' + ctx.callState);
      if (!ctx.currentCall || ctx.currentCall.call_id !== call_id
          || ctx.callState !== 'active') {
        console.warn('[call] sdp DROPPED by guard:', call_id, 'role=' + sig.role,
            'state=' + ctx.callState, 'current=' + (ctx.currentCall && ctx.currentCall.call_id));
        break;
      }
      if (sig.role === 'answer') {
        // Фаза 2.3 (схема: offer от принимающего): звонящий получает ANSWER от принимающего
        // и завершает handshake (DTLS-SRTP).
        try {
          await api.mediaSetRemote(call_id, sig.sdp);
          console.log('[call] remote answer set — DTLS handshake should follow');
        } catch (e) {
          console.error('[call] media set remote failed:', e);
        }
      }
      break;
    }
    default:
      break;
  }
}

// ── Lifecycle ──────────────────────────────────────────────────
// Кнопка «Позвонить» в шапке чата (1:1, есть ключ собеседника).
export async function startCall(ctx) {
  const peer = ctx.activeChat;
  if (!peer || peer === '__notes__' || ctx.activeChatType !== 'chat') return;
  if (ctx.callState !== 'idle' || !ctx.peerKeys[peer]) return;
  const call_id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  ctx.currentCall = { call_id, peer };
  ctx.lastCallId = call_id;
  ctx.callState = 'outgoing_ringing';
  ctx.callMuted = false;
  startFastPolling(ctx);
  // для call_accept может превысить 180с, и звонок сгорал до ответа;
  // окончательно решает call_reject/call_cancel от собеседника).
  ctx.callRingTimer = setTimeout(() => cancelCall(ctx, 'timeout'), 300000);
  // ВАЖНО: сигнал call_request отправляем ДО гудков. cpal-гудок
  // может зависнуть на enum аудио-устройств (глючный Bluetooth) и
  // заблокировать рантайм — если бы он стоял перед отправкой, сигнал не
  // call_cancel при hangup проходил). Сначала сигнал, потом звук
  // (запустится на ~1с позже — некритично).
  //
  // OFFER В call_request: классическая схема
  // WebRTC — offer звонящего едет в ПЕРВОМ письме.
  // почтовых hops (call_request → accept+offer → answer), после свайпа
  // принять до звука проходило 2 hops (20-60с). Теперь после accept
  // Offer создаётся
  // ДО отправки (ICE gathering ~4с); если не получится — fallback на
  // старую схему (offer принимающего внутри call_accept).
  let offerSdp = null;
  try {
    const r = await api.mediaStartOutgoing(call_id, ctx.peerKeys[peer] || '', (ctx.peerPqKeys && ctx.peerPqKeys[peer]) || null, true);
    offerSdp = r.sdp;
    // PQ: kemct из SdpResult — поедет в call_request-конверте
    // принимающий передаст в mediaAcceptIncoming для гибридного ключа.
    if (r.kemct) ctx._pendingKemct = r.kemct;
    if (r.sender_ek) ctx._pendingSenderEk = r.sender_ek;
    console.log('[call] offer created at dial time,', (offerSdp || '').length, 'bytes');
  } catch (e) {
    console.error('[call] offer at dial failed (fallback callee-offer):', e);
  }
  // Флаг для обработки call_accept: если offer создан здесь
  // sdp в call_accept это ANSWER; иначе (fallback) — offer принимающего.
  ctx.currentCall.hasLocalOffer = !!offerSdp;
  // ГУДКИ СРАЗУ: раньше ждали SMTP-отправки call_request (Gmail
  // держит коннект до минуты, ретраи ×3 с паузами) — звонящий сидел
  // в тишине и не понимал, идёт ли звонок. Релей-копия уходит за ~1с
  // (relayPublish в sendCallEnvelope не блокирует), SMTP-письмо —
  // медленный дублирующий канал, пусть идёт в фоне.
  playCallSound(ctx, 'outgoing', true);
  try {
    // PQ: kemct/sender_ek из mediaStartOutgoing → в конверт.
    await sendCallEnvelope(ctx, peer, {
      type: 'call_request', call_id, sdp: offerSdp,
      kemct: ctx._pendingKemct || undefined,
      sender_ek: ctx._pendingSenderEk || undefined,
    });
    ctx._pendingKemct = null; ctx._pendingSenderEk = null;
  } catch (e) {
    console.error('call_request failed:', e);
    hangup(ctx, 'error');
    return;
  }
  // (Гудки исходящего уже запущены ДО отправки — см. выше; сюда
  // попадаем только когда сигналы ушли/идут в фоне.)
  // РЕТРАНСЛЯЦИЯ: email-сигнал может потеряться в транзите
  // (SMTP принял без ошибки, но письмо не дошло до Gmail — наблюдали
  // Повторяем call_request каждые 15с пока гудки: приёмник дедупит по
  // call_id (isCallSeen), дубликаты безопасны. Останавливается в hangup.
  ctx.callResendTimer = setInterval(async () => {
    if (ctx.callState !== 'outgoing_ringing' || !ctx.currentCall
        || ctx.currentCall.call_id !== call_id) {
      clearInterval(ctx.callResendTimer);
      ctx.callResendTimer = null;
      return;
    }
    try {
      // Offer внутри — ретрансляция несёт и его.
      // PQ: kemct/sender_ek из mediaStartOutgoing → в конверт.
      // Релей-копия НЕ повторяется (viaRelay=false): конверт уже
      // лежит в relay-очереди получателя с первого отправления —
      // повтор только жёг суточный лимит и плодил ntfy-пуши.
      await sendCallEnvelope(ctx, peer, {
        type: 'call_request', call_id, sdp: offerSdp,
        kemct: ctx._pendingKemct || undefined,
        sender_ek: ctx._pendingSenderEk || undefined,
      }, { viaRelay: false });
      ctx._pendingKemct = null; ctx._pendingSenderEk = null;
      console.log('[call] call_request retransmitted', call_id);
    } catch (e) {
      console.warn('[call] call_request retransmit failed:', e && e.message || e);
    }
  }, 15000);
}

export async function acceptCall(ctx) {
  const c = ctx.currentCall;
  if (!c || ctx.callState !== 'incoming_ringing') return;
  // Ответили — рингтон и таймер отмены в сторону, чайм соединения.
  // stop не нужен: play сам останавливает предыдущий звук.
  clearTimeout(ctx.callRingTimer);
  ctx.callRingTimer = null;
  playCallSound(ctx, 'connect', false);
  // что вызов жив. Гудим исходящим гудком (зацикленно) до media-connected
  setTimeout(() => {
    if (ctx.callState === 'active' && !ctx.callMediaConnected) {
      playCallSound(ctx, 'outgoing', true);
    }
  }, 1200);
  ctx.callState = 'active';
  // Фаза 3: сообщаем монитору-владельцу, что звонок принят
  // иначе headless-таймаут поставит missed поверх принятого.
  api.reportCallState(c.call_id, 'accept');
  // Таймер НЕ запускаем: ждём событие call-media-connected
  // из Rust (реальный звук). Предохранитель 120с — см. armMediaFallback.
  ctx.callMediaConnected = false;
  armMediaFallback(ctx);
  // OFFER В call_request: если offer звонящего пришёл в первом
  // письме — сразу создаём ANSWER и шлём его внутри call_accept. После
  // accept+offer → answer). Fallback (старая версия звонящего без
  // offer): создаём offer сами внутри call_accept.
  try {
    let acceptPayload;
    if (c.offerSdp) {
      const r = await api.mediaAcceptIncoming(c.call_id, c.offerSdp, ctx.peerKeys[c.peer] || '', c.kemct || null, true);
      console.log('[call] caller offer accepted, answer created,', (r.sdp || '').length, 'bytes, sending in call_accept');
      acceptPayload = { type: 'call_accept', call_id: c.call_id, sdp: r.sdp, role: 'answer' };
    } else {
      const r = await api.mediaStartOutgoing(c.call_id, ctx.peerKeys[c.peer] || '', (ctx.peerPqKeys && ctx.peerPqKeys[c.peer]) || null, true);
      console.log('[call] offer (callee fallback) created,', (r.sdp || '').length, 'bytes, sending in call_accept');
      acceptPayload = { type: 'call_accept', call_id: c.call_id, sdp: r.sdp };
    }
    await sendCallEnvelope(ctx, c.peer, acceptPayload);
    console.log('[call] call_accept + sdp sent OK');
    // Ретрансляция call_accept: письмо может потеряться
    // тогда звонящий будет гудеть вечно. Повторяем каждые 10с, пока
    // медиа не соединится (stopSignalResend в media-connected/hangup).
    startSignalResend(ctx, c.peer, acceptPayload, c.call_id);
  } catch (e) {
    console.error('[call] media start (callee) failed:', e);
    // Медиа не поднялось, но звонок всё равно принимаем — сигнал важнее.
    // показываем ошибку в UI — на Android иначе не
    // увидеть, почему webrtc-rs не поднимает медиа (logcat недоступен).
    ctx.showToast('media start failed: ' + (e && e.message || e), 10000);
    try { await sendCallEnvelope(ctx, c.peer, { type: 'call_accept', call_id: c.call_id }); }
    catch (e2) { console.error('call_accept failed:', e2); }
  }
}

export async function rejectCall(ctx) {
  const c = ctx.currentCall;
  if (c) {
    // Повтор call_reject — см. sendTerminalRepeat.
    sendTerminalRepeat(ctx, c.peer, 'call_reject', c.call_id);
    // Фаза 3: решение монитору-владельцу (нет missed поверх).
    api.reportCallState(c.call_id, 'reject');
  }
  hangup(ctx, 'reject');
}

export async function endCall(ctx) {
  const c = ctx.currentCall;
  if (c && ctx.callState === 'active') {
    // «hangup» по WebRTC DataChannel
    // собеседник получает за миллисекунды.
    // email 30-60с, и собеседник сидел с «активным» звонком.
    api.mediaSendHangup(c.call_id);
    // Email-сигнал остаётся как fallback (DC мог не открыться):
    // 3 попытки: сразу, +3с, +7с.
    sendTerminalRepeat(ctx, c.peer, 'call_end', c.call_id);
  }
  hangup(ctx, 'end');
}

// Локальный сброс состояния (после сигнала, отмены или таймаута).
export async function hangup(ctx, reason) {
  const c = ctx.currentCall;
  const callId = c ? c.call_id : null;
  const wasActive = ctx.callState === 'active';
  const wasIncoming = ctx.callState === 'incoming_ringing';
  const wasOutgoing = ctx.callState === 'outgoing_ringing';
  console.log('[call] hangup', reason, 'call_id=' + callId, 'state=' + ctx.callState);
  // Снять full-screen уведомление входящего: любой исход
  // (принят/отклонён/таймаут/завершён) гасит системный звонок.
  api.mediaDismissIncomingCall();
  // «пилюлей» (Пропущенный звонок / Нет ответа / Звонок завершён · 03:24).
  // fire-and-forget: hangup не ждёт sqlite.
  if (c && callId) {
    const dur = wasActive ? ctx.callClockSec : 0;
    let kind = null;
    if (wasActive) {
      kind = 'ended';
    } else if (wasIncoming) {
      if (reason === 'reject') kind = 'declined';
      else if (reason === 'timeout' || reason === 'remote'
          || reason === 'remote_late' || reason === 'preempt') kind = 'missed';
    } else if (wasOutgoing) {
      if (reason === 'timeout') kind = 'no_answer';
      else if (reason === 'remote_reject') kind = 'declined';
      // call_cancel от собеседника = у него сгорел таймер гудка → нет ответа.
      else if (reason === 'remote' || reason === 'remote_late') kind = 'no_answer';
      else if (reason === 'cancel') kind = 'canceled';
    }
    if (kind) recordCallEvent(ctx, c.peer, kind, Date.now(), dur, callId);
  }
  clearTimeout(ctx.callRingTimer);
  ctx.callRingTimer = null;
  // Ретрансляция call_request — тоже останавливаем.
  if (ctx.callResendTimer) {
    clearInterval(ctx.callResendTimer);
    ctx.callResendTimer = null;
  }
  // Ретрансляция call_accept/answer.
  stopSignalResend(ctx);
  // Предохранитель «Соединение…».
  clearTimeout(ctx._mediaFallbackTimer);
  // Grace-таймер ICE disconnected.
  if (ctx._connLostTimer) { clearTimeout(ctx._connLostTimer); ctx._connLostTimer = null; }
  stopCallClock(ctx);
  // Фаза 3: сообщаем монитору-владельцу исход звонка, чтобы
  // headless-логика не ставила missed поверх реального решения.
  if (callId) {
    const st = (wasIncoming && (reason === 'reject' || reason === 'timeout'
      || reason === 'cancel' || reason === 'preempt')) ? 'rejected'
      : 'ended';
    api.reportCallState(callId, st);
  }
  ctx.callState = 'idle';
  ctx.currentCall = null;
  ctx.callMuted = false;
  ctx.callSpeaker = false;
  ctx.callMediaConnected = false;
  stopFastPolling(ctx);
  // Финальный звук: play сам останавливает предыдущий поток
  // (Rust/HTML5), поэтому отдельный stop перед play не вызываем —
  // только если звука не будет вовсе.
  if (wasActive) {
    playCallSound(ctx, 'end', false);
  } else if (wasIncoming && (reason === 'timeout' || reason === 'reject'
      || reason === 'cancel' || reason === 'remote' || reason === 'preempt')) {
    playCallSound(ctx, 'missed', false);
  } else if (wasOutgoing && (reason === 'remote' || reason === 'timeout')) {
    // Звонящий: собеседник отклонил/отменил или гудки сгорели — отбой.
    playCallSound(ctx, 'end', false);
  } else {
    stopCallSound(ctx);
  }
  // Фаза 2: закрываем медиа-канал (webrtc-rs PeerConnection).
  if (callId) {
    try { await api.mediaClose(callId); } catch (e) { /* ignore */ }
  }
}

export async function cancelCall(ctx, reason) {
  const c = ctx.currentCall;
  // таймер гудка (ringing)
  // может сработать ПОЗЖЕ, чем call_accept дошёл по почте (SMTP с
  // Android + доставка + IMAP ≈ 90-180с). Если звонок уже active —
  // НЕ рвём живой звонок.
  if (reason === 'timeout' && ctx.callState === 'active') {
    console.warn('[call] stale ring timeout ignored — call is active');
    return;
  }
  // Отмена/таймаут — сообщаем собеседнику (call_cancel при ringing,
  // call_end при active), чтобы у него трубка легла сама.
  // ВАЖНО: fire-and-forget (НЕ await!) — между await-отправкой и
  // hangup есть окно гонки: обработка call_accept успевает сменить
  // state на active, и hangup рвёт живой звонок.
  // Повтор сигнала: 3 попытки — см. sendTerminalRepeat.
  if (c) {
    const type = ctx.callState === 'active' ? 'call_end' : 'call_cancel';
    sendTerminalRepeat(ctx, c.peer, type, c.call_id);
  }
  hangup(ctx, reason || 'cancel');
}

// ── Пропущенные вызовы (пилюли) ────────────────────────────────
// пропущенный/нет ответа/отклонён/завершён + время + кнопка «Перезвонить».
// Пилюля — обычное сообщение с полем callEvent; персистится в sqlite
// вместе с историей (saveCurrentHistory) и в chat-cache (slim-маппер
// сохраняет callEvent). Текст рендерится через t() — язык из настроек.
export async function recordCallEvent(ctx, peer, kind, ts, durationSec, callId) {
  if (!peer || !callId) return;
  const chatKey = ctx.canonicalOf(peer) || peer;
  const tsNum = Number(ts) || Date.now();
  const msg = {
    id: 'call-' + callId,
    content: '',
    from: 'them',
    time: new Date(tsNum).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    ts: tsNum,
    encrypted: true,
    vault: true,
    callEvent: { kind, duration: Number(durationSec) || 0, call_id: callId },
  };
  // Дедуп: один call_id — одна пилюля (повторный фетч/ретрансляция).
  const exists = (ctx.messages || []).some(m => m && m.id === msg.id);
  if (!exists && ctx.activeChat === chatKey && ctx.activeChatType === 'chat') {
    ctx.messages.push(msg);
    ctx.messages.sort((a, b) => ctx.msgTs(a) - ctx.msgTs(b));
    ctx.saveCurrentHistory(chatKey);
    ctx.saveChatCache(chatKey, ctx.messages);
    ctx.scrollToBottom(true);
  } else if (!exists) {
    // Чат не открыт — дописываем пилюлю в сохранённую историю напрямую,
    // чтобы она появилась при следующем открытии чата.
    try {
      // Нулевая история (чат ещё не открывали) — тоже валидный случай:
      // раньше Array.isArray(null)===false молча глотал ПЕРВУЮ пилюлю
      // «Пропущенный звонок» свежего чата.
      const hist = (await loadHistory(ctx.email, chatKey)) || [];
      if (!hist.some(m => m && m.id === msg.id)) {
        hist.push(msg);
        hist.sort((a, b) => ctx.msgTs(a) - ctx.msgTs(b));
        await saveHistory(ctx.email, chatKey, hist);
      }
    } catch (e) { /* sqlite недоступен — не критично */ }
  }
  // Бейдж непрочитанных: пропущенный входящий — как непрочитанное
  // сообщение, если чат сейчас не виден.
  if (kind === 'missed' && !ctx.chatVisible(chatKey)) {
    ctx.unreadCounts[chatKey] = (ctx.unreadCounts[chatKey] || 0) + 1;
    await ctx.saveUnreadCounts();
  }
}

export function callEventLabel(ctx, msg) {
  const ev = msg && msg.callEvent;
  if (!ev) return '';
  const key = {
    missed: 'call_missed',
    no_answer: 'call_no_answer',
    declined: 'call_declined',
    canceled: 'call_canceled',
    ended: 'call_ended',
  }[ev.kind] || 'call_missed';
  let label = ctx.t(key);
  if (ev.kind === 'ended' && ev.duration > 0) {
    const m = Math.floor(ev.duration / 60);
    const s = ev.duration % 60;
    label += ' · ' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return label;
}

export function callPillIcon(msg) {
  const kind = msg && msg.callEvent && msg.callEvent.kind;
  if (kind === 'ended') return 'phone';
  return 'phone-off';
}

export function canCallBack(ctx, msg) {
  // Перезвонить можно, если звонок не активен и у собеседника есть ключ.
  return !!(msg && msg.callEvent && ctx.expCalls
      && ctx.callState === 'idle'
      && ctx.activeChatType === 'chat'
      && ctx.peerKeys[ctx.activeChat]);
}

export function callBack(ctx) {
  startCall(ctx);
}

// ── Микрофон/динамик ───────────────────────────────────────────
// Микрофон звонка (в конфликте ключей с чат-меню «Без звука» — то
// отдельный метод ниже; Options API не терпит дублей имён).
export function toggleCallMute(ctx) {
  ctx.callMuted = !ctx.callMuted;
  const c = ctx.currentCall;
  if (c) {
    api.mediaSetMuted(c.call_id, ctx.callMuted).catch((e) => console.error('[call] set muted failed:', e));
  }
}

// Динамик: Android — speakerphone (earpiece ↔ динамик)
// desktop — no-op в Rust (вывод и так на динамики).
export function toggleSpeaker(ctx) {
  ctx.callSpeaker = !ctx.callSpeaker;
  const c = ctx.currentCall;
  if (c) {
    api.mediaSetSpeaker(c.call_id, ctx.callSpeaker).catch((e) => console.error('[call] set speaker failed:', e));
  }
}

// ── Ретрансляция критичных сигналов ────────────────────────────
// РЕТРАНСЛЯЦИЯ КРИТИЧНЫХ СИГНАЛОВ: call_accept и SDP-answer
// повторяются каждые 10с, пока медиа не соединится или звонок не
// завершится. Email-письма теряются в транзите (наблюдали: call_accept
// сбрасывается»). Дубликаты безопасны: приёмник игнорирует их по
// состоянию (call_accept — только в outgoing_ringing, call_sdp —
// только в active с тем же call_id).
export function startSignalResend(ctx, peer, payload, call_id) {
  stopSignalResend(ctx);
  ctx._signalResendTimer = setInterval(async () => {
    if (ctx.callState !== 'active' || !ctx.currentCall
        || ctx.currentCall.call_id !== call_id || ctx.callMediaConnected) {
      stopSignalResend(ctx);
      return;
    }
    try {
      // Релей-копия уже доставлена первым отправлением — повтор
      // только почтой (лимит + лишние пуши).
      await sendCallEnvelope(ctx, peer, payload, { viaRelay: false });
      console.log('[call] signal retransmitted:', payload.type, call_id);
    } catch (e) {
      console.warn('[call] signal retransmit failed:', e && e.message || e);
    }
  }, 10000);
}

export function stopSignalResend(ctx) {
  if (ctx._signalResendTimer) {
    clearInterval(ctx._signalResendTimer);
    ctx._signalResendTimer = null;
  }
}

// Повтор терминального сигнала (call_end/call_cancel/call_reject):
// если письмо потеряется, собеседник останется с поднятой трубкой
// навсегда. Ещё 2 попытки через 3с и 7с (fire-and-forget). Дубликаты
// у приёмника безопасны (ветка remote_late / guard по state).
export function sendTerminalRepeat(ctx, peer, type, call_id) {
  // Повторы — только почтой: релей-копия call_end ушла первым
  // отправлением; wake=false и так стоит (терминальный сигнал),
  // повтор на релей жёг бы лимит издателя.
  sendCallEnvelope(ctx, peer, { type, call_id }, { viaRelay: false }).catch(() => {});
  setTimeout(() => { sendCallEnvelope(ctx, peer, { type, call_id }, { viaRelay: false }).catch(() => {}); }, 3000);
  setTimeout(() => { sendCallEnvelope(ctx, peer, { type, call_id }, { viaRelay: false }).catch(() => {}); }, 7000);
}

// ── Watchdog + часы ────────────────────────────────────────────
// Watchdog «Соединение…»: если через 90с после accept медиа
// не соединилось (событие call-media-connected не пришло) — звонок не
// состоялся: accept/answer потерялись в почте или собеседник уже ушёл.
// красной кнопкой висел вечно. Теперь кладём трубку сами.
export function armMediaFallback(ctx) {
  clearTimeout(ctx._mediaFallbackTimer);
  ctx._mediaFallbackTimer = setTimeout(() => {
    if (ctx.callState === 'active' && !ctx.callMediaConnected) {
      console.warn('[call] media not connected in 90s — auto hangup');
      ctx.showToast(ctx.t('call_connect_failed'), 4000);
      // Сообщаем собеседнику, чтобы у него тоже легла трубка
      // (он может висеть в таком же «Соединение…»).
      const c = ctx.currentCall;
      if (c) sendTerminalRepeat(ctx, c.peer, 'call_end', c.call_id);
      hangup(ctx, 'connect_timeout');
    }
  }, 90000);
}

export function startCallClock(ctx) {
  ctx.callClockSec = 0;
  clearInterval(ctx.callClockTimer);
  ctx.callClockTimer = setInterval(() => { ctx.callClockSec++; }, 1000);
}

export function stopCallClock(ctx) {
  clearInterval(ctx.callClockTimer);
  ctx.callClockTimer = null;
}

// Быстрый путь сигнализации (Фаза 1.5): IDLE-цикл теперь ПОСТОЯННЫЙ
// дополнительно ничего делать не нужно, IDLE уже ловит
// сигналы за ~1с. Оставляем как гарантию, что цикл запущен.
export function startFastPolling(ctx) {
  ctx.idleLoop();
}

export function stopFastPolling(ctx) {
  // IDLE-цикл постоянный — не останавливаем.
}

// ── Звук ───────────────────────────────────────────────────────
// (ДОЛЖНЫ быть в methods, НЕ в computed. В computed Vue 3 превращает
// их в геттеры: this.playCallSound(...) вызывает тело БЕЗ аргументов,
// и this.isAndroid() бросает TypeError. Синхронный бросок рвал
// acceptCall ДО отправки call_accept. Плюс: функция НИКОГДА не
// должна бросать — звук вторичен, сигнализация звонка важнее.)
export function playCallSound(ctx, name, looped) {
  try {
    // Настройки звонков: пользователь мог выбрать другой рингтон
    // (Настройки → Звонки). Маппим incoming/outgoing на выбранный вариант.
    const ringIn = ctx.callRingtoneIncoming || 'incoming';
    const ringOut = ctx.callRingtoneOutgoing || 'outgoing';
    if (name === 'incoming') name = ringIn;
    else if (name === 'outgoing') name = ringOut;
    if (ctx.isAndroid) {
      stopCallSound(ctx);
      const el = new Audio('/sounds/ring_' + name + '.wav');
      el.loop = !!looped;
      el.volume = 0.85;
      el.play().catch(e => console.warn('[call] sound play failed:', e));
      ctx.callSoundEl = el;
      // Одноразовые звуки: освобождаем элемент по окончании.
      if (!looped) {
        el.onended = () => { if (ctx.callSoundEl === el) ctx.callSoundEl = null; };
      }
    } else {
      api.mediaSoundPlay(name, !!looped).catch(e => console.warn('[call] sound play failed:', e));
    }
  } catch (e) {
    // Звук не критичен — глотаем, чтобы не рвать state machine звонка.
    console.warn('[call] sound failed:', e && e.message || e);
  }
}

export function stopCallSound(ctx) {
  try {
    if (ctx.callSoundEl) {
      try { ctx.callSoundEl.pause(); } catch (_) {}
      ctx.callSoundEl = null;
    }
    if (!ctx.isAndroid) {
      api.mediaSoundStop().catch(() => {});
    }
  } catch (e) {
    console.warn('[call] sound stop failed:', e && e.message || e);
  }
}
