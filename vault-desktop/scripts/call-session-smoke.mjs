// call-session-smoke — валидация владельца состояния звонка (Этап C).
// C1-C19 (17 READ + 5 WRITE + subscribe + reset + seed).
import { createCallSession } from '../src/features/call-session.js';

const checks = [];
const ok = (n, cond) => checks.push({ n, pass: !!cond });

const s = createCallSession();

// C1: начальный idle
ok('C1 seed callState idle', s.callState === 'idle');
ok('C1 seed callClockSec 0', s.callClockSec === 0);
ok('C1 seed callMuted false', s.callMuted === false);
ok('C1 seed currentCall null', s.currentCall === null);
ok('C1 seed lastCallId null', s.lastCallId === null);

// C2: initial seed
const seeded = createCallSession({ callState: 'ringing', callClockSec: 5 });
ok('C2 seed override callState', seeded.callState === 'ringing');
ok('C2 seed override callClockSec', seeded.callClockSec === 5);

// C3: WRITE мутируют + notify
let n = 0;
const unsub = s.subscribe(() => n++);
s.setCurrentCall({ call_id: 'c1' });
s.setCallState('outgoing');
s.setCallClockSec(10);
s.setMuted(true);
s.setSpeaker(true);
s.setLastCallId('c1');
ok('C3 5 writes currentCall', s.currentCall && s.currentCall.call_id === 'c1');
ok('C3 5 writes callState', s.callState === 'outgoing');
ok('C3 5 writes callClockSec', s.callClockSec === 10);
ok('C3 5 writes muted', s.callMuted === true);
ok('C3 5 writes speaker', s.callSpeaker === true);
ok('C3 notify fired on each write', n === 6);

// C4: setRingtone incoming/outgoing
s.setRingtone('incoming', 'tone-a');
s.setRingtone('outgoing', 'tone-b');
ok('C4 ringtone incoming', s.callRingtoneIncoming === 'tone-a');
ok('C4 ringtone outgoing', s.callRingtoneOutgoing === 'tone-b');

// C4b: timers / refs через mutаторы (plain values — не reactivity)
s.setCallClockTimer(99);
s.setCallRingTimer(77);
s.setSoundEl({ play: () => {} });
s.setCallMediaConnected(true);
s.setPendingKemct('kem');
s.setPendingSenderEk('ek');
s.setMediaFallbackTimer(33);
s.setConnLostTimer(44);
s.setSendSeen(true);
s.setOffers({ local: 'local-o' });
ok('C4b callClockTimer', s.callClockTimer === 99);
ok('C4b callRingTimer', s.callRingTimer === 77);
ok('C4b soundEl', s.callSoundEl && s.callSoundEl.play);
ok('C4b callMediaConnected', s.callMediaConnected === true);
ok('C4b pendingKemct', s.pendingKemct === 'kem');
ok('C4b pendingSenderEk', s.pendingSenderEk === 'ek');
ok('C4b mediaFallbackTimer', s.mediaFallbackTimer === 33);
ok('C4b connLostTimer', s.connLostTimer === 44);
ok('C4b sendSeen', s.sendSeen === true);
ok('C4b localOffer', s.localOffer === 'local-o');

// C5: this.state реактивность (plain) — write through api, read через .state
s.state.callState = 'connected';
ok('C5 direct state.write reads through api', s.callState === 'connected');

// C6: reset
s.reset();
ok('C6 reset callState idle', s.callState === 'idle');
ok('C6 reset callClockSec 0', s.callClockSec === 0);
ok('C6 reset currentCall null', s.currentCall === null);
ok('C6 reset callMuted false', s.callMuted === false);
ok('C6 reset sendSeen false', s.sendSeen === false);
ok('C6 reset localOffer null', s.localOffer === null);

// C7: subscribe/unsubscribe
unsub();
let m = 0;
const off = s.subscribe(() => m++);
s.setCallState('ringing');
off();
s.setCallState('ended');
ok('C7 unsubscribe stops notify', m === 1);

// C8: _all snapshot (test helper)
ok('C8 _all deep clone', JSON.stringify(s._all()).includes('callState'));

// C9: часы — тик владельца (ADR-004 E)
let ticks = 0;
const h = s.startCallClock(() => ticks++);
ok('C9 startCallClock возвращает хендл', !!h);
ok('C9 startCallClock сбрасывает callClockSec 0', s.callClockSec === 0);
ok('C9 startCallClock запоминает callClockTimer', s.callClockTimer === h);
// реальный node setInterval (в этом smoke нет мока) → 1 tick за ~1.2с
await new Promise((r) => setTimeout(r, 1200));
ok('C9 тик инкрементит callClockSec', s.callClockSec === 1);
ok('C9 onTick вызван', ticks === 1);
s.stopCallClock();
ok('C9 stopCallClock очищает callClockTimer', s.callClockTimer === null);

const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass);
console.log(`call-session-smoke: ${passed}/${checks.length} checks passed`);
if (failed.length) {
  console.error('FAIL:', failed.map((c) => c.n));
  process.exit(1);
}
