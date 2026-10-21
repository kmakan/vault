// Feature module: звонки (сигнализация конвертами call_* + state machine).
// ADR-005 W2 (`t_bcb8927a`), партия 7: модуль больше НЕ читает компонент.
//
// СОСТОЯНИЕ — У ВЛАДЕЛЬЦЕВ (ADR-004), ЭФФЕКТЫ — ЯВНЫЙ deps (ADR-005 R3):
//   · `peerKeys`/`peerPqKeys` — владелец identity-store;
//   · `activeChat`/`activeChatType` — владелец chatStore (J.3a);
//   · состояние звонка (callState/currentCall/callStartedAt) — владелец
//     call-session (`useSession()`; это SINGLETON, обёрнутый reactive() на
//     уровне модуля, поэтому записи из фичи реактивны);
//   · `chat` — per-app экземпляр чат-владельца (в deps: он создаётся в
//     setup() компонента);
//   · остальное (isIgnored/incUnread/save*/chatVisible/canonicalOf/msgTs/
//     idleLoop/isAndroid/callPeerName) — эффекты, явный список в deps.
//
// Таймеры и колбэки (armRingTimer, ретраи, watchdog) держат ССЫЛКУ на deps:
// deps — это набор функций, а не снимок состояния, поэтому значения читаются
// живо (активный чат, ключи пира) — как раньше через ctx.
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
import { accountNamespace } from '../identity.js';
import * as relay from '../relay-client.js';
import crypto from '../crypto.js';
import { saveHistory, loadHistory } from '../history.js';
import { invoke } from '@tauri-apps/api/core';
import * as WireSignalRule from '../wire-signal-rule.js';
// Re-export для backward-compat (App.vue / smoke ссылаются через C.SIGNAL_RESEND_DELAYS_MS).
export { SIGNAL_RESEND_DELAYS_MS } from './call-resend.js';
import { createMediaWatchdog } from './call-watchdog.js';
import { createRingTimer } from './call-ring.js';
import { createTerminalSender } from './call-terminal.js';
// fire-and-forget задержки (delay/later/cancel) — убирают bare setTimeout/
// clearTimeout из state-machine (timing.js; см. ADR-004 G).
import { delay, later } from './timing.js';
import { fastFetcher, connLostGuard } from './call-idle.js';
import { useSession } from './call-session.js';
import { callResender, callRequestResender } from './call-resend.js';

// Правило состояния звонка — в Rust (ADR-005 R1 / W4, `t_821261f7`).
//
// ЧТО ОСТАЛОСЬ В JS: чтение ТЕКУЩЕГО состояния (владелец — наш) и
// исполнение решения. ЧТО УШЛО В RUST: «можно ли» (поставить таймер гудка,
// начать звонок, принять, отменить, отправить hangup по DC, применить SDP) и
// «в какое состояние переходим».
//
// Почему так: расхождение фронта и ядра в правилах машины состояний означает
// «обрыв на живом звонке» или «пропавший вызов» — оба случая уже были
// (инцидент 12.10.2026: таймер гудка, пришедший после call_accept, рвал живой
// разговор).
import {
  can as callCan,
  canCached,
  callNextState,
  incomingRequestAction,
  hangupSignalKind,
} from '../call-state-rule.js';

// Перевести состояние по событию (решение — в Rust).
async function applyCallState(event) {
  const next = await callNextState(useSession().callState, event);
  if (next) useSession().setCallState(next);
  return next;
}
import { sessionStore, uiStore, chatStore } from './session-store.js';
import { identityStore } from './identity-store.js';
const terminalSender = createTerminalSender();

// ── Ретрансляция сигналов: ЗАТУХАЮЩАЯ, с КОНЕЧНЫМ числом повторов ──
// Инцидент 12.10.2026. Раньше call_request повторялся каждые 15с все 5 минут
// гудков (~20 писем на один звонок), а call_accept — каждые 10с до соединения.
// Сотни одинаковых писем с ПУСТОЙ темой сожгли репутацию отправителя: Яндекс
// начал отбивать наши письма («554 5.7.1 Message rejected under suspicion of
// SPAM»), и РЕЗЕРВНЫЙ ПОЧТОВЫЙ КАНАЛ УМЕР — а он единственный, когда релей
// недоступен. Повторы нужны против редкой транзитной потери (SMTP принял, но
// письмо не дошло) — 4 попытки её покрывают. Лавину — нет.
//
// Таймер/попытки — владелец singleton createCallResender() в call-resend.js
// (callResender / callRequestResender), a не в App.data: calls.js импортирует
// их напрямую, как fastFetcher/connLostGuard из call-idle.js.
// ── S5-2: решение, принятое кнопкой системного уведомления ──────
// Сценарий: приложение закрыто, звонок пришёл по FCM, JS о нём не знает
// (useSession().setCurrentCall(null)). Юзер жмёт «Ответить» → CallActionReceiver →
// MainActivity.dispatchCallAction('accept'). Живого WebView на этот момент
// может не быть (только что поднятое приложение) — натив отдаёт решение
// сюда через window.__vaultApplyPendingCallDecision, а мы применяем его
// ровно к тому call_request, который придёт из очереди реля (контракт C).
// Значение ОДНОРАЗОВОЕ: применяется и сбрасывается.
let pendingNativeCallDecision = null;
export function setPendingNativeCallDecision(action) {
  if (action === 'accept' || action === 'reject') pendingNativeCallDecision = action;
}

// ── Дедуп звонков (persist kv 'call-seen') ─────────────────────
// call_id обработанного звонка (request/accept/end/reject). После
// перезапуска не даёт старым конвертам снова дёргать state machine.
export async function isCallSeen(email, callId) {
  try {
    const raw = await db.kvGet(await accountNamespace(email), 'call-seen');
    const set = raw ? new Set(JSON.parse(raw)) : new Set();
    return set.has(callId);
  } catch (e) { return false; }
}

export async function rememberCallSeen(email, callId) {
  try {
    const raw = await db.kvGet(await accountNamespace(email), 'call-seen');
    const set = raw ? new Set(JSON.parse(raw)) : new Set();
    set.add(callId);
    // Храним последние 100 call_id (старые не нужны)
    if (set.size > 100) {
      const arr = Array.from(set);
      arr.splice(0, arr.length - 100);
      await db.kvSet(await accountNamespace(email), 'call-seen', JSON.stringify(arr));
    } else {
      await db.kvSet(await accountNamespace(email), 'call-seen', JSON.stringify(Array.from(set)));
    }
  } catch (e) { /* тихо */ }
}

// ── Длительность гудка (настройка «Звонки») ────────────────────
// Значение в kv_store — СЕКУНДЫ (60/120/180/300, дефолт 180). Здесь
// переводим в мс. Читаем асинхронно ДО старта ring-таймера, state machine
// не ждёт: гудок стартует с дефолтом, а если kv ответит позже — таймер
// ПЕРЕСТАРАИВАЕТСЯ на реальное значение (см. armRingTimer).
// Дублирует нативную сторону: при СМАХНУТОМ приложении JS мёртв и таймаут
// считает FGS (VaultForegroundService → prefs call_ring_duration).
const DEFAULT_RING_MS = 180000;

async function fetchRingDurationMs() {
  try {
    const raw = await db.kvGet('anon', 'call-ring-duration');
    const sec = parseInt(raw, 10);
    if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_RING_MS;
    // Кламп 15..600с — битое значение в kv не должно вешать звонок.
    return Math.min(600, Math.max(15, sec)) * 1000;
  } catch (e) {
    return DEFAULT_RING_MS;
  }
}

const ringTimer = createRingTimer();

// Ставит таймер таймаута гудка. fallbackMs используется немедленно,
// затем (асинхронно) уточняется реальной настройкой. Гонка учтена:
// если за это время звонок уже снят/принят (callRingTimer !== null
// меняется на null) — переставлять таймер нельзя.
async function armRingTimer(deps, fallbackMs = DEFAULT_RING_MS) {
  const start = async (ms) => {
    if (!useSession().currentCall) return;
    if (!(await callCan(useSession().callState, 'arm_ring_timer'))) return;
    useSession().setCallRingTimer(ringTimer.start(ms, () => cancelCall(deps, 'timeout')));
  };
  await start(fallbackMs);
  fetchRingDurationMs().then(async (ms) => {
    if (!(await callCan(useSession().callState, 'arm_ring_timer'))) return;
    start(ms);
  }).catch(() => { /* дефолт уже стоит */ });
}

// ── Сигнализация ───────────────────────────────────────────────
// Распознавание сигнального конверта: {vault:1, type:'call_*', call_id,...}.
// Такие письма НЕ рендерятся сообщениями (как квитанции) — уходят в
// state machine звонка. Медиа (webrtc-rs) подключается в Фазе 2.
// Разбор сигнала звонка — В RUST (ADR-005 R1 / W4): правило «это call-сигнал»
// и набор его полей — в ядре (vault::call::parse_call_signal).
//
// ПОЧЕМУ ПЕРЕЕХАЛО. Правило жило в двух местах: в Rust (M2.3) и в JS — и
// они РАСХОДИЛИСЬ: Rust-сигнал не знал поля `tok` (relay-токен отправителя),
// который JS читает при приёме сигнала (handleCallSignal → relay.memLearn).
// Мост call_parse_signal в приложении не вызывался вообще — JS разбирал сам.
// Теперь правило одно, и в нём есть tok.
//
// ФУНКЦИЯ СТАЛА ASYNC: разбор идёт через мост, а мост асинхронен.
export async function parseCallSignal(decrypted) {
  return WireSignalRule.parseCallSignal(decrypted);
}

// M2.8: Rust bridge parity — media_call_state (group-call roster state).
export async function mediaCallStateBridge(callId) {
  try { return await invoke('media::media_call_state', { callId }); }
  catch (e) { console.warn('[call] media_call_state bridge failed:', e && e.message || e); return 'Idle'; }
}

// M2.10 (ADR-002): Rust bridge parity — media_call_join (group fan-out).
export async function mediaCallJoinBridge(callId, participantKeys) {
  try { return await invoke('media::media_call_join', { callId, participantKeys }); }
  catch (e) { console.warn('[call] media_call_join bridge failed:', e && e.message || e); }
}

// Отправка сигнала звонка (stealth-письмо с пустой темой — как квитанции).
export async function sendCallEnvelope(deps, peer, payload, opts = {}) {
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
  // M2.4: call-конверт несёт tok отправителя (адрес его relay-очереди) —
  // получатель auto-learned при приходе (incoming.js call-ветка).
  // Почта=гарант, релей=ускорение: без peer-tokens call-сигналы
  // падают на 30с-поллинг — это корневой фикс.
  // Гейт ctx.relayEnabled СНЯТ: адрес НАШЕЙ очереди нужен собеседнику
  // независимо от того, сами мы шлём через релей или нет. Иначе
  // выключенный релей у одного из собеседников навсегда ломает
  // обмен токенами (он не узнает наш адрес → мы не узнаём его).
  try {
    const { relays, active } = await relay.getSettings(sessionStore.getCurrentEmail());
    const myTok = ((relays[active] || relays[0]) || {}).myToken || '';
    if (myTok) body.tok = myTok;
  } catch (e) { /* релей опционален */ }
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
      // Явная диагностика на стенде: без peer-токена получателя relayPublish
      // выйдет по ветке 'no-peer-token', и звонок уйдёт ТОЛЬКО почтой.
      // Раньше это было видно только по косвенным метрикам релея.
      let peerFp = null;
      try {
        const publicKey = identityStore.state.peerKeys[peer];
        if (publicKey) {
          peerFp = await relay.fingerprintOf(publicKey);
        }
      } catch (e) {
        // If fingerprint resolution fails, continue with legacy email-only relay
        peerFp = null;
      }
      const known = await relay.hasPeerToken(sessionStore.getCurrentEmail(), peer, peerFp);
      if (!known) console.log('[relay] call: peer token unknown for', peer, '→ email-only');
      // urgent для call_request: сервер обходит last_seen-гейт, чтобы
      // будить только что закрытое приложение (гейт 90с не знал, что
      // «поллил 5с назад» = его убили). Дедуп на клиенте по env.id.
      relay.relayPublish(sessionStore.getCurrentEmail(), peer, { id: body.id }, content, { wake, urgent: wake, peerFp })
        .then(r => {
          // Причина пропуска публикации ВИДНА в логе: relayPublish возвращает
          // {ok:false, why}, но вызывающий код его игнорировал — на стенде
          // это читалось как «звонок ушёл, а на relay-очереди тишина».
          if (r && r.ok === false) {
            console.log('[relay] call publish skipped for', peer, '→', r.why);
            return;
          }
          // Релей принял конверт: адрес очереди живой, пуш ушёл. Значит сигнал
          // дошёл ОСНОВНЫМ каналом, и почтовая копия ниже — лишь догоняющий
          // дубль. Помечаем звонок, чтобы её возможный DSN/баунс НЕ гасил
          // вызов (onMailBounce; инцидент 12.10.2026: баунс почты убивал
          // вызов, который собеседник уже видел на экране).
          const call = useSession().currentCall;
          if (call && call.call_id === payload.call_id) call.relayDelivered = true;
        })
        .catch(e => console.warn('[relay] call publish error:', e && e.message || e));
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
        await delay(3000);
      }
    }
    console.error('[call] SMTP envelope failed after retries:', lastErr && lastErr.message);
  })();
  // SMTP ушёл в фон — ошибки канала не роняют звонок (релей-копия уже
  // доставлена; письмо — догоняющий дубль). Больше не бросаем lastErr.
}

// Входящий сигнал → state machine. MVP: один звонок одновременно.
export async function handleCallSignal(deps, sig, from) {
  const { call_id, type } = sig;
  if (!call_id || !from) return;
  // Ignore-лист: звонки заблокированного гасятся до state machine —
  // ни рингтона, ни оверлея, ни «пропущенного» в истории.
  if (deps.isIgnored(from)) return;
  console.log('[call] signal', type, call_id, 'from', from, 'state=' + useSession().callState,
    'current=' + (useSession().currentCall ? useSession().currentCall.call_id : 'null'));
  // M2.4: call-конверт несёт tok отправителя (адрес его relay-очереди).
  // Обучение живёт в call-фиче (модульность: общий classify() relay не зовёт)
  // и НЕ блокирует state machine (fire-and-forget).
  if (sig.tok) {
    (async () => {
      try {
        const rs = await relay.getSettings(sessionStore.getCurrentEmail());
        const r = rs.relays[rs.active] || rs.relays[0];
        if (r) {
          relay.memLearn(r.url, from, sig.tok); // 0.1.186: синхронный mirror для relayPublish
          const known = (rs.peers[r.url] || {})[String(from).toLowerCase()];
          
          // Add peerFp if available
          let peerFp = null;
          try {
            const publicKey = identityStore.state.peerKeys[from];
            if (publicKey) {
              peerFp = await relay.fingerprintOf(publicKey);
            }
          } catch (e) {
            // If fingerprint resolution fails, continue without fp
            peerFp = null;
          }
          
          if (known !== sig.tok) await relay.setPeerToken(sessionStore.getCurrentEmail(), r.url, from, sig.tok, peerFp);
        }
      } catch (e) { /* релей опционален */ }
    })();
  }
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
    const alreadySeen = await isCallSeen(sessionStore.getCurrentEmail(), call_id);
    await rememberCallSeen(sessionStore.getCurrentEmail(), call_id);
    // Пропущенные вызовы: звонок пришёл, пока нас не было
    // (офлайн/перезапуск) — записываем «Пропущенный звонок» в историю
    // чата. Только при ПЕРВОМ появлении call_id (alreadySeen=false) —
    // иначе повторный фетч Спада после рестарта плодил дубли пилюль.
    if (type === 'call_request' && !alreadySeen) {
      await recordCallEvent(deps, from, 'missed', sig.ts, 0, call_id);
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
  if (type === 'call_request' && !(useSession().currentCall && useSession().currentCall.call_id === call_id)) {
    if (await isCallSeen(sessionStore.getCurrentEmail(), call_id)) return;
    await rememberCallSeen(sessionStore.getCurrentEmail(), call_id);
  }
  // Чужой звонок, пока мы говорим — решение «занято» (call_reject).
  // ПРАВИЛО — в Rust: «можно ли отвечать занято» зависит от состояния, и
  // фронт с ядром обязаны считать одинаково.
  const reqAction = type === 'call_request'
    ? await incomingRequestAction(
        useSession().callState,
        !!(useSession().currentCall && useSession().currentCall.call_id === call_id),
        !!useSession().currentCall)
    : 'ignore';
  if (reqAction === 'busy' && useSession().currentCall
      && useSession().currentCall.call_id !== call_id) {
    await sendCallEnvelope(deps, from, { type: 'call_reject', call_id });
    // Пропущенные вызовы: мы говорили по другому звонку
    await recordCallEvent(deps, from, 'missed', sig.ts, 0, call_id);
    return;
  }
  switch (type) {
    case 'call_request': {
      // РЕТРАНСЛЯЦИЯ: звонящий повторяет call_request каждые 15с
      // (письма теряются в транзите). Если тот же call_id УЖЕ звонит у
      // нас — это дубль: игнорируем.
      if (useSession().currentCall && useSession().currentCall.call_id === call_id) return;
      // ГАРАНТИЯ ПОКАЗА: НОВЫЙ call_request ВСЕГДА вытесняет любое
      // состояние, кроме реального разговора (active) — даже если state
      // machine зависла в ringing от старого конверта без currentCall.
      // Решение «вытеснить или принять» — в Rust.
      if (reqAction === 'preempt') {
        console.warn('[call] forcing reset before new request (state=' + useSession().callState + ')');
        await hangup(deps, 'preempt', await callNextState(useSession().callState, 'preempted'));
      }
      if (reqAction !== 'accept' && reqAction !== 'preempt') return;
      // OFFER В call_request: звонящий создаёт offer ДО набора
      // он едет в первом письме. Сохраняем: при accept сразу создадим
      // answer (1 hop вместо 2). Если sdp нет (старая версия/fallback) —
      // acceptCall создаст offer сам (старая схема).
      useSession().setCurrentCall({
        call_id, peer: from, offerSdp: sig.sdp || null,
        // PQ: kemct звонящего — в mediaAcceptIncoming при accept.
        kemct: sig.kemct || null, senderEk: sig.sender_ek || null,
      });
      useSession().setLastCallId(call_id);
      await applyCallState('request_received');
      useSession().setMuted(false);
      useSession().state.callStartedAt = Date.now();
      console.log('[call] incoming_ringing SET for', call_id, 'from', from);
      // Звук входящего: WAV-рингтон «кристальный чайм».
      // Desktop — cpal в Rust (слышен при свёрнутом окне).
      // Android: в фоне/закрытом WebView HTML5-Audio глохнет — рингтон там
      // нативный MediaPlayer (showIncomingCall). В ВИДИМОМ WebView (приложение
      // открыто) нативный звонок подавлен — HTML5 работает, играем сами.
      if (!deps.isAndroid() || document.visibilityState === 'visible') {
        playCallSound(deps, 'incoming', true);
      }
      // Full-screen уведомление: Android — системный звонок поверх локскрина.
      // При ОТКРЫТОМ приложении UI = CallOverlay (свайпы) — системное
      // уведомление не поднимаем (контракт A), иначе дубль с оверлеем.
      // Desktop — no-op. Снимается в hangup().
      if (!(deps.isAndroid() && document.visibilityState === 'visible')) {
        api.mediaShowIncomingCall(deps.callPeerName() || from);
      }
      startFastPolling(() => deps.idleLoop(), useSession().callIdleMonitorUp);
      // Таймер гудка: длительность из настроек (SettingsPage → kv
      // 'call-ring-duration', секунды). Читаем АСИНХРОННО и НЕ блокируем
      // state machine: если kv не ответил — дефолт 180с (было хардкодом).
      // 180с вместо прежних 90с: call_accept/answer по почте идут долго
      // (SMTP+доставка+IMAP), звонок «сгорал» до ответа собеседника.
      await armRingTimer(deps, DEFAULT_RING_MS);
      // S5-2 (контракт C): юзер уже нажал «Ответить»/«Отклонить» в
      // уведомлении, пока приложение поднималось. Звонок только что
      // появился в incoming_ringing — применяем накопленное решение один
      // раз, вместо показа свайпов. Иначе guard в acceptCall отбивал бы
      // вызов как «отклонён».
      if (pendingNativeCallDecision) {
        const act = pendingNativeCallDecision;
        pendingNativeCallDecision = null;
        console.log('[call] applying native button decision:', act, 'for', call_id);
        if (act === 'accept') await acceptCall(deps);
        else await rejectCall(deps);
      }
      break;
    }
    case 'call_accept': {
      if (useSession().currentCall && useSession().currentCall.call_id === call_id
          && await callCan(useSession().callState, 'accept_outgoing')) {
        // Собеседник принял — таймер отмены больше не нужен.
        ringTimer.stop();
        useSession().setCallRingTimer(null);
        // Гудки кончились — затухающие повторы call_request больше не нужны.
        // Таймер — callRequestResender (createCallResender, call-resend.js).
        callRequestResender.stop();
        // Гудки исходящего → чайм соединения. stop не нужен
        // play сам останавливает предыдущий звук (Rust/HTML5).
        playCallSound(deps, 'connect', false);
        await applyCallState('accepted');
        // Таймер НЕ запускаем: ждём событие call-media-connected
        // из Rust (реальный звук). Предохранитель 120с — если событие
        // потерялось, показываем таймер хоть когда-нибудь.
        useSession().setCallMediaConnected(false);
        armMediaFallback(deps);
        // OFFER В call_request: если мы создали offer при наборе
        // (hasLocalOffer) — sdp в call_accept это ANSWER: ставим remote,
        // DTLS-SRTP устанавливается. Fallback (старая схема): sdp это
        // offer принимающего — принимаем его и шлём answer.
        if (sig.sdp) {
          if (useSession().currentCall && useSession().currentCall.hasLocalOffer) {
            try {
              await api.mediaSetRemote(call_id, sig.sdp);
              console.log('[call] remote answer set — DTLS handshake should follow');
            } catch (e) {
              console.error('[call] media set remote (answer) failed:', e && e.message || e);
            }
          } else {
            try {
              const r = await api.mediaAcceptIncoming(call_id, sig.sdp, identityStore.state.peerKeys[from] || '', sig.kemct || null, true);
              console.log('[call] callee offer accepted, answer created,', (r.sdp || '').length, 'bytes');
              const answerPayload = { type: 'call_sdp', call_id, sdp: r.sdp, role: 'answer' };
              await sendCallEnvelope(deps, from, answerPayload);
              console.log('[call] answer sent OK — waiting for DTLS');
              // Ретрансляция answer: если письмо потеряется
              // принимающий зависнет в «Соединение…». Повторяем каждые
              // 10с до соединения медиа.
              startSignalResend(deps, from, answerPayload, call_id);
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
      if (useSession().currentCall && useSession().currentCall.call_id === call_id) {
        // remote_reject — отдельно от remote: звонящий увидит
        // «Вызов отклонён», а не «Нет ответа».
        hangup(deps, type === 'call_reject' ? 'remote_reject' : 'remote',
          await callNextState(useSession().callState, 'hung_up'));
      } else if (useSession().lastCallId === call_id
                 && await callCan(useSession().callState, 'call_idle')) {
        console.log('[call] remote end after local hangup — ensuring cleanup');
        hangup(deps, 'remote_late', await callNextState(useSession().callState, 'hung_up'));
      }
      // ЗАПОМНИТЬ ТЕРМИНАЛЬНЫЙ call_id ВСЕГДА
      // доставки (INBOX/All Mail/Спам — разные копии, порядок не
      // гарантирован). Без помни later call_request поднимал звонок,
      // которого уже нет (запомненные терминалы гасят его в guard
      // isCallSeen ниже). Свежие cancel не попадали в stale-ветку —
      // потому и не запоминались.
      await rememberCallSeen(sessionStore.getCurrentEmail(), call_id);
      if (useSession().lastCallId !== call_id) useSession().setLastCallId(call_id);
      break;
    }
    case 'call_sdp': {
      // Фаза 2: SDP-обмен после call_accept. offer — сторона получателя
      // (создаёт answer и шлёт обратно), answer — сторона звонящего
      // (завершает handshake, DTLS-SRTP устанавливается).
      console.log('[call] sdp received', call_id, 'role=' + sig.role, 'state=' + useSession().callState);
      if (!useSession().currentCall || useSession().currentCall.call_id !== call_id
          || !(await callCan(useSession().callState, 'apply_sdp'))) {
        console.warn('[call] sdp DROPPED by guard:', call_id, 'role=' + sig.role,
            'state=' + useSession().callState, 'current=' + (useSession().currentCall && useSession().currentCall.call_id));
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
export async function startCall(deps) {
  const peer = chatStore.state.activeChat;
  if (!peer || peer === '__notes__' || chatStore.state.activeChatType !== 'chat') return;
  if (!identityStore.state.peerKeys[peer]) return;
  if (!(await callCan(useSession().callState, 'start_outgoing'))) return;
  const call_id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  useSession().setCurrentCall({ call_id, peer });
  useSession().setLastCallId(call_id);
  await applyCallState('outgoing_started');
  useSession().setMuted(false);
  startFastPolling(() => deps.idleLoop(), useSession().callIdleMonitorUp);
  // для call_accept может превысить 180с, и звонок сгорал до ответа;
  // окончательно решает call_reject/call_cancel от собеседника).
  useSession().setCallRingTimer(ringTimer.start(300000, () => cancelCall(deps, 'timeout')));
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
    const r = await api.mediaStartOutgoing(call_id, identityStore.state.peerKeys[peer] || '', (identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[peer]) || null, true);
    offerSdp = r.sdp;
    // PQ: kemct из SdpResult — поедет в call_request-конверте
    // принимающий передаст в mediaAcceptIncoming для гибридного ключа.
    if (r.kemct) useSession().setPendingKemct(r.kemct);
    if (r.sender_ek) useSession().setPendingSenderEk(r.sender_ek);
    console.log('[call] offer created at dial time,', (offerSdp || '').length, 'bytes');
  } catch (e) {
    console.error('[call] offer at dial failed (fallback callee-offer):', e);
  }
  // Флаг для обработки call_accept: если offer создан здесь
  // sdp в call_accept это ANSWER; иначе (fallback) — offer принимающего.
  useSession().currentCall.hasLocalOffer = !!offerSdp;
  // ГУДКИ СРАЗУ: раньше ждали SMTP-отправки call_request (Gmail
  // держит коннект до минуты, ретраи ×3 с паузами) — звонящий сидел
  // в тишине и не понимал, идёт ли звонок. Релей-копия уходит за ~1с
  // (relayPublish в sendCallEnvelope не блокирует), SMTP-письмо —
  // медленный дублирующий канал, пусть идёт в фоне.
  playCallSound(deps, 'outgoing', true);
  try {
    // PQ: kemct/sender_ek из mediaStartOutgoing → в конверт.
    await sendCallEnvelope(deps, peer, {
      type: 'call_request', call_id, sdp: offerSdp,
      kemct: useSession().pendingKemct || undefined,
      sender_ek: useSession().pendingSenderEk || undefined,
    });
    useSession().setPendingKemct(null); useSession().setPendingSenderEk(null);
  } catch (e) {
    console.error('call_request failed:', e);
    hangup(deps, 'error', await callNextState(useSession().callState, 'hung_up'));
    return;
  }
  // (Гудки исходящего уже запущены ДО отправки — см. выше; сюда
  // попадаем только когда сигналы ушли/идут в фоне.)
  // РЕТРАНСЛЯЦИЯ: email-сигнал может потеряться в транзите
  // (SMTP принял без ошибки, но письмо не дошло до Gmail — наблюдали).
  // Приёмник дедупит по call_id (isCallSeen), дубликаты безопасны.
  // Затухающие повторы: [5с, 15с, 45с, 120с] = не больше 4 писем на вызов
  // (было ~20 — каждые 15с все 5 минут; см. SIGNAL_RESEND_DELAYS_MS).
  // Останавливается в hangup/cancelCall/приёме call_accept.
  // Таймер — callRequestResender (createCallResender, call-resend.js).
  callRequestResender.start(
    () => useSession().callState === 'outgoing_ringing' && !!useSession().currentCall
      && useSession().currentCall.call_id === call_id,
    () => sendCallEnvelope(deps, peer, {
      type: 'call_request', call_id, sdp: offerSdp,
      kemct: useSession().pendingKemct || undefined,
      sender_ek: useSession().pendingSenderEk || undefined,
    }, { viaRelay: false }).then(() => {
      useSession().setPendingKemct(null); useSession().setPendingSenderEk(null);
      console.log('[call] call_request retransmitted', call_id);
    })
  );
}

export async function acceptCall(deps) {
  const c = useSession().currentCall;
  if (!c) return;
  if (!(await callCan(useSession().callState, 'accept_incoming'))) return;
  // Ответили — рингтон и таймер отмены в сторону, чайм соединения.
  // stop не нужен: play сам останавливает предыдущий звук.
  ringTimer.stop();
  useSession().setCallRingTimer(null);
  playCallSound(deps, 'connect', false);
  // что вызов жив. Гудим исходящим гудком (зацикленно) до media-connected
  // Задержка 1.2с перед запуском исходящего гудка — даёт время установиться
  // media-каналу (иначе гудок зациклен 3с и слышен артефакт). Fire-and-forget
  // через timing.js → в calls.js нет bare setTimeout (ADR-004 G).
  later(async () => {
    if (!useSession().callMediaConnected
        && await callCan(useSession().callState, 'media_fallback')) {
      playCallSound(deps, 'outgoing', true);
    }
  }, 1200);
  await applyCallState('accepted');
  // S6: звонок принят — снимаем НАТИВНОЕ уведомление и рингтон (экран и звук
  // ведёт приложение). Иначе «Входящий звонок — ответьте в приложении»
  // висело бы всю длительность разговора.
  try { api.mediaDismissIncomingCall(); } catch (e) { /* не критично */ }
  // Фаза 3: сообщаем монитору-владельцу, что звонок принят
  // иначе headless-таймаут поставит missed поверх принятого.
  api.reportCallState(c.call_id, 'accept');
  // Таймер НЕ запускаем: ждём событие call-media-connected
  // из Rust (реальный звук). Предохранитель 120с — см. armMediaFallback.
  useSession().setCallMediaConnected(false);
  armMediaFallback(deps);
  // OFFER В call_request: если offer звонящего пришёл в первом
  // письме — сразу создаём ANSWER и шлём его внутри call_accept. После
  // accept+offer → answer). Fallback (старая версия звонящего без
  // offer): создаём offer сами внутри call_accept.
  try {
    let acceptPayload;
    if (c.offerSdp) {
      const r = await api.mediaAcceptIncoming(c.call_id, c.offerSdp, identityStore.state.peerKeys[c.peer] || '', c.kemct || null, true);
      console.log('[call] caller offer accepted, answer created,', (r.sdp || '').length, 'bytes, sending in call_accept');
      acceptPayload = { type: 'call_accept', call_id: c.call_id, sdp: r.sdp, role: 'answer' };
    } else {
      const r = await api.mediaStartOutgoing(c.call_id, identityStore.state.peerKeys[c.peer] || '', (identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[c.peer]) || null, true);
      console.log('[call] offer (callee fallback) created,', (r.sdp || '').length, 'bytes, sending in call_accept');
      acceptPayload = { type: 'call_accept', call_id: c.call_id, sdp: r.sdp };
    }
    await sendCallEnvelope(deps, c.peer, acceptPayload);
    console.log('[call] call_accept + sdp sent OK');
    // Ретрансляция call_accept: письмо может потеряться
    // тогда звонящий будет гудеть вечно. Повторяем каждые 10с, пока
    // медиа не соединится (stopSignalResend в media-connected/hangup).
    startSignalResend(deps, c.peer, acceptPayload, c.call_id);
  } catch (e) {
    console.error('[call] media start (callee) failed:', e);
    // Медиа не поднялось, но звонок всё равно принимаем — сигнал важнее.
    // показываем ошибку в UI — на Android иначе не
    // увидеть, почему webrtc-rs не поднимает медиа (logcat недоступен).
    uiStore.toast('media start failed: ' + (e && e.message || e), 10000);
    try { await sendCallEnvelope(deps, c.peer, { type: 'call_accept', call_id: c.call_id }); }
    catch (e2) { console.error('call_accept failed:', e2); }
  }
}

export async function rejectCall(deps) {
  const c = useSession().currentCall;
  if (c) {
    // Повтор call_reject — см. sendTerminalRepeat.
    sendTerminalRepeat(deps, c.peer, 'call_reject', c.call_id);
    // Фаза 3: решение монитору-владельцу (нет missed поверх).
    api.reportCallState(c.call_id, 'reject');
  }
  hangup(deps, 'reject', await callNextState(useSession().callState, 'hung_up'));
}

export async function endCall(deps) {
  const c = useSession().currentCall;
  if (c && await callCan(useSession().callState, 'send_dc_hangup')) {
    // «hangup» по WebRTC DataChannel
    // собеседник получает за миллисекунды.
    // email 30-60с, и собеседник сидел с «активным» звонком.
    api.mediaSendHangup(c.call_id);
    // Email-сигнал остаётся как fallback (DC мог не открыться):
    // 3 попытки: сразу, +3с, +7с.
    sendTerminalRepeat(deps, c.peer, 'call_end', c.call_id);
  }
  hangup(deps, 'end', await callNextState(useSession().callState, 'hung_up'));
}

// Локальный сброс состояния (после сигнала, отмены или таймаута).
export async function hangup(deps, reason, nextState) {
  // nextState — решение Rust, вычисленное ВЫЗЫВАЮЩИМ (до входа в hangup).
  // Почему не здесь: hangup — fire-and-forget (см. комментарий в cancelCall),
  // и await внутри сдвинул бы сброс состояния на микротаск — появилась бы
  // гонка: новая машина состояний успевала бы начать звонок, пока старое
  // состояние ещё не сброшено. Поэтому решение считается ДО, а сброс —
  // синхронно, как было.
  // Видео гасим ЗДЕСЬ, а не только в UI-пути App.vue: раньше внутренние
  // вызовы (отклонение/таймаут/ошибка собеседника) оставляли камеру включённой
  // — это приватность, а не косметика.
  if (deps.stopVideo) deps.stopVideo();
  const c = useSession().currentCall;
  const callId = c ? c.call_id : null;
  // Состояние звонка — из ТАБЛИЦЫ ОТВЕТОВ ЯДРА (ADR-005 R1 / W4). Здесь
  // await недопустим: hangup — fire-and-forget, и await внутри сдвинул бы
  // сброс состояния на микротаск (гонка: новая машина состояний успела бы
  // начаться, пока старая ещё не сброшена). Таблица приходит одним вызовом и
  // не протухает — ответ зависит только от состояния.
  const wasActive = canCached(useSession().callState, 'call_active');
  const wasIncoming = canCached(useSession().callState, 'call_incoming_ringing');
  const wasOutgoing = canCached(useSession().callState, 'call_outgoing_ringing');
  console.log('[call] hangup', reason, 'call_id=' + callId, 'state=' + useSession().callState);
  // Снять full-screen уведомление входящего: любой исход
  // (принят/отклонён/таймаут/завершён) гасит системный звонок.
  api.mediaDismissIncomingCall();
  // «пилюлей» (Пропущенный звонок / Нет ответа / Звонок завершён · 03:24).
  // fire-and-forget: hangup не ждёт sqlite.
  if (c && callId) {
    const dur = wasActive ? useSession().callClockSec : 0;
    let kind = null;
    if (wasActive) {
      kind = 'ended';
    } else if (wasIncoming) {
      if (reason === 'reject') kind = 'declined';
      else if (reason === 'timeout' || reason === 'remote'
          || reason === 'remote_late' || reason === 'preempt') kind = 'missed';
    } else if (wasOutgoing) {
      if (reason === 'timeout') kind = 'no_answer';
      // Письмо-вызов отбито провайдером (DSN/bounce): до собеседника НЕ
      // дошло ничего — отдельная пилюля, а не «нет ответа» (12.10.2026).
      else if (reason === 'bounce') kind = 'undeliverable';
      else if (reason === 'remote_reject') kind = 'declined';
      // call_cancel от собеседника = у него сгорел таймер гудка → нет ответа.
      else if (reason === 'remote' || reason === 'remote_late') kind = 'no_answer';
      else if (reason === 'cancel') kind = 'canceled';
    }
    if (kind) recordCallEvent(deps, c.peer, kind, Date.now(), dur, callId);
  }
  ringTimer.stop();
  useSession().setCallRingTimer(null);
  // Ретрансляция call_request — тоже останавливаем (callRequestResender).
  callRequestResender.stop();
  // Ретрансляция call_accept/answer (callResender).
  stopSignalResend(deps);
  // Предохранитель «Соединение…» (watchdog 90с — owner mediaWatchdog).
  mediaWatchdog.stop();
  // Grace-таймер ICE disconnected (fire-and-forget из timing.js).
  if (useSession().connLostTimer) { connLostGuard.clear(); useSession().setConnLostTimer(null); }
  useSession().stopCallClock();
  // Фаза 3: сообщаем монитору-владельцу исход звонка, чтобы
  // headless-логика не ставила missed поверх реального решения.
  if (callId) {
    const st = (wasIncoming && (reason === 'reject' || reason === 'timeout'
      || reason === 'cancel' || reason === 'preempt')) ? 'rejected'
      : 'ended';
    api.reportCallState(callId, st);
  }
  // По умолчанию — «отбой → idle». Это ровно то, что вернёт Rust для события
  // 'hung_up' (правило в ядре); значение-запасной на случай, если вызывающий
  // не передал решение (прямой вызов). Синхронно — гонки нет.
  useSession().setCallState(nextState || 'idle');
  useSession().setCurrentCall(null);
  useSession().setMuted(false);
  useSession().setSpeaker(false);
  useSession().setCallMediaConnected(false);
  stopFastPolling();
  // Финальный звук: play сам останавливает предыдущий поток
  // (Rust/HTML5), поэтому отдельный stop перед play не вызываем —
  // только если звука не будет вовсе.
  if (wasActive) {
    playCallSound(deps, 'end', false);
  } else if (wasIncoming && (reason === 'timeout' || reason === 'reject'
      || reason === 'cancel' || reason === 'remote' || reason === 'preempt')) {
    playCallSound(deps, 'missed', false);
  } else if (wasOutgoing && (reason === 'remote' || reason === 'timeout')) {
    // Звонящий: собеседник отклонил/отменил или гудки сгорели — отбой.
    playCallSound(deps, 'end', false);
  } else {
    stopCallSound(deps);
  }
  // Фаза 2: закрываем медиа-канал (webrtc-rs PeerConnection).
  if (callId) {
    try { await api.mediaClose(callId); } catch (e) { /* ignore */ }
  }
}

export async function cancelCall(deps, reason) {
  const c = useSession().currentCall;
  // таймер гудка (ringing)
  // может сработать ПОЗЖЕ, чем call_accept дошёл по почте (SMTP с
  // Android + доставка + IMAP ≈ 90-180с). Если звонок уже active —
  // НЕ рвём живой звонок.
  if (reason === 'timeout' && await callCan(useSession().callState, 'ignore_stale_timeout')) {
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
    // Тип терминального сигнала — решение протокола (в Rust): у собеседника в
    // истории «разговор был» (call_end) и «звонок сорвался» (call_cancel) —
    // разные вещи.
    const type = await hangupSignalKind(useSession().callState);
    sendTerminalRepeat(deps, c.peer, type, c.call_id);
  }
  hangup(deps, reason || 'cancel', await callNextState(useSession().callState, 'hung_up'));
}

// ── Отбой письма (DSN/bounce): гасим висящий исходящий вызов ──────────
// Инцидент 12.10.2026: провайдер отбил письмо-вызов («554 5.7.1 Message
// rejected under suspicion of SPAM»), а приложение этого не знало и
// продолжало «звонить»: 5 минут гудков и «нет ответа» у пользователя.
// Разбор DSN — features/bounce.js, здесь только реакция на него.
//
// ВАЖНО (дефект того же фикса, найден на живом звонке 12.10.2026): почта —
// ДУБЛИРУЮЩИЙ канал (см. sendCallEnvelope: релей-копия уходит первой и не
// блокирует SMTP). Когда релей уже принял конверт, баунс почты НИЧЕГО не
// доказывает: собеседник получил сигнал релеем и видит вызов на экране.
// Гасить такой вызов нельзя — иначе отбой ПОЧТОВОЙ копии убивает звонок в
// самом базовом случае (приложение открыто). Поэтому: relayDelivered →
// баунс игнорируем.
//
// recipients: адреса, которым НЕ доставили (может быть пусто — неизвестный
// формат). reason: текст ошибки SMTP (для тоста и логов).
export async function onMailBounce(deps, recipients = [], reason = '') {
  const c = useSession().currentCall;
  // Реагируем только на ВИСЯЩИЙ ИСХОДЯЩИЙ вызов: живой разговор отбой
  // письма не касается, входящий звонок — тем более.
  if (!c) return false;
  if (!(await callCan(useSession().callState, 'cancel_outgoing'))) return false;
  // Релей уже доставил этот сигнал (call.relayDelivered, см. sendCallEnvelope).
  // DSN относится только к почтовому дублю — вызов живёт, ждём ответа.
  if (c.relayDelivered) {
    console.log('[call] bounce ignored — call already delivered via relay:', c.call_id);
    return false;
  }
  const canon = (v) => {
    try { return String(deps.canonicalOf(v) || v || '').toLowerCase(); }
    catch (e) { return String(v || '').toLowerCase(); }
  };
  const peer = canon(c.peer);
  if (!peer) return false;
  // Адресат баунса обязан совпасть с собеседником звонка. Если адрес
  // распознать не удалось (незнакомый провайдер, нестандартный DSN) — НЕ
  // гасим: ложная отмена живого вызова хуже, чем лишние минуты гудков.
  const hit = (recipients || []).some(r => canon(r) === peer);
  if (!hit) {
    console.log('[call] bounce not for current peer: ' + ((recipients || []).join(',') || '?'));
    return false;
  }
  console.warn('[call] bounce for', peer, '→ отменяем исходящий вызов:', reason || 'undeliverable');
  try {
    const msg = uiStore.tr('call_undeliverable_toast', { reason: reason || peer })
      || ('Письмо не доставлено: ' + (reason || peer));
    uiStore.toast(msg, 6000);
  } catch (e) { /* тост не критичен */ }
  // cancelCall: шлём собеседнику call_cancel (если он всё-таки получил
  // конверт релеем) и записываем пилюлю 'undeliverable'.
  await cancelCall(deps, 'bounce');
  return true;
}

// ── Пропущенные вызовы (пилюли) ────────────────────────────────
// пропущенный/нет ответа/отклонён/завершён + время + кнопка «Перезвонить».
// Пилюля — обычное сообщение с полем callEvent; персистится в sqlite
// вместе с историей (saveCurrentHistory) и в chat-cache (slim-маппер
// сохраняет callEvent). Текст рендерится через t() — язык из настроек.
export async function recordCallEvent(deps, peer, kind, ts, durationSec, callId) {
  if (!peer || !callId) return;
  const chatKey = deps.canonicalOf(peer) || peer;
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
  const exists = deps.chat.state.messages.some(m => m && m.id === msg.id);
  if (!exists && chatStore.state.activeChat === chatKey && chatStore.state.activeChatType === 'chat') {
    deps.chat.append(msg);
    deps.chat.sortBy((a, b) => deps.msgTs(a) - deps.msgTs(b));
    deps.saveCurrentHistory(chatKey);
    deps.saveChatCache(chatKey, deps.chat.state.messages);
    uiStore.scrollToBottom(true);
  } else if (!exists) {
    // Чат не открыт — дописываем пилюлю в сохранённую историю напрямую,
    // чтобы она появилась при следующем открытии чата.
    try {
      // Нулевая история (чат ещё не открывали) — тоже валидный случай:
      // раньше Array.isArray(null)===false молча глотал ПЕРВУЮ пилюлю
      // «Пропущенный звонок» свежего чата.
      const hist = (await loadHistory(sessionStore.getCurrentEmail(), chatKey)) || [];
      if (!hist.some(m => m && m.id === msg.id)) {
        hist.push(msg);
        hist.sort((a, b) => deps.msgTs(a) - deps.msgTs(b));
        await saveHistory(sessionStore.getCurrentEmail(), chatKey, hist);
      }
    } catch (e) { /* sqlite недоступен — не критично */ }
  }
  // Бейдж непрочитанных: пропущенный входящий — как непрочитанное
  // сообщение, если чат сейчас не виден.
  if (kind === 'missed' && !deps.chatVisible(chatKey)) {
    deps.incUnread(chatKey);
    await deps.saveUnreadCounts();
  }
}

export function callEventLabel(t, msg) {
  const ev = msg && msg.callEvent;
  if (!ev) return '';
  const key = {
    missed: 'call_missed',
    no_answer: 'call_no_answer',
    declined: 'call_declined',
    canceled: 'call_canceled',
    ended: 'call_ended',
    undeliverable: 'call_undeliverable',
  }[ev.kind] || 'call_missed';
  let label = t(key);
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

// ADR-001: зависимости перечислены в сигнатуре, а не берутся из ctx.
// Функция физически не может задеть поле, которого здесь нет.
export function canCallBack({ expCalls, callState, activeChatType, peerKeys, activeChat }, msg) {
  // Перезвонить можно, если звонков нет и у собеседника есть ключ.
  // «Звонков нет» — решение ядра (call_state::can / can_call_back), прочитанное
  // из кэша таблицы: шаблон компонента вызывает эту функцию синхронно.
  return !!(msg && msg.callEvent && expCalls
      && canCached(callState, 'can_call_back')
      && activeChatType === 'chat'
      && peerKeys[activeChat]);
}

export function callBack(deps) {
  startCall(deps);
}

// ── Микрофон/динамик ───────────────────────────────────────────
// Микрофон звонка (в конфликте ключей с чат-меню «Без звука» — то
// отдельный метод ниже; Options API не терпит дублей имён).
// ADR-001: переключатели возвращают НОВОЕ значение, а не пишут в ctx.
// Мутация состояния — на стороне App.vue: так видно, что состояние
// принадлежит компоненту, а фича его только вычисляет.
// deps: { callMuted(), currentCall(), setMuted(v) } — состояние звонка у
// владельца call-session, поэтому «переключатель» сам и пишет в него.
export function toggleCallMute(deps) {
  const muted = !deps.callMuted();
  const c = deps.currentCall();
  if (c) {
    api.mediaSetMuted(c.call_id, muted)
      .catch((e) => console.error('[call] set muted failed:', e));
  }
  deps.setMuted(muted);
  return muted;
}

// Динамик: Android — speakerphone (earpiece ↔ динамик)
// desktop — no-op в Rust (вывод и так на динамики).
// deps: { callSpeaker(), currentCall(), setSpeaker(v) }
export function toggleSpeaker(deps) {
  const speaker = !deps.callSpeaker();
  const c = deps.currentCall();
  if (c) {
    api.mediaSetSpeaker(c.call_id, speaker)
      .catch((e) => console.error('[call] set speaker failed:', e));
  }
  deps.setSpeaker(speaker);
  return speaker;
}

// ── Ретрансляция критичных сигналов ────────────────────────────
// РЕТРАНСЛЯЦИЯ КРИТИЧНЫХ СИГНАЛОВ: call_accept и SDP-answer
// повторяются каждые 10с, пока медиа не соединится или звонок не
// завершится. Email-письма теряются в транзите (наблюдали: call_accept
// сбрасывается»). Дубликаты безопасны: приёмник игнорирует их по
// состоянию (call_accept — только в outgoing_ringing, call_sdp —
// только в active с тем же call_id).
export function startSignalResend(deps, peer, payload, call_id) {
  if (!useSession().currentCall || useSession().currentCall.call_id !== call_id) return;
  // Таймер/попытки — callResender (createCallResender, call-resend.js).
  // shouldContinue гасит ресенд при смене звонка/call_state/media-connected.
  // Предикат продолжения ресенда — асинхронный: «идёт ли разговор» решает
  // ядро (call_state::can / CallQuestion::CallActive), а мост асинхронен.
  // Сам ресендер и так вызывает предикат из async-таймера, поэтому ожидание
  // здесь не меняет порядок событий.
  callResender.start(
    async () => useSession().currentCall && useSession().currentCall.call_id === call_id
      && await callCan(useSession().callState, 'call_active') && !useSession().callMediaConnected,
    // Релей-копия уже доставлена первым отправлением — повтор только
    // почтой (лимит + лишние пуши).
    () => sendCallEnvelope(deps, peer, payload, { viaRelay: false })
      .then(() => console.log('[call] signal retransmitted:', payload.type, call_id))
  );
}

export function stopSignalResend(deps) {
  callResender.stop();
}

// Повтор терминального сигнала (call_end/call_cancel/call_reject):
// если письмо потеряется, собеседник останется с поднятой трубкой
// навсегда. Ещё 2 попытки через 3с и 7с (fire-and-forget). Дубликаты
// у приёмника безопасны (ветка remote_late / guard по state).
export function sendTerminalRepeat(deps, peer, type, call_id) {
  // ПЕРВОЕ отправление — и в релей, и почтой. Раньше здесь стоял
  // viaRelay:false с комментарием «релей-копия ушла первым отправлением»,
  // но первого отправления через релей НЕ БЫЛО вообще: все три попытки
  // шли только почтой, и собеседник продолжал гудеть/держать трубку
  // 15-60с (жалоба: «на десктопе долго идут гудки после отбоя на
  // телефоне»). wake=false и так стоит — терминальный сигнал не должен
  // поднимать уведомление на том конце.
  sendCallEnvelope(deps, peer, { type, call_id }).catch(() => {});
  // Повторы — только почтой: релей-копия уже лежит в очереди получателя,
  // повтор на релей жёг бы суточный лимит издателя.
  terminalSender.repeat(3000, () => sendCallEnvelope(deps, peer, { type, call_id }, { viaRelay: false }).catch(() => {}));
  terminalSender.repeat(7000, () => sendCallEnvelope(deps, peer, { type, call_id }, { viaRelay: false }).catch(() => {}));
}

// ── Watchdog + часы ────────────────────────────────────────────
// Watchdog «Соединение…»: если через 90с после accept медиа
// не соединилось (событие call-media-connected не пришло) — звонок не
// состоялся: accept/answer потерялись в почте или собеседник уже ушёл.
// красной кнопкой висел вечно. Теперь кладём трубку сами.
// Watchdog 90с на media-connect (owner mediaWatchdog). Timer id кладётся в
// useSession().mediaFallbackTimer — штатное завершение (hangup) гасит его
// через mediaWatchdog.stop() (см. hangup выше).
const mediaWatchdog = createMediaWatchdog();

export function armMediaFallback(deps) {
  // Таймаут срабатывает в колбэке (не async) — решение Rust здесь взять не
  // можно, поэтому состояние сбрасываем по ПРАВИЛУ «отбой → idle», а сам
  // факт («звонок идёт») проверяем через can() до входа в колбэк.
  const onTimeout = async () => {
    if (useSession().callMediaConnected) return;
    if (!(await callCan(useSession().callState, 'media_fallback'))) return;
    console.warn('[call] media not connected in 90s — auto hangup');
    uiStore.toast(uiStore.tr('call_connect_failed'), 4000);
    // Сообщаем собеседнику, чтобы у него тоже легла трубка
    // (он может висеть в таком же «Соединение…»).
    const c = useSession().currentCall;
    if (c) sendTerminalRepeat(deps, c.peer, 'call_end', c.call_id);
    hangup(deps, 'connect_timeout', await callNextState(useSession().callState, 'hung_up'));
  };
  useSession().setMediaFallbackTimer(mediaWatchdog.start(onTimeout));
}

// Быстрый путь сигнализации (Фаза 1.5): IDLE постоянный — его владеет
// Rust-монитор, а таймер страховочного фетча (СПАМ/звонки) поднимает
// idleLoop. Здесь только гарантия, что режим приёма включён: при
// поднятом мониторе idleLoop — no-op (без нового TCP+TLS), при
// погашенном эко — поднимет заново.
export function startFastPolling(idleLoop, monitorUp = false) {
  // ADR-004 H: владелец fast-fetch — call-idle.js/fastFetcher (singleton).
  // Rust-монитор (callIdleMonitorUp) держит постоянный IDLE — если вниз,
  // страховочный фетч каждые 7с (СПАМ + сигналы звонков); busy-флаг
  // защищает от наложения (аналог бывшего _fastFetchBusy).
  if (monitorUp) { idleLoop(); return; }
  fastFetcher.start(idleLoop);
}

export function stopFastPolling() {
  fastFetcher.stop();
}

// ── Звук ───────────────────────────────────────────────────────
// (ДОЛЖНЫ быть в methods, НЕ в computed. В computed Vue 3 превращает
// их в геттеры: this.playCallSound(...) вызывает тело БЕЗ аргументов,
// и this.isAndroid() бросает TypeError. Синхронный бросок рвал
// acceptCall ДО отправки call_accept. Плюс: функция НИКОГДА не
// должна бросать — звук вторичен, сигнализация звонка важнее.)
export function playCallSound(deps, name, looped) {
  try {
    // Настройки звонков: пользователь мог выбрать другой рингтон
    // (Настройки → Звонки). Маппим incoming/outgoing на выбранный вариант.
    const ringIn = useSession().callRingtoneIncoming || 'incoming';
    const ringOut = useSession().callRingtoneOutgoing || 'outgoing';
    if (name === 'incoming') name = ringIn;
    else if (name === 'outgoing') name = ringOut;
    if (deps.isAndroid()) {
      stopCallSound(deps);
      const el = new Audio('/sounds/ring_' + name + '.wav');
      el.loop = !!looped;
      el.volume = 0.85;
      el.play().catch(e => console.warn('[call] sound play failed:', e));
      useSession().setSoundEl(el);
      // Одноразовые звуки: освобождаем элемент по окончании.
      if (!looped) {
        el.onended = () => { if (useSession().callSoundEl === el) useSession().setSoundEl(null); };
      }
    } else {
      api.mediaSoundPlay(name, !!looped).catch(e => console.warn('[call] sound play failed:', e));
    }
  } catch (e) {
    // Звук не критичен — глотаем, чтобы не рвать state machine звонка.
    console.warn('[call] sound failed:', e && e.message || e);
  }
}

export function stopCallSound(deps) {
  try {
    if (useSession().callSoundEl) {
      try { useSession().callSoundEl.pause(); } catch (_) {}
      useSession().setSoundEl(null);
    }
    if (!deps.isAndroid()) {
      api.mediaSoundStop().catch(() => {});
    }
  } catch (e) {
    console.warn('[call] sound stop failed:', e && e.message || e);
  }
}
