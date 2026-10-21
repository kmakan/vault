// Адаптер над СБОРКОЙ wire-конверта (Rust).
//
// ADR-005 R1 / W4 (`t_821261f7`): формат конверта — протокол, значит он в
// ядре. Этот файл — транспорт: он НЕ решает, какие поля входят в конверт, а
// зовёт ядро.
//
// Почему примитив, а не features/: сборку зовут и фичи (send, forward,
// attachments), и компонент. Транспорт живёт вне features/* — как
// src/ephemeral-rule.js и src/call-state-rule.js.
//
// ОТКАЗ МОСТА НЕ ПРОПАДАЕТ МОЛЧА: сообщаем в консоль и возвращаем null.
// Безопасная деградация — НЕ ОТПРАВЛЯТЬ: письмо без корректного конверта
// получатель не разберёт, и оно исчезнет у обоих молча. Лучше явная ошибка.
import { invoke } from '@tauri-apps/api/core';

// input: { id, text, name, avatar, gavatar, key, pqEk, tok, ttlSecs, tsMs }
export async function buildEnvelope(input) {
  const i = input || {};
  try {
    return await invoke('vault_build_envelope', {
      id: String(i.id || ''),
      text: String(i.text == null ? '' : i.text),
      name: String(i.name || ''),
      avatar: String(i.avatar || ''),
      gavatar: i.gavatar == null || i.gavatar === '' ? null : String(i.gavatar),
      key: String(i.key || ''),
      pq_ek: i.pqEk == null || i.pqEk === '' ? null : String(i.pqEk),
      tok: i.tok == null || i.tok === '' ? null : String(i.tok),
      msg_type: i.msgType == null || i.msgType === '' ? null : String(i.msgType),
      ttl_secs: Number(i.ttlSecs) || 0,
      ts_ms: Number(i.tsMs) || 0,
    });
  } catch (e) {
    console.error('[envelope] Rust-сборка конверта недоступна:', e && e.message || e);
    return null;
  }
}
