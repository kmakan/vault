// Адаптер над ПРАВИЛОМ состояния звонка (Rust).
//
// ADR-005 R1 / W4 (`t_821261f7`): решение о протоколе — в Rust. Этот файл —
// тонкий мост: он НЕ решает «занято ли» и «какой сигнал уходит при отбое», а
// зовёт ядро.
//
// Почему примитив, а не features/: правило нужно и машине звонков
// (features/calls.js), и релею (features/relay.js), и UI. Транспорт живёт вне
// features/* — как src/ephemeral-rule.js и src/channels-tokens.js.
//
// ОТКАЗ МОСТА НЕ ПРОПАДАЕТ МОЛЧА (как в W1-классификаторе и в TTL-адаптере):
// сообщаем в консоль и откатываемся к БЕЗОПАСНОМУ варианту. Что безопасно —
// решено по месту:
//   * состояние не меняем (лучше «звонок не начался», чем «начался и сорвался»);
//   * входящий запрос игнорируем (не отвечаем «занято» на пустом месте);
//   * тип отбоя — call_cancel (в истории собеседника «звонок сорвался» лучше,
//     чем «разговор был»);
//   * исходящий звонок НЕ начинаем (не знаем состояние — не звоним);
//   * поздний таймаут гудка ИГНОРИРУЕМ: инцидент 12.10.2026 — таймер, успев
//     позже `call_accept`, рвал ЖИВОЙ разговор. Обрезать живой разговор —
//     хуже, чем оставить «висящий» таймер.
import { invoke } from '@tauri-apps/api/core';

function report(what, e) {
  console.error('[call-state] Rust-правило недоступно (' + what + '):', e && e.message || e);
}

// Следующее состояние по событию ('request_received' | 'accepted' |
// 'hung_up' | 'ring_timeout' | 'preempted'). При отказе — состояние не меняется.
export async function callNextState(current, event) {
  try {
    return await invoke('vault_call_next_state', { current, event });
  } catch (e) {
    report('next_state', e);
    return current;
  }
}

// Правило «можно ли» — одним вопросом ядру ('arm_ring_timer' | 'start_outgoing' |
// 'accept_incoming' | 'accept_outgoing' | 'cancel_outgoing' | 'send_dc_hangup' |
// 'can_call_back' | 'ignore_stale_timeout' | 'apply_sdp' | 'media_fallback').
export async function can(state, question) {
  try {
    return await invoke('vault_call_can', { current: state, question });
  } catch (e) {
    report('can/' + question, e);
    return false;
  }
}

// Применим ли переход в текущем состоянии. JS не сравнивает состояния сам —
// это тоже решение о протоколе, и оно живёт в Rust рядом с остальными.
export async function canApply(current, event) {
  try {
    return await invoke('vault_call_can_apply', { current, event });
  } catch (e) {
    report('can_apply', e);
    return false;
  }
}

// Что делать с входящим запросом: 'accept' | 'ignore' | 'busy' | 'preempt'.
// sameCall — тот же call_id (повтор запроса, а не новый звонок).
export async function incomingRequestAction(current, sameCall, hasCurrent) {
  try {
    return await invoke('vault_call_incoming_action', { current, same_call: sameCall, has_current: hasCurrent });
  } catch (e) {
    report('incoming_action', e);
    return 'ignore';
  }
}

// Тип терминального сигнала при отбое: 'call_end' | 'call_cancel'.
export async function hangupSignalKind(state) {
  try {
    return await invoke('vault_call_hangup_signal_kind', { state });
  } catch (e) {
    report('hangup_kind', e);
    return 'call_cancel';
  }
}

// Можно ли начинать исходящий звонок из этого состояния.
export async function canStartOutgoing(state) {
  try {
    return await invoke('vault_call_can_start', { state });
  } catch (e) {
    report('can_start', e);
    return false;
  }
}

// Игнорировать ли «поздний» таймаут гудка (звонок уже идёт).
export async function ignoreStaleRingTimeout(state) {
  try {
    return await invoke('vault_call_ignore_stale_ring_timeout', { state });
  } catch (e) {
    report('stale_timeout', e);
    return true;
  }
}
