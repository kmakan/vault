<template>
  <div class="call-overlay" :class="'call-' + state">
    <!-- Фоновое свечение (индиго Vault) -->
    <div class="call-glow" aria-hidden="true"></div>

    <!-- Подсказка свайпа для входящего -->
    <div v-if="state === 'incoming_ringing' && !dragging" class="call-swipe-hint">
      <span class="swipe-hint-l">{{ texts.rejectHint }}</span>
      <span class="swipe-hint-r">{{ texts.acceptHint }}</span>
    </div>

    <div class="call-panel" :style="panelShiftStyle">
      <!-- Аватар + пульсирующие кольца при дозвоне -->
      <div class="call-avatar-wrap">
        <template v-if="state === 'incoming_ringing' || state === 'outgoing_ringing'">
          <span class="pulse-ring pr-1" :class="state === 'incoming_ringing' ? 'pr-in' : 'pr-out'"></span>
          <span class="pulse-ring pr-2" :class="state === 'incoming_ringing' ? 'pr-in' : 'pr-out'"></span>
          <span class="pulse-ring pr-3" :class="state === 'incoming_ringing' ? 'pr-in' : 'pr-out'"></span>
        </template>
        <div class="call-avatar" :class="{ 'avatar-active': state === 'active' }">
          <UserAvatar :email="peer" :avatarUrl="avatarUrl" :size="96" />
        </div>
      </div>

      <div class="call-name">{{ peerName }}</div>

      <div class="call-status">
        <template v-if="state === 'incoming_ringing'">{{ texts.incoming }}</template>
        <template v-else-if="state === 'outgoing_ringing'">{{ texts.outgoing }}</template>
        <template v-else-if="state === 'active'">
          <!-- 27.08: таймер — только когда реально пошёл звук (событие
               call-media-connected из Rust). До этого — «Соединение…»:
               SDP идёт по почте до минуты, и пользователь раньше видел
               работающий таймер при полной тишине. -->
          <template v-if="mediaConnected">
            <span class="call-timer">{{ elapsed }}</span>
            <span class="call-secure"><Icon name="lock" :size="11" color="#4ade80" />&nbsp;E2E</span>
          </template>
          <span v-else class="call-connecting">{{ texts.connecting }}</span>
        </template>
      </div>

      <!-- Голосовая волна в активном разговоре (только когда звук идёт) -->
      <div v-if="state === 'active' && mediaConnected" class="call-wave" aria-hidden="true">
        <span v-for="i in 5" :key="i" class="wave-bar" :style="{ animationDelay: (i * 0.12) + 's' }"></span>
      </div>
    </div>

    <!-- Нижняя панель действий -->
    <div class="call-controls">
      <!-- Входящий: золотая трубка + шевроны-подсказки в обе стороны.
           Зажми и тяни вправо — зеленеет (принять), влево — краснеет
           (отклонить). После отпускания трубка возвращается в ЦЕНТР,
           но ОСТАЁТСЯ выбранного цвета до конца звонка/сброса состояния. -->
      <template v-if="state === 'incoming_ringing'">
        <div class="call-drag-row">
          <transition name="hintfade">
            <span v-if="!dragging && orbX === 0 && !decision" class="drag-hint hint-left">
              <Icon name="double-chevron-left" :size="20" color="#f87171" />
              <Icon name="double-chevron-left" :size="14" color="#f87171" />
            </span>
          </transition>
          <button
            ref="orbEl"
            class="call-orb"
            :class="[decision ? 'decision-' + decision : 'call-orb-gold', dragClass]"
            :style="{ transform: `translateX(${orbX}px)` }"
            :title="texts.accept + ' / ' + texts.reject"
            @pointerdown="onDragStart"
            @pointermove="onDragMove"
            @pointerup="onDragEnd"
            @pointercancel="onDragEnd"
          >
            <Icon name="phone" :size="26" color="#ffffff" />
          </button>
          <transition name="hintfade">
            <span v-if="!dragging && orbX === 0 && !decision" class="drag-hint hint-right">
              <Icon name="double-chevron-right" :size="14" color="#4ade80" />
              <Icon name="double-chevron-right" :size="20" color="#4ade80" />
            </span>
          </transition>
        </div>
      </template>

      <!-- Исходящий (28.08): КРАСНАЯ пилюля отмены с обычной трубкой —
           как у активного звонка, единый стиль. Раньше была жёлтая
           кнопка с перечёркнутой трубкой (phone-off) — пользователь
           просил убрать перечёркивание. -->
      <template v-else-if="state === 'outgoing_ringing'">
        <div class="call-control-row">
          <button class="call-end-pill" :title="texts.cancel" @click="$emit('cancel')">
            <Icon name="phone" :size="26" />
          </button>
        </div>
        <div class="call-waiting-hint">{{ texts.outgoing }}</div>
      </template>

      <!-- Активный (27.08, редизайн): ОДИН ряд — микрофон | большая красная
           «завершить» | динамик. Раньше были зелёная трубка-индикатор +
           красная + нижний ряд mute/record — пользователь жаловался на
           «некрасивые кнопки» и отсутствие динамика. Запись убрана из
           оверлея (не реализована в пайплайне). -->
      <template v-else-if="state === 'active'">
        <!-- Соединение (28.08): ЗЕЛЁНЫЙ орб «принято» — визуальное
             продолжение свайпа (золотой → зелёный = звонок принят, идёт
             соединение). Раньше здесь сразу появлялась КРАСНАЯ пилюля —
             пользователь воспринимал это как «свайп не прошёл, вернулась
             красная кнопка» и жал её, разрывая звонок. Маленькая красная
             пилюля ниже — на случай, если нужно отменить. -->
        <template v-if="!mediaConnected">
          <div class="call-connecting-wrap">
            <div class="call-orb call-orb-accepted">
              <Icon name="phone" :size="26" color="#ffffff" />
            </div>
            <button class="call-end-pill call-end-pill-small" :title="texts.end" @click="$emit('end')">
              <Icon name="phone" :size="18" />
            </button>
          </div>
        </template>
        <!-- Разговор установлен (27.08, редизайн): ОДИН ряд — микрофон |
             красная «пилюля» завершения | динамик. -->
        <div v-else class="call-control-row call-active-row">
          <button
            class="call-orb call-orb-extra"
            :class="{ 'orb-active': muted }"
            :title="muted ? texts.unmute : texts.mute"
            @click="$emit('toggle-mute')"
          >
            <Icon :name="muted ? 'mic-off' : 'mic'" :size="22" />
          </button>
          <button class="call-end-pill" :title="texts.end" @click="$emit('end')">
            <Icon name="phone" :size="26" />
          </button>
          <button
            class="call-orb call-orb-extra"
            :class="{ 'orb-active': speaker }"
            :title="texts.speaker"
            @click="$emit('toggle-speaker')"
          >
            <Icon name="volume" :size="22" />
          </button>
        </div>
      </template>
    </div>

    <div v-if="texts.noMedia && state !== 'idle'" class="call-nomedia">{{ texts.noMedia }}</div>
  </div>
</template>

<script>
import UserAvatar from './UserAvatar.vue';
import Icon from './Icon.vue';

// Оверлей звонка (M3, feature/calls). Редизайн 27.08: пульсирующие кольца
// дозвона, glassmorphism, голосовая волна, бейдж E2E — в стиле Vault
// (индиго #6366f1 + янтарные акценты). Свайп ТОЛЬКО при зажатой кнопке на
// самой трубке: вправо — зеленеет (принять), влево — краснеет (отклонить).
// Ход ограничен DRAG_LIMIT; на пределе цвет «залипает» (latched) — это и есть
// визуальное подтверждение действия, которое отправляется в момент достижения.
export default {
  name: 'CallOverlay',
  components: { UserAvatar, Icon },
  props: {
    state: { type: String, default: 'idle' }, // idle|outgoing_ringing|incoming_ringing|active
    peer: { type: String, default: '' },
    peerName: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    muted: { type: Boolean, default: false },
    speaker: { type: Boolean, default: false },
    // Реально ли пошёл звук (событие call-media-connected из Rust, 27.08).
    mediaConnected: { type: Boolean, default: false },
    elapsed: { type: String, default: '00:00' },
    texts: { type: Object, default: () => ({}) },
  },
  emits: ['accept', 'reject', 'cancel', 'end', 'toggle-mute', 'toggle-speaker'],
  data() {
    return {
      dragging: false,
      startX: null,
      dx: 0,
      // Флик-детект (27.08): быстрый свайп должен принимать звонок так же,
      // как полное дотягивание. Трекинг скорости в px/ms со сглаживанием.
      lastX: 0,
      lastT: 0,
      velocity: 0,
      decision: null, // 'accept' | 'reject' | null — принятое решение (цвет держится)
    };
  },
  computed: {
    DRAG_LIMIT() { return 110; }, // полный ход трубки, px
    // Лёгкий свайп (28.08): latch на 70px вместо 110 — не нужно тянуть до
    // упора. Пользователь жаловался «тяну в зелёную сторону, зеленеет,
    // но возвращается в центр» — не дотягивал 110px.
    LATCH_AT() { return 70; },
    orbX() {
      if (!this.dragging) return 0;
      return Math.max(-this.DRAG_LIMIT, Math.min(this.DRAG_LIMIT, this.dx));
    },
    dragClass() {
      if (this.orbX > 24) return 'drag-accept';
      if (this.orbX < -24) return 'drag-reject';
      return '';
    },
    panelShiftStyle() {
      // Панель слегка тянется за трубкой (0.25x), но НЕ двигается после отпускания.
      if (!this.dragging) return {};
      return { transform: `translateX(${this.orbX * 0.25}px)` };
    },
  },
  watch: {
    state(s) {
      // Смена состояния (в т.ч. уход с incoming) — сброс драга И решения.
      // ВАЖНО (28.08): decision тоже сбрасываем — иначе после первого
      // принятого звонка decision='accept' остаётся навсегда, и при
      // следующем входящем onDragStart сразу делает return («решение уже
      // принято») → свайп не работает (жалоба «свайп не принял звонок»).
      this.reset();
      this.decision = null;
    },
  },
  methods: {
    reset() {
      this.dragging = false;
      this.startX = null;
      this.dx = 0;
      this.lastX = 0;
      this.lastT = 0;
      this.velocity = 0;
    },
    onDragStart(e) {
      if (this.state !== 'incoming_ringing') return;
      if (this.decision) return; // решение уже принято
      this.dragging = true;
      this.startX = e.clientX - this.dx;
      this.lastX = e.clientX;
      this.lastT = performance.now();
      this.velocity = 0;
      try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
    },
    onDragMove(e) {
      if (!this.dragging || this.decision) return;
      const prevX = this.orbX;
      this.dx = e.clientX - this.startX;
      // Скорость свайпа (px/ms), экспоненциальное сглаживание.
      const now = performance.now();
      const dt = now - this.lastT;
      if (dt > 0) {
        const v = (e.clientX - this.lastX) / dt;
        this.velocity = this.velocity * 0.4 + v * 0.6;
        this.lastX = e.clientX;
        this.lastT = now;
      }
      // Достигли предела → фиксируем решение и ОТПРАВЛЯЕМ его один раз.
      if (prevX > -this.LATCH_AT && prevX < this.LATCH_AT) {
        if (this.orbX >= this.LATCH_AT) { this.decision = 'accept'; this.$emit('accept'); }
        else if (this.orbX <= -this.LATCH_AT) { this.decision = 'reject'; this.$emit('reject'); }
      }
    },
    onDragEnd() {
      // Флик (27.08, облегчён 28.08): быстрый короткий свайп тоже
      // принимает/отклоняет звонок. Пороги снижены: скорость ≥ 0.35 px/ms
      // И смещение ≥ 20px (было 0.55/30 — обычный свайп не проходил).
      if (!this.decision && this.state === 'incoming_ringing') {
        const FLICK_V = 0.35, FLICK_DX = 20;
        console.log('[call] swipe end: dx=' + Math.round(this.dx) + ' v=' + this.velocity.toFixed(2));
        if (this.velocity >= FLICK_V && this.dx >= FLICK_DX) {
          this.decision = 'accept';
          console.log('[call] swipe ACCEPT (flick)');
          this.$emit('accept');
        } else if (this.velocity <= -FLICK_V && this.dx <= -FLICK_DX) {
          this.decision = 'reject';
          console.log('[call] swipe REJECT (flick)');
          this.$emit('reject');
        } else {
          console.log('[call] swipe NO-OP (below thresholds)');
        }
      }
      // Отпускание: трубка возвращается в центр, но цвет решения держится
      // до конца звонка (сброс — при смене state из родителя).
      this.reset();
    },
  },
};
</script>

<style scoped>
.call-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: radial-gradient(ellipse 90% 55% at 50% 26%, rgba(99, 102, 241, 0.16), transparent 62%),
              radial-gradient(ellipse 70% 40% at 50% 100%, rgba(245, 158, 11, 0.07), transparent 60%),
              rgba(8, 8, 18, 0.96);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  user-select: none;
  touch-action: none;
  overflow: hidden;
}
.call-glow {
  position: absolute;
  top: 12%;
  left: 50%;
  width: 420px;
  height: 420px;
  transform: translateX(-50%);
  background: radial-gradient(circle, rgba(99, 102, 241, 0.14), transparent 65%);
  pointer-events: none;
  animation: glowbreathe 4s ease-in-out infinite;
}
@keyframes glowbreathe {
  0%, 100% { opacity: 0.7; transform: translateX(-50%) scale(1); }
  50% { opacity: 1; transform: translateX(-50%) scale(1.08); }
}
.call-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 36px 44px 30px;
  border-radius: 28px;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5);
  transition: transform 0.12s ease-out;
}
/* ── Аватар + пульсирующие кольца дозвона ─────────────────────── */
.call-avatar-wrap {
  position: relative;
  width: 96px;
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pulse-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 2px solid rgba(99, 102, 241, 0.55);
  opacity: 0;
  pointer-events: none;
  animation: pulsering 2.4s ease-out infinite;
}
.pulse-ring.pr-out {
  border-color: rgba(245, 158, 11, 0.5);
}
.pr-2 { animation-delay: 0.8s; }
.pr-3 { animation-delay: 1.6s; }
@keyframes pulsering {
  0% { transform: scale(1); opacity: 0.75; }
  70% { transform: scale(1.75); opacity: 0; }
  100% { transform: scale(1.75); opacity: 0; }
}
.call-avatar {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: var(--bg-secondary, #1c1c2e);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  position: relative;
  z-index: 1;
}
.call-avatar.avatar-active {
  box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.35), 0 8px 30px rgba(0, 0, 0, 0.45);
}
.call-name {
  font-size: 24px;
  font-weight: 600;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.call-status {
  opacity: 0.8;
  min-height: 22px;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.call-timer {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
}
.call-secure {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 600;
  color: #4ade80;
  background: rgba(74, 222, 128, 0.12);
  border: 1px solid rgba(74, 222, 128, 0.25);
  border-radius: 999px;
  padding: 2px 8px;
  letter-spacing: 0.4px;
}
/* ── Голосовая волна (активный разговор) ──────────────────────── */
.call-wave {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  margin-top: 2px;
}
.wave-bar {
  width: 4px;
  height: 8px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--accent-secondary, #818cf8), var(--accent-primary, #6366f1));
  animation: wavebounce 1.1s ease-in-out infinite;
}
@keyframes wavebounce {
  0%, 100% { height: 8px; opacity: 0.55; }
  50% { height: 24px; opacity: 1; }
}
/* ── Нижняя панель ─────────────────────────────────────────────── */
.call-controls {
  position: absolute;
  bottom: 56px;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}
.call-control-row {
  display: flex;
  gap: 48px;
  align-items: center;
  justify-content: center;
}
/* Ряд входящего: шевроны по бокам трубки */
.call-drag-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 26px;
  min-width: 340px;
}
.drag-hint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  animation: hintpulse 1.6s ease-in-out infinite;
}
.hint-left {
  flex-direction: row-reverse;
}
@keyframes hintpulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
.hintfade-enter-active,
.hintfade-leave-active {
  transition: opacity 0.2s ease;
}
.hintfade-enter-from,
.hintfade-leave-to {
  opacity: 0;
}
.call-waiting-hint {
  font-size: 12px;
  opacity: 0.55;
}
.call-extra-row {
  gap: 36px;
  margin-bottom: 6px;
}
.call-orb {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.call-orb-gold {
  width: 76px;
  height: 76px;
  background: linear-gradient(135deg, #fbbf24, #f59e0b);
  box-shadow: 0 8px 30px rgba(245, 158, 11, 0.45);
  /* transform управляется inline-стилем; transition фона — быстрый */
  transition: background 0.12s ease, box-shadow 0.12s ease;
}
.call-orb-gold.drag-accept {
  background: linear-gradient(135deg, #4ade80, #22c55e);
  box-shadow: 0 8px 34px rgba(34, 197, 94, 0.65);
}
.call-orb-gold.drag-reject {
  background: linear-gradient(135deg, #f87171, #ef4444);
  box-shadow: 0 8px 34px rgba(239, 68, 68, 0.65);
}
/* Решение принято: цвет держится после возврата в центр до конца звонка */
.decision-accept {
  background: linear-gradient(135deg, #4ade80, #22c55e);
  box-shadow: 0 8px 34px rgba(34, 197, 94, 0.65);
}
.decision-reject {
  background: linear-gradient(135deg, #f87171, #ef4444);
  box-shadow: 0 8px 34px rgba(239, 68, 68, 0.65);
}
/* Фаза «Соединение…» (28.08): зелёный орб «принято» + маленькая красная
   пилюля ниже. Визуальное продолжение свайпа — пользователь видит, что
   звонок ПРИНЯТ (зелёный), а не «вернулась красная кнопка». */
.call-connecting-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}
.call-orb-accepted {
  background: linear-gradient(135deg, #4ade80, #22c55e);
  box-shadow: 0 8px 34px rgba(34, 197, 94, 0.65);
  animation: acceptpulse 1.6s ease-in-out infinite;
  cursor: default;
}
@keyframes acceptpulse {
  0%, 100% { box-shadow: 0 8px 34px rgba(34, 197, 94, 0.65); }
  50% { box-shadow: 0 8px 44px rgba(34, 197, 94, 0.9); }
}
.call-end-pill-small {
  width: 52px;
  height: 40px;
  border-radius: 20px;
  opacity: 0.85;
}
.call-orb-reject,
.call-orb-end {
  background: linear-gradient(135deg, #f87171, #ef4444);
  box-shadow: 0 8px 28px rgba(239, 68, 68, 0.45);
}
.call-orb-reject:hover,
.call-orb-end:hover {
  background: #dc2626;
  box-shadow: 0 8px 34px rgba(239, 68, 68, 0.65);
}
.call-orb-single {
  width: 76px;
  height: 76px;
}
.call-orb-extra {
  width: 58px;
  height: 58px;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  box-shadow: none;
  flex-direction: column;
  gap: 4px;
  font-size: 10px;
}
.call-orb-extra:hover {
  background: rgba(255, 255, 255, 0.18);
}
.call-orb-extra.orb-active {
  background: linear-gradient(135deg, #f87171, #ef4444);
  border-color: transparent;
  box-shadow: 0 4px 18px rgba(239, 68, 68, 0.5);
}
.orb-label {
  font-size: 10px;
  opacity: 0.9;
  line-height: 1;
}
/* ── Активный разговор (редизайн 27.08) ───────────────────────── */
.call-active-row {
  gap: 32px;
}
/* Красная «пилюля» завершения (28.08): широкая капсула в стиле iOS/Telegram
   вместо уродливого круга. Глубокий спокойный красный #e5484d (28.08:
   был #ef4444 — слишком кричащий), мягкая тень, hover — чуть темнее.
   Иконка: обычная трубка БЕЗ перечёркивания — красный цвет сам говорит
   «завершить» (перечёркнутая трубка выглядела как «отклонить»). */
.call-end-pill {
  width: 72px;
  height: 56px;
  border-radius: 28px;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: #e5484d;
  box-shadow: 0 6px 24px rgba(229, 72, 77, 0.38);
  transition: background 0.15s ease, box-shadow 0.15s ease, transform 0.1s ease;
}
.call-end-pill:hover {
  background: #d63b40;
  box-shadow: 0 6px 28px rgba(229, 72, 77, 0.52);
}
.call-end-pill:active {
  transform: scale(0.94);
}
.call-orb-small {
  width: 58px;
  height: 58px;
}
.call-connecting {
  font-size: 14px;
  opacity: 0.75;
  animation: connectpulse 1.4s ease-in-out infinite;
}
@keyframes connectpulse {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 0.95; }
}
/* ── Подсказка свайпа ──────────────────────────────────────────── */
.call-swipe-hint {
  position: absolute;
  bottom: 168px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  padding: 0 42px;
  font-size: 12px;
  opacity: 0.6;
  pointer-events: none;
}
.swipe-hint-l {
  color: #f87171;
}
.swipe-hint-r {
  color: #4ade80;
}
.call-nomedia {
  position: absolute;
  bottom: 20px;
  font-size: 12px;
  opacity: 0.55;
  text-align: center;
}
</style>
