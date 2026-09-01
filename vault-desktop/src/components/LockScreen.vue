<template>
  <div class="lock-screen">
    <div class="lock-card">
      <div class="lock-icon">🔒</div>
      <h2 class="lock-title">{{ t('lock_title') || 'Vault заблокирован' }}</h2>
      <p class="lock-sub">{{ t('lock_sub') || 'Введите код доступа' }}</p>
      <input
        ref="pinInput"
        v-model="secret"
        type="password"
        inputmode="numeric"
        autocomplete="off"
        class="lock-input"
        :placeholder="t('lock_placeholder') || 'PIN или пароль'"
        @keyup.enter="submit"
      />
      <p v-if="error" class="lock-error">{{ error }}</p>
      <button class="lock-btn" :disabled="busy" @click="submit">
        {{ busy ? (t('lock_checking') || 'Проверка…') : (t('lock_unlock') || 'Разблокировать') }}
      </button>
      <!-- Биометрия (Android): кнопка появляется, если включена и доступна -->
      <button v-if="bioAvailable" class="lock-bio" @click="bioLogin">
        <Icon name="shield" :size="16" /> {{ t('lock_bio') || 'Войти по отпечатку' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, nextTick } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n.js';
import Icon from './Icon.vue';

const emit = defineEmits(['unlock', 'panic', 'duress']);
const { t } = useI18n();
const secret = ref('');
const error = ref('');
const busy = ref(false);
const bioAvailable = ref(false);

onMounted(() => {
  // Биометрия: пока desktop-заглушка; Android — через плагин (этап 3).
  if (/android/i.test(navigator.userAgent)) {
    // bioAvailable проверяется на этапе 3 (BiometricPrompt)
    bioAvailable.value = false;
  }
  // Фокус в поле сразу: без него Enter не попадает в input и замок
  // «не разблокируется» (разблокировка только по клику в поле).
  nextTick(() => { try { pinInput.value && pinInput.value.focus(); } catch (_) {} });
});

async function submit() {
  if (busy.value || !secret.value) return;
  busy.value = true;
  error.value = '';
  try {
    console.log('[duress] submit: code entered, verifying…');
    const cfg = await invoke('duress_get_config');
    // Порядок: lock → duress (silent SOS, вид обычный) → panic (wipe + logout)
    if (cfg.lock_hash && await invoke('duress_verify', { secret: secret.value, storedHash: cfg.lock_hash })) {
      console.log('[duress] verify OK → unlock');
      emit('unlock');
      return;
    }
    if (cfg.duress_hash && await invoke('duress_verify', { secret: secret.value, storedHash: cfg.duress_hash })) {
      // Не выдаём: открываем как обычно; фронт после монтирования отправит SOS.
      emit('duress');
      return;
    }
    if (cfg.panic_hash && await invoke('duress_verify', { secret: secret.value, storedHash: cfg.panic_hash })) {
      await invoke('duress_wipe_all');
      emit('panic');
      return;
    }
    console.log('[duress] verify FAILED (wrong code)');
    error.value = t('lock_wrong') || 'Неверный код';
    secret.value = '';
  } catch (e) {
    error.value = String(e && e.message || e);
  } finally {
    busy.value = false;
  }
}

function bioLogin() {
  // этап 3
}
</script>

<style scoped>
.lock-screen{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:var(--bg,#0b0f17)}
.lock-card{background:var(--card,#131a2a);border:1px solid var(--border,#1f2940);border-radius:16px;padding:32px;text-align:center;max-width:340px;width:90%}
.lock-icon{font-size:40px;margin-bottom:8px}
.lock-title{font-size:19px;font-weight:700;margin:0 0 4px;color:var(--text,#e7ecf5)}
.lock-sub{font-size:13.5px;color:var(--muted,#8b93a7);margin:0 0 18px}
.lock-input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid var(--border,#1f2940);background:var(--bg-soft,#0f1522);color:var(--text,#e7ecf5);font-size:17px;text-align:center;letter-spacing:.3em}
.lock-error{color:#f87171;font-size:13px;margin:10px 0 0}
.lock-btn{margin-top:16px;width:100%;padding:12px 14px;border-radius:10px;border:none;background:#f59e0b;color:#1a1206;font-size:15px;font-weight:600;cursor:pointer}
.lock-btn:disabled{opacity:.6;cursor:wait}
.lock-bio{margin-top:14px;width:100%;padding:10px;border-radius:10px;border:1px solid var(--border,#1f2940);background:transparent;color:var(--gold,#f59e0b);cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;gap:6px}
</style>
