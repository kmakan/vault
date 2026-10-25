// Feature module: duress lock (аварийная защита). Stage 1 of the App.vue
// decomposition — фича получает узкий контракт, а не компонент
// instead of `this`, so every dependency is explicit and testable in
// isolation.
//
// Три кода: обычный вход; duress-PIN — приложение открывается «как обычно»
// (не выдаёт себя), но тихо рассылает SOS-письмо доверенным контактам;
// panic-PIN — Rust уже стёр данные, локальный выход на логин.
// Android-ветка: нативный LockActivity, JS-замок не показывается.

import { uiStore, sessionStore } from "./session-store.js";
import * as EnvelopeRule from '../envelope-rule.js';
import { invoke } from '@tauri-apps/api/core';
import api from '../api.js';
import crypto from '../crypto.js';
// ADR-004 J.6: владелец peer-ключей — прямой импорт singleton, БЕЗ ctx
// (ctx исключаем — независимость от фрагментов). identity-store чистый
// (без vue), поэтому смоуки его поднимают без моков.
import { identityStore } from './identity-store.js';

// Состояние фичи — в ./duress/state.js (чистый модуль без импортов: его
// поднимает check-template.cjs для резолва спреда `...duressState()`).
//
// ADR-005 W2 (`t_bcb8927a`), партия 9: модуль больше НЕ читает компонент.
// Состояние замка (duressLocked/duressUnlockedThisSession/duressPending)
// разложено по УЗКИМ доступам в deps: спред `...duressState()` копирует
// значения в data(), поэтому модулю нужен именно доступ (геттер/сеттер),
// а не сам объект. Ключи пиров — владелец identity-store, email — владелец
// session-store. Внутренний флаг «слушатель visibility уже навешен» —
// модульная переменная: это не состояние приложения.
export { duressState } from './duress/state.js';

// Слушатель возврата в приложение навешивается ОДИН раз за жизнь окна.
// Это внутренняя деталь модуля (не состояние приложения) — поэтому живёт
// здесь, а не в компоненте.
let visibilityBound = false;

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
export async function checkDuressLock(deps) {
  // Android: не показываем — двойной запрос кода, нативный LockActivity.
  if (/android/i.test(navigator.userAgent)) {
    deps.setLocked(false);
    console.log('[duress] android branch: native LockActivity handles the lock');
    return;
  }
  try {
    const cfg = await invoke('duress_get_config');
    const enabled = !!(cfg && cfg.lock_enabled && cfg.lock_hash);
    deps.setLocked(enabled);
    console.log('[duress] lock check: enabled=', cfg && cfg.lock_enabled,
      ', hash=', !!(cfg && cfg.lock_hash), '→ locked=', enabled);
  } catch (e) {
    console.warn('[duress] check failed:', e);
  }
  // Android-«выход» не убивает процесс — FGS и keep-alive WebView живут,
  // mounted НЕ выполняется при повторном открытии, замок не показывался.
  // Ловим возврат из фона: замок включён и в этой сессии ещё не
  // разблокирован (duressUnlockedThisSession false) — показать.
  if (!visibilityBound) {
    visibilityBound = true;
    const relock = async () => {
      if (deps.isUnlockedThisSession()) return;
      const enabled = await lockEnabled();
      if (enabled) {
        deps.setLocked(true);
        console.log('[duress] relock on resume → locked=true');
      }
    };
    document.addEventListener('visibilitychange', () => {
      // Уход из видимости = конец «доверенного периода»: флаг сессии
      // снимаем, чтобы relock при возврате ПОКАЗАЛ замок (банковский
      // паттерн: замок после КАЖДОГО ухода, не только смерти процесса).
      if (document.visibilityState === 'hidden') {
        deps.setUnlockedThisSession(false);
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
        deps.setUnlockedThisSession(false);
        lockEnabled().then((enabled) => {
          if (enabled) {
            deps.setLocked(true);
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
      deps.setLocked(true);
      console.log('[duress] lock re-check → locked=true');
    }
  }, 1200);
}

export function onLockUnlock(deps) {
  deps.setLocked(false);
  deps.setUnlockedThisSession(true); // до ухода в фон замок не ре-армить
}

// Duress-PIN: открываем приложение КАК ОБЫЧНО (не выдаём), но после
// монтирования тихо отправляем SOS-письмо выбранным контактам.
export function onLockDuress(deps) {
  deps.setLocked(false);
  deps.setPending(true);
  deps.nextTick(() => sendDuressSos(deps));
}

// Panic-PIN: Rust уже стёр данные — выходим на login (локально пусто).
export async function onLockPanic(deps) {
  deps.setLocked(false);
  try {
    await api.logout();
  } catch (e) { /* ignore */ }
  deps.logout();
  sessionStore.setCurrentEmail(null);
  uiStore.toast(uiStore.tr('panic_done') || 'Данные стёрты', 4000);
}

// SOS: скрытое письмо выбранным контактам. НЕ сохраняется в чат получателя:
// тип sos обрабатывается получателем отдельно (push), в историю не пишется.
//
// Тишина — только для человека: никаких тостов и экранов ошибки, уведомление
// об отказе выдало бы сигнал под принуждением. Для журнала тишины быть не
// должно: «SOS не ушёл» обязан отличаться от «SOS ушёл» хотя бы в логе
// (25.10, диагностика на устройстве: раньше здесь писалось «sent to N» даже
// когда не ушло ни одного).
export async function sendDuressSos(deps) {
  try {
    const cfg = await invoke('duress_get_config');
    const rcpts = (cfg.sos_recipients || []).filter(Boolean);
    if (!rcpts.length) {
      console.error('[duress] SOS НЕ ОТПРАВЛЕН: получатели не настроены (замок, скорее всего, не настраивался)');
      return;
    }
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
    const rawText = cfg.sos_text || uiStore.tr('sos_default') || 'Телефон не у меня{coords}';
    let text = rawText.replace('{coords}', coords);
    // Geo включено, но в тексте нет плейсхолдера — дописываем координаты в конец.
    if (coords && !rawText.includes('{coords}')) text += coords;
    // Сохранённые peer-ключи: encryptVault требует установленного ключа
    // получателя — иначе шифрование падает и SOS молча теряется.
    // При холодном старте (duress сразу после открытия) peerKeys могли
    // ещё не загрузиться — читаем прямо из key_store.
    // Запись — через владельца identity (ADR-004 J.6): прямой импорт
    // singleton, БЕЗ ctx (ctx исключаем — независимость от фрагментов).
    if (!identityStore.state.peerKeys || !Object.keys(identityStore.state.peerKeys).length) {
      try {
        const stored = await crypto.loadPeerKeys();
        for (const pk of stored) {
          identityStore.setPeerKey(pk.email, pk.public_key, pk.pq_public_key || null);
          identityStore.markLoaded(pk.email);
        }
      } catch (e) { console.warn('[duress] loadPeerKeys failed:', e); }
    }
    let sent = 0;
    const failed = [];
    for (const rcpt of rcpts) {
      try {
        const pk = identityStore.state.peerKeys && identityStore.state.peerKeys[rcpt];
        if (!pk) {
          console.warn('[duress] SOS: no peer key for', rcpt, '— skip');
          failed.push(`${rcpt}: нет ключа получателя`);
          continue;
        }
        crypto.setPeerPublicKey(pk, identityStore.state.peerPqKeys && identityStore.state.peerPqKeys[rcpt]);
        // ФОРМАТ КОНВЕРТА — В RUST (ADR-005 W4): SOS — тоже протокол (подтип
        // «sos» получатель узнаёт по полю type). Пока сборка жила здесь, формат
        // был описан в двух местах (здесь и в Rust incoming::classify).
        const envelope = await EnvelopeRule.buildEnvelope({
          id: 'sos-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          text,
          name: (deps.displayName() || ''),
          msgType: 'sos',
          tsMs: Date.now(),
        });
        if (!envelope) throw new Error('sos: Rust-сборка конверта недоступна');
        const content = await crypto.encryptVault(envelope);
        await api.sendEmail('local', { to: rcpt, subject: '', body: content });
        sent += 1;
      } catch (e) {
        console.warn('[duress] SOS to', rcpt, 'failed:', e);
        failed.push(`${rcpt}: ${e && e.message ? e.message : e}`);
      }
    }
    // Учёт отправок: «отправлено N» раньше печаталось всегда, включая случай,
    // когда каждый получатель отвалился. Теперь строка об успехе пишется только
    // когда ушло хотя бы одно письмо, и говорит, сколько не ушло.
    if (sent === 0) {
      console.error(`[duress] SOS не дошёл ни до одного из ${rcpts.length}: ${failed.join('; ')}`);
    } else if (failed.length) {
      console.warn(`[duress] SOS ушёл ${sent} из ${rcpts.length}, не ушёл: ${failed.join('; ')}`);
    } else {
      console.log('[duress] SOS sent to', rcpts.length, 'recipients');
    }
  } catch (e) {
    console.warn('[duress] sendSos failed:', e);
  } finally {
    deps.setPending(false);
  }
}
