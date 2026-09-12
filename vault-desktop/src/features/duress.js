// Feature module: duress lock (аварийная защита). Stage 1 of the App.vue
// decomposition — pure functions receive the component instance as `ctx`
// instead of `this`, so every dependency is explicit and testable in
// isolation.
//
// Три кода: обычный вход; duress-PIN — приложение открывается «как обычно»
// (не выдаёт себя), но тихо рассылает SOS-письмо доверенным контактам;
// panic-PIN — Rust уже стёр данные, локальный выход на логин.
// Android-ветка: нативный LockActivity, JS-замок не показывается.

import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';

// Lock config from Rust key store (null-safe read).
async function lockEnabled() {
  try {
    const cfg = await invoke('duress_get_config');
    return !!(cfg && cfg.lock_enabled && cfg.lock_hash);
  } catch (e) {
    return false;
  }
}

// При старте: если замок включён — показываем LockScreen вместо UI.
export async function checkDuressLock(ctx) {
  // Android: не показываем — двойной запрос кода, нативный LockActivity.
  if (/android/i.test(navigator.userAgent)) {
    ctx.duressLocked = false;
    console.log('[duress] android branch: native LockActivity handles the lock');
    return;
  }
  try {
    const cfg = await invoke('duress_get_config');
    const enabled = !!(cfg && cfg.lock_enabled && cfg.lock_hash);
    ctx.duressLocked = enabled;
    console.log('[duress] lock check: enabled=', cfg && cfg.lock_enabled,
      ', hash=', !!(cfg && cfg.lock_hash), '→ locked=', enabled);
  } catch (e) {
    console.warn('[duress] check failed:', e);
  }
  // Android-«выход» не убивает процесс — FGS и keep-alive WebView живут,
  // mounted НЕ выполняется при повторном открытии, замок не показывался.
  // Ловим возврат из фона: замок включён и в этой сессии ещё не
  // разблокирован (duressUnlockedThisSession false) — показать.
  if (!ctx._duressVisibilityBound) {
    ctx._duressVisibilityBound = true;
    const relock = async () => {
      if (ctx.duressUnlockedThisSession) return;
      const enabled = await lockEnabled();
      if (enabled) {
        ctx.duressLocked = true;
        console.log('[duress] relock on resume → locked=true');
      }
    };
    document.addEventListener('visibilitychange', () => {
      // Уход из видимости = конец «доверенного периода»: флаг сессии
      // снимаем, чтобы relock при возврате ПОКАЗАЛ замок (банковский
      // паттерн: замок после КАЖДОГО ухода, не только смерти процесса).
      if (document.visibilityState === 'hidden') {
        ctx.duressUnlockedThisSession = false;
      } else {
        relock();
      }
    });
    window.addEventListener('focus', relock);
    // Desktop close-to-tray: Rust эмитит событие ПЕРЕД скрытием окна в
    // трей. Здесь сбрасываем флаг «разблокирован в этой сессии» и сразу
    // поднимаем замок: при возврате из трея LockScreen уже на экране
    // (WebView скрытого окна может не слать visibilitychange).
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('vault://window-hidden', () => {
        ctx.duressUnlockedThisSession = false;
        lockEnabled().then((enabled) => {
          if (enabled) {
            ctx.duressLocked = true;
            console.log('[duress] tray-hide → armed lock for next show');
          }
        });
      });
    })();
  }
  // Повтор через секунду: restoreSession/монтирование UI может перерисовать
  // поздно; дублирующая проверка гарантирует замок при уже сохранённом конфиге.
  setTimeout(async () => {
    const enabled = await lockEnabled();
    if (enabled) {
      ctx.duressLocked = true;
      console.log('[duress] lock re-check → locked=true');
    }
  }, 1200);
}

export function onLockUnlock(ctx) {
  ctx.duressLocked = false;
  ctx.duressUnlockedThisSession = true; // до ухода в фон замок не ре-армить
}

// Duress-PIN: открываем приложение КАК ОБЫЧНО (не выдаём), но после
// монтирования тихо отправляем SOS-письмо выбранным контактам.
export function onLockDuress(ctx) {
  ctx.duressLocked = false;
  ctx.duressPending = true;
  ctx.$nextTick(() => sendDuressSos(ctx));
}

// Panic-PIN: Rust уже стёр данные — выходим на login (локально пусто).
export async function onLockPanic(ctx) {
  ctx.duressLocked = false;
  try {
    await api.logout();
  } catch (e) { /* ignore */ }
  ctx.isLoggedIn = false;
  ctx.email = null;
  ctx.showToast(ctx.t('panic_done') || 'Данные стёрты', 4000);
}

// SOS: скрытое письмо выбранным контактам. НЕ сохраняется в чат получателя:
// тип sos обрабатывается получателем отдельно (push), в историю не пишется.
export async function sendDuressSos(ctx) {
  try {
    const cfg = await invoke('duress_get_config');
    const rcpts = (cfg.sos_recipients || []).filter(Boolean);
    if (!rcpts.length) return;
    // Гео: если включено — координаты через WebView geolocation
    // (на Android нативный запрос разрешения идёт при включении флага).
    let coords = '';
    if (cfg.sos_geo) {
      coords = await new Promise((resolve) => {
        let done = false;
        const finish = (c) => { if (!done) { done = true; clearTimeout(timer); resolve(c); } };
        const timer = setTimeout(() => finish(''), 5000);
        try {
          navigator.geolocation.getCurrentPosition(
            (pos) => finish(`, мои координаты: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`),
            () => finish(''),
            { timeout: 4500, maximumAge: 600000 },
          );
        } catch (e) { finish(''); }
      });
    }
    const rawText = cfg.sos_text || ctx.t('sos_default') || 'Телефон не у меня{coords}';
    let text = rawText.replace('{coords}', coords);
    // Geo включено, но в тексте нет плейсхолдера — дописываем координаты в конец.
    if (coords && !rawText.includes('{coords}')) text += coords;
    // Сохранённые peer-ключи: encryptVault требует установленного ключа
    // получателя — иначе шифрование падает и SOS молча теряется.
    // При холодном старте (duress сразу после открытия) peerKeys могли
    // ещё не загрузиться — читаем прямо из key_store.
    if (!ctx.peerKeys || !Object.keys(ctx.peerKeys).length) {
      try {
        const stored = await crypto.loadPeerKeys();
        ctx.peerPqKeys = ctx.peerPqKeys || {};
        for (const pk of stored) {
          ctx.peerKeys[pk.email] = pk.public_key;
          if (pk.pq_public_key) ctx.peerPqKeys[pk.email] = pk.pq_public_key;
        }
      } catch (e) { console.warn('[duress] loadPeerKeys failed:', e); }
    }
    for (const rcpt of rcpts) {
      try {
        const pk = ctx.peerKeys && ctx.peerKeys[rcpt];
        if (!pk) {
          console.warn('[duress] SOS: no peer key for', rcpt, '— skip');
          continue;
        }
        crypto.setPeerPublicKey(pk, ctx.peerPqKeys && ctx.peerPqKeys[rcpt]);
        const content = await crypto.encryptVault(JSON.stringify({
          vault: 1, id: 'sos-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          type: 'sos', text, name: ctx.displayName || '', ts: Date.now(),
        }));
        await api.sendEmail('local', { to: rcpt, subject: '', body: content });
      } catch (e) {
        console.warn('[duress] SOS to', rcpt, 'failed:', e);
      }
    }
    console.log('[duress] SOS sent to', rcpts.length, 'recipients');
  } catch (e) {
    console.warn('[duress] sendSos failed:', e);
  } finally {
    ctx.duressPending = false;
  }
}
