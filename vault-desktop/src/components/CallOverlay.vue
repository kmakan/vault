<template>
  <div
    class="call-overlay"
    :class="'call-' + state"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!-- Подсказка свайпа для входящего -->
    <div v-if="state === 'incoming_ringing' && !swiping" class="call-swipe-hint">
      <span class="swipe-hint-l">{{ texts.rejectHint }}</span>
      <span class="swipe-hint-r">{{ texts.acceptHint }}</span>
    </div>

    <div class="call-panel" :style="dragStyle">
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
      <!-- Входящий: свайп-трубка слева (отклонить) / справа (принять) -->
      <template v-if="state === 'incoming_ringing'">
        <div class="call-control-row">
          <button class="call-orb call-orb-reject" :title="texts.reject" @click="$emit('reject')">
            <Icon name="phone-off" :size="26" />
          </button>
          <button class="call-orb call-orb-accept" :title="texts.accept" @click="$emit('accept')">
            <Icon name="phone" :size="26" />
          </button>
        </div>
      </template>

      <!-- Исходящий: только отмена -->
      <template v-else-if="state === 'outgoing_ringing'">
        <div class="call-control-row">
          <button class="call-orb call-orb-reject call-orb-single" :title="texts.cancel" @click="$emit('cancel')">
            <Icon name="phone-off" :size="26" />
          </button>
        </div>
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

// Оверлей звонка (M3, feature/calls). Современный дизайн в духе Android:
// круглые кнопки-«орбы», свайп трубки вправо (принять) / влево (отклонить).
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
      startX: null,
      currentX: null,
      swiping: false,
    };
  },
  computed: {
    dragStyle() {
      if (!this.swiping || this.currentX === null) return {};
      return { transform: `translateX(${this.currentX - this.startX}px)` };
    },
  },
  methods: {
    onPointerDown(e) {
      // Свайп работает только для входящего звонка
      if (this.state !== 'incoming_ringing') return;
      this.startX = e.clientX;
      this.currentX = e.clientX;
      this.swiping = true;
    },
    onPointerMove(e) {
      if (!this.swiping) return;
      this.currentX = e.clientX;
    },
    onPointerUp() {
      if (!this.swiping) return;
      this.swiping = false;
      const dx = (this.currentX || 0) - (this.startX || 0);
      if (dx > 80) this.$emit('accept');
      else if (dx < -80) this.$emit('reject');
      this.startX = null;
      this.currentX = null;
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
  transition: transform 0.08s linear;
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
.call-orb:hover {
  transform: scale(1.06);
}
.call-orb:active {
  transform: scale(0.96);
}
.call-orb-accept {
  background: #22c55e;
  box-shadow: 0 8px 28px rgba(34, 197, 94, 0.45);
}
.call-orb-accept:hover {
  background: #16a34a;
  box-shadow: 0 8px 34px rgba(34, 197, 94, 0.65);
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
