<template>
  <div class="call-overlay" :class="'call-' + state">
    <div class="call-panel">
      <div class="call-avatar">
        <UserAvatar :email="peer" :avatarUrl="avatarUrl" :size="72" />
      </div>
      <div class="call-name">{{ peerName }}</div>
      <div class="call-status">
        <template v-if="state === 'incoming_ringing'">{{ texts.incoming }}</template>
        <template v-else-if="state === 'outgoing_ringing'">{{ texts.outgoing }}</template>
        <template v-else-if="state === 'active'">{{ elapsed }} · 🔒</template>
      </div>
      <div class="call-actions">
        <template v-if="state === 'incoming_ringing'">
          <button class="call-btn call-btn-accept" @click="$emit('accept')">{{ texts.accept }}</button>
          <button class="call-btn call-btn-reject" @click="$emit('reject')">{{ texts.reject }}</button>
        </template>
        <template v-else-if="state === 'outgoing_ringing'">
          <button class="call-btn call-btn-reject" @click="$emit('cancel')">{{ texts.cancel }}</button>
        </template>
        <template v-else-if="state === 'active'">
          <button class="call-btn" @click="$emit('toggle-mute')">
            <Icon name="mic" :size="16" /> {{ muted ? texts.unmute : texts.mute }}
          </button>
          <button class="call-btn call-btn-end" @click="$emit('end')">{{ texts.end }}</button>
        </template>
      </div>
      <div v-if="texts.noMedia && state !== 'idle'" class="call-nomedia">{{ texts.noMedia }}</div>
    </div>
  </div>
</template>

<script>
import UserAvatar from './UserAvatar.vue';
import Icon from './Icon.vue';

// Оверлей звонка (M3, feature/calls). Фаза 1: сигнализация конвертами call_*;
// медиа (webrtc-rs) — Фаза 2, поэтому в активном звонке пока таймер и 🔒.
export default {
  name: 'CallOverlay',
  components: { UserAvatar, Icon },
  props: {
    state: { type: String, default: 'idle' }, // idle|outgoing_ringing|incoming_ringing|active
    peer: { type: String, default: '' },
    peerName: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    muted: { type: Boolean, default: false },
    elapsed: { type: String, default: '00:00' },
    texts: { type: Object, default: () => ({}) },
  },
  emits: ['accept', 'reject', 'cancel', 'end', 'toggle-mute'],
};
</script>

<style scoped>
.call-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  background: rgba(10, 10, 20, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
}
.call-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 32px 40px;
  border-radius: 20px;
  background: var(--bg-secondary, #1c1c2e);
  min-width: 300px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
.call-name {
  font-size: 20px;
  font-weight: 600;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.call-status {
  opacity: 0.75;
  min-height: 20px;
  font-size: 14px;
}
.call-actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}
.call-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  border-radius: 24px;
  border: none;
  cursor: pointer;
  font-size: 14px;
  background: var(--accent-primary, #6366f1);
  color: #fff;
}
.call-btn-accept {
  background: #22c55e;
}
.call-btn-reject,
.call-btn-end {
  background: #ef4444;
}
.call-nomedia {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.55;
  text-align: center;
}
</style>
