// Адаптер над ПРАВИЛОМ времени жизни сообщения (Rust).
//
// ADR-005 R1 / W4 (`t_821261f7`): решение о протоколе — в Rust. Этот файл —
// тонкий мост: он НЕ решает «когда истечёт», а зовёт ядро.
//
// Почему примитив, а не features/: фичи не зависят друг от друга
// (ADR-004/ADR-005 R5) — а правило времени жизни нужно и отправителю
// (features/send.js), и получателю (features/messages.js, groups.js), и UI
// (features/ephemeral.js). Транспорт живёт вне features/* — как
// src/channels-tokens.js.
import { invoke } from '@tauri-apps/api/core';

// Момент истечения сообщения: baseMs + ttlSecs*1000 (0 — не исчезает).
// ttl<=0 → 0 без похода в Rust (обычный случай — исчезающих сообщений нет).
export async function expireAt(baseMs, ttlSecs) {
  if (!ttlSecs || ttlSecs <= 0) return 0;
  try {
    return await invoke('vault_ephemeral_expire_at', { baseMs, ttlSecs });
  } catch (e) {
    // Отказ моста НЕ глотаем молча (как в W1-классификаторе): сообщаем и
    // откатываемся к «не исчезает» — лишнее время жизни безопаснее, чем
    // исчезновение раньше срока.
    console.error('[ephemeral] Rust-правило времени жизни недоступно:', e && e.message || e);
    return 0;
  }
}

// Истекло ли сообщение к моменту nowMs (решение — тоже Rust).
export async function isExpired(expiresAt, nowMs) {
  if (!expiresAt) return false;
  try {
    return await invoke('vault_ephemeral_is_expired', { expiresAt, nowMs });
  } catch (e) {
    console.error('[ephemeral] Rust-проверка истечения недоступна:', e && e.message || e);
    return false;
  }
}
