// Тестовый двойник ПРАВИЛА состояния звонка (Rust) для node-смоуков.
//
// Зачем он, если правило живёт в Rust: смоук проверяет ПРОВОДКУ (что JS
// зовёт мост и действует по ответу), а не сами правила — их проверяют
// юнит-тесты ядра (vault-client/src/vault/call_state.rs, 11 тестов).
//
// ТАБЛИЦА ДОЛЖНА СОВПАДАТЬ с Rust. Расхождение здесь не сломает прод (прод
// зовёт Rust), но сделает смоук слепым к изменению правил: при правке Rust
// нужно править и эту таблицу. Это осознанный размен: мок — источник правды
// для JS-проверок, Rust — для протокола.
export function installCallStateMock(invokeMock) {
  const STATES = ['idle', 'outgoing_ringing', 'incoming_ringing', 'active'];
  const norm = (s) => (STATES.includes(s) ? s : 'idle');

  // Событие → следующее состояние (None = не меняется).
  function nextState(current, event) {
    switch (event) {
      case 'request_received': return 'incoming_ringing';
      case 'outgoing_started': return 'outgoing_ringing';
      case 'accepted': return 'active';
      case 'hung_up':
      case 'ring_timeout':
      case 'preempted': return 'idle';
      default: return current;
    }
  }

  // Что делать с входящим запросом.
  function incomingAction(current, sameCall, hasCurrent) {
    if (sameCall) return 'ignore';
    if (current === 'idle') return 'accept';
    if (hasCurrent) return 'busy';
    if (current === 'active') return 'ignore';
    return 'preempt';
  }

  // Правило «можно ли».
  function can(current, question) {
    switch (question) {
      case 'arm_ring_timer': return current === 'incoming_ringing';
      case 'start_outgoing':
      case 'can_call_back': return current === 'idle';
      case 'accept_incoming': return current === 'incoming_ringing';
      case 'accept_outgoing':
      case 'cancel_outgoing': return current === 'outgoing_ringing';
      case 'send_dc_hangup':
      case 'ignore_stale_timeout':
      case 'apply_sdp':
      case 'media_fallback': return current === 'active';
      default: return false;
    }
  }

  const prev = invokeMock;
  invokeMock = async (cmd, args) => {
    switch (cmd) {
      case 'vault_call_next_state':
        return nextState(norm(args.current), args.event);
      case 'vault_call_incoming_action':
        return incomingAction(norm(args.current), !!(args.same_call ?? args.sameCall), !!(args.has_current ?? args.hasCurrent));
      case 'vault_call_hangup_signal_kind':
        return norm(args.state) === 'active' ? 'call_end' : 'call_cancel';
      case 'vault_call_can':
        return can(norm(args.current ?? args.state), args.question);
      case 'vault_call_can_apply': {
        const st = norm(args.current);
        switch (args.event) {
          case 'request_received': return st === 'idle';
          case 'accepted': return st === 'incoming_ringing' || st === 'outgoing_ringing';
          case 'hung_up': return true;
          case 'ring_timeout': return st !== 'active';
          case 'preempted': return st === 'incoming_ringing' || st === 'outgoing_ringing';
          default: return false;
        }
      }
      default:
        return prev ? prev(cmd, args) : null;
    }
  };
  return invokeMock;
}
