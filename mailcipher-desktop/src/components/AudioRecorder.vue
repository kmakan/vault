<template>
  <div class="audio-recorder" v-if="show">
    <div class="audio-recorder__card">
      <div class="audio-recorder__header">
        <span class="recorder-title">🎙️ {{ t('audio_record') || 'Voice Message' }}</span>
        <button class="recorder-close" @click="cancel">✕</button>
      </div>

      <!-- Idle state -->
      <div v-if="state === 'idle'" class="audio-recorder__body">
        <button class="record-btn" @click="startRecording">
          <span class="record-icon">●</span>
          <span>{{ t('audio_start') || 'Start Recording' }}</span>
        </button>
      </div>

      <!-- Recording state -->
      <div v-if="state === 'recording'" class="audio-recorder__body">
        <div class="recording-indicator">
          <span class="pulse-dot"></span>
          <span class="recording-time">{{ formatTime(duration) }}</span>
        </div>
        <div class="waveform">
          <div v-for="i in 30" :key="i" class="wave-bar" :style="{ height: getWaveHeight(i) + 'px' }"></div>
        </div>
        <div class="recording-actions">
          <button class="btn-discard" @click="cancel">
            <span>🗑️</span> {{ t('audio_discard') || 'Discard' }}
          </button>
          <button class="btn-stop" @click="stopRecording">
            <span>⏹️</span> {{ t('audio_stop') || 'Stop' }}
          </button>
        </div>
      </div>

      <!-- Preview state -->
      <div v-if="state === 'preview'" class="audio-recorder__body">
        <div class="preview-info">
          <span class="preview-time">{{ formatTime(duration) }}</span>
          <span class="preview-size">{{ formatSize(audioSize) }}</span>
        </div>
        <div class="preview-actions">
          <button class="btn-discard" @click="cancel">
            <span>🗑️</span> {{ t('audio_discard') || 'Discard' }}
          </button>
          <button class="btn-send" @click="send">
            <span>➤</span> {{ t('audio_send') || 'Send Voice' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from '../i18n.js'

const { t } = useI18n()

const props = defineProps({
  show: { type: Boolean, default: false },
})

const emit = defineEmits(['send', 'close'])

const state = ref('idle') // idle | recording | preview
const duration = ref(0)
const audioBlob = ref(null)
const audioSize = ref(0)
const waveData = ref([])

let mediaRecorder = null
let audioChunks = []
let timer = null
let analyser = null
let animFrame = null

function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1048576).toFixed(1) + ' MB'
}

function getWaveHeight(index) {
  if (waveData.value.length === 0) return 4
  const dataIdx = Math.floor((index / 30) * waveData.value.length)
  return Math.max(4, (waveData.value[dataIdx] || 0) * 40)
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    audioChunks = []

    // Setup analyser for waveform
    const audioCtx = new AudioContext()
    const source = audioCtx.createMediaStreamSource(stream)
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 64
    source.connect(analyser)

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data)
    }

    mediaRecorder.onstop = () => {
      audioBlob.value = new Blob(audioChunks, { type: 'audio/webm' })
      audioSize.value = audioBlob.value.size
      state.value = 'preview'
      stream.getTracks().forEach(t => t.stop())
      cancelAnimationFrame(animFrame)
    }

    mediaRecorder.start(100) // 100ms chunks for waveform
    state.value = 'recording'
    duration.value = 0

    timer = setInterval(() => duration.value++, 1000)
    updateWaveform()
  } catch (err) {
    console.error('Microphone access denied:', err)
  }
}

function updateWaveform() {
  if (!analyser || state.value !== 'recording') return
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(data)
  waveData.value = Array.from(data)
  animFrame = requestAnimationFrame(updateWaveform)
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  clearInterval(timer)
}

function cancel() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
  clearInterval(timer)
  cancelAnimationFrame(animFrame)
  audioBlob.value = null
  audioChunks = []
  waveData.value = []
  duration.value = 0
  state.value = 'idle'
  emit('close')
}

function send() {
  if (!audioBlob.value) return
  // Convert to base64 for email transport
  const reader = new FileReader()
  reader.onload = () => {
    const base64 = reader.result.split(',')[1]
    emit('send', {
      type: 'audio',
      blob: audioBlob.value,
      base64: base64,
      duration: duration.value,
      size: audioSize.value,
      mimeType: 'audio/webm',
    })
    cancel()
  }
  reader.readAsDataURL(audioBlob.value)
}

onUnmounted(() => {
  clearInterval(timer)
  cancelAnimationFrame(animFrame)
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop()
  }
})
</script>

<style scoped>
.audio-recorder {
  position: absolute;
  bottom: 70px;
  left: 0;
  z-index: 100;
}

.audio-recorder__card {
  width: 320px;
  background: var(--bg-secondary, #12122a);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
  border-radius: 16px;
  box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.5));
  overflow: hidden;
}

.audio-recorder__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
}

.recorder-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary, #f1f5f9);
}

.recorder-close {
  background: none;
  border: none;
  color: var(--text-muted, #64748b);
  cursor: pointer;
  font-size: 16px;
}

.recorder-close:hover {
  color: var(--text-primary, #f1f5f9);
}

.audio-recorder__body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

/* Record button */
.record-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 24px;
  background: linear-gradient(135deg, #ef4444, #dc2626);
  border: none;
  border-radius: 12px;
  color: white;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.record-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 16px rgba(239, 68, 68, 0.4);
}

.record-icon {
  font-size: 18px;
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

/* Recording indicator */
.recording-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
}

.pulse-dot {
  width: 12px;
  height: 12px;
  background: #ef4444;
  border-radius: 50%;
  animation: recPulse 1s infinite;
}

@keyframes recPulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.2); opacity: 0.7; }
}

.recording-time {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-mono, monospace);
}

/* Waveform */
.waveform {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 40px;
}

.wave-bar {
  width: 6px;
  min-height: 4px;
  background: linear-gradient(180deg, #ef4444, #6366f1);
  border-radius: 3px;
  transition: height 0.1s;
}

/* Recording actions */
.recording-actions,
.preview-actions {
  display: flex;
  gap: 10px;
}

.btn-discard,
.btn-stop,
.btn-send {
  padding: 8px 16px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.15s;
}

.btn-discard {
  background: var(--bg-tertiary, #1a1a3e);
  color: var(--text-secondary, #94a3b8);
  border: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
}

.btn-discard:hover {
  background: var(--bg-hover, #1e1e4a);
}

.btn-stop {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  color: white;
}

.btn-stop:hover {
  transform: translateY(-1px);
}

.btn-send {
  background: linear-gradient(135deg, var(--accent-primary, #6366f1), #4f46e5);
  color: white;
  font-weight: 500;
}

.btn-send:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--accent-glow, rgba(99, 102, 241, 0.3));
}

/* Preview */
.preview-info {
  display: flex;
  gap: 16px;
  font-size: 13px;
  color: var(--text-secondary, #94a3b8);
}

.preview-time {
  font-weight: 600;
  color: var(--text-primary, #f1f5f9);
  font-family: var(--font-mono, monospace);
}
</style>
