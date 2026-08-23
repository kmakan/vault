<template>
  <div class="call-overlay" :class="'call-' + state">
    <!-- Подсказка свайпа для входящего -->
    <div v-if="state === 'incoming_ringing' && !dragging" class="call-swipe-hint">
      <span class="swipe-hint-l">{{ texts.rejectHint }}</span>
      <span class="swipe-hint-r">{{ texts.acceptHint }}</span>
    </div>

    <div class="call-panel" :style="panelShiftStyle">
      <div class="call-avatar">
        <UserAvatar :email="peer" :avatarUrl="avatarUrl" :size="88" />
      </div>
      <div class="call-name">{{ peerName }}</div>
      <div class="call-status">
        <template v-if="state === 'incoming_ringing'">{{ texts.incoming }}</template>
        <template v-else-if="state === 'outgoing_ringing'">{{ texts.outgoing }}</template>
        <template v-else-if="state === 'active'">{{ elapsed }} · 🔒</template>
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

      <!-- Исходящий: золотая трубка (отмена) — как у входящего, единый стиль -->
      <template v-else-if="state === 'outgoing_ringing'">
        <div class="call-control-row">
          <button class="call-orb call-orb-gold" :title="texts.cancel" @click="$emit('cancel')">
            <Icon name="phone-off" :size="26" color="#ffffff" />
          </button>
        </div>
        <div class="call-waiting-hint">{{ texts.outgoing }}</div>
      </template>

      <!-- Активный: доп. кнопки + завершить -->
      <template v-else-if="state === 'active'">
        <div class="call-control-row call-extra-row">
          <button
            class="call-orb call-orb-extra"
            :class="{ 'orb-active': muted }"
            :title="muted ? texts.unmute : texts.mute"
            @click="$emit('toggle-mute')"
          >
            <Icon :name="muted ? 'mic-off' : 'mic'" :size="22" />
            <span class="orb-label">{{ muted ? texts.unmute : texts.mute }}</span>
          </button>
          <button
            class="call-orb call-orb-extra"
            :class="{ 'orb-active': recording }"
            :title="recording ? texts.stopRecord : texts.startRecord"
            @click="$emit('toggle-record')"
          >
            <Icon name="record" :size="22" />
            <span class="orb-label">{{ recording ? texts.stopRecord : texts.startRecord }}</span>
          </button>
        </div>
        <div class="call-control-row">
          <button class="call-orb call-orb-end" :title="texts.end" @click="$emit('end')">
            <Icon name="phone-off" :size="26" />
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

// Оверлей звонка (M3, feature/calls). Дизайн в духе Android:
// золотая трубка (#f59e0b). Свайп ТОЛЬКО при зажатой кнопке на самой трубке:
// вправо — зеленеет (принять), влево — краснеет (отклонить).
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
    recording: { type: Boolean, default: false },
    elapsed: { type: String, default: '00:00' },
    texts: { type: Object, default: () => ({}) },
  },
  emits: ['accept', 'reject', 'cancel', 'end', 'toggle-mute', 'toggle-record'],
  data() {
    return {
      dragging: false,
      startX: null,
      dx: 0,
      decision: null, // 'accept' | 'reject' | null — принятое решение (цвет держится)
    };
  },
  computed: {
    DRAG_LIMIT() { return 110; }, // полный ход трубки, px
    LATCH_AT() { return this.DRAG_LIMIT; }, // предел = заливка цвета + действие
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
      // Смена состояния (в т.ч. уход с incoming) — сброс драга.
      this.reset();
    },
  },
  methods: {
    reset() {
      this.dragging = false;
      this.startX = null;
      this.dx = 0;
    },
    onDragStart(e) {
      if (this.state !== 'incoming_ringing') return;
      if (this.decision) return; // решение уже принято
      this.dragging = true;
      this.startX = e.clientX - this.dx;
      try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
    },
    onDragMove(e) {
      if (!this.dragging || this.decision) return;
      const prevX = this.orbX;
      this.dx = e.clientX - this.startX;
      // Достигли предела → фиксируем решение и ОТПРАВЛЯЕМ его один раз.
      if (prevX > -this.LATCH_AT && prevX < this.LATCH_AT) {
        if (this.orbX >= this.LATCH_AT) { this.decision = 'accept'; this.$emit('accept'); }
        else if (this.orbX <= -this.LATCH_AT) { this.decision = 'reject'; this.$emit('reject'); }
      }
    },
    onDragEnd() {
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
  background: rgba(10, 10, 20, 0.94);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  user-select: none;
  touch-action: none;
  overflow: hidden;
}
.call-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  transition: transform 0.12s ease-out;
}
.call-avatar {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: var(--bg-secondary, #1c1c2e);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
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
  opacity: 0.75;
  min-height: 20px;
  font-size: 15px;
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
  background: #f59e0b;
  box-shadow: 0 8px 30px rgba(245, 158, 11, 0.45);
  /* transform управляется inline-стилем; transition фона — быстрый */
  transition: background 0.12s ease, box-shadow 0.12s ease;
}
.call-orb-gold.drag-accept {
  background: #22c55e;
  box-shadow: 0 8px 34px rgba(34, 197, 94, 0.65);
}
.call-orb-gold.drag-reject {
  background: #ef4444;
  box-shadow: 0 8px 34px rgba(239, 68, 68, 0.65);
}
/* Решение принято: цвет держится после возврата в центр до конца звонка */
.decision-accept {
  background: #22c55e;
  box-shadow: 0 8px 34px rgba(34, 197, 94, 0.65);
}
.decision-reject {
  background: #ef4444;
  box-shadow: 0 8px 34px rgba(239, 68, 68, 0.65);
}
.call-orb-reject,
.call-orb-end {
  background: #ef4444;
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
  background: rgba(255, 255, 255, 0.12);
  box-shadow: none;
  flex-direction: column;
  gap: 4px;
  font-size: 10px;
}
.call-orb-extra:hover {
  background: rgba(255, 255, 255, 0.2);
}
.call-orb-extra.orb-active {
  background: #ef4444;
  box-shadow: 0 4px 18px rgba(239, 68, 68, 0.5);
}
.orb-label {
  font-size: 10px;
  opacity: 0.9;
  line-height: 1;
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
