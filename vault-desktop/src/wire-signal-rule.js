// Адаптер над сервисными wire-форматами (Rust).
//
// ADR-005 R1 / W4 (`t_821261f7`): формат — протокол, значит он в ядре. Этот
// файл — транспорт: он НЕ решает, что считается сигналом, data-письмом или
// объектом конверта, а зовёт ядро.
//
// Что здесь:
//   * parseCallSignal — разбор сигнала звонка (мост call_parse_signal existed
//     в Rust с M2.3, но JS продолжал разбирать сам: дубль правила);
//   * parseDodData / buildDodData — data-письмо (download-on-demand);
//   * envelopeObject — объект конверта для релей-дубля отправки.
//
// ОТКАЗ МОСТА НЕ ПРОПАДАЕТ МОЛЧА: сообщаем в консоль и возвращаем null.
// Безопасная деградация — не отправлять письмо, которое получатель не
// разберёт (тише «null» строкой, которую получатель примет за мусор).
import { invoke } from '@tauri-apps/api/core';

// ── Сигнал звонка ───────────────────────────────────────────────────────
// Возвращает объект сигнала (id, type, call_id, ts, sdp?, role?, kemct?,
// sender_ek?, tok?) или null — это не сигнал звонка.
//
// ВАЖНО: правило целиком в Rust (vault::call::parse_call_signal). Пока
// разбор жил в JS, а правило — в Rust, они расходились: Rust-сигнал не
// знал поля tok (relay-токен отправителя), который JS читает при приёме
// сигнала. Теперь правило одно.
export async function parseCallSignal(decrypted) {
  if (!decrypted || typeof decrypted !== 'string') return null;
  try {
    return await invoke('call_parse_signal', { decrypted });
  } catch (e) {
    console.error('[signal] Rust-разбор call-сигнала недоступен:', e && e.message || e);
    return null;
  }
}

// ── Data-письмо (download-on-demand) ────────────────────────────────────
// Возвращает { ref, data } или null — это не data-письмо.
export async function parseDodData(plain) {
  if (!plain || typeof plain !== 'string') return null;
  try {
    return await invoke('vault_parse_dod_data', { plain });
  } catch (e) {
    console.error('[signal] Rust-разбор data-письма недоступен:', e && e.message || e);
    return null;
  }
}

// Собрать data-письмо: { vault_dod_data: 1, ref, data } — формат в ядре.
export async function buildDodData(reference, data) {
  try {
    return await invoke('vault_build_dod_data', {
      reference: String(reference == null ? '' : reference),
      data: String(data == null ? '' : data),
    });
  } catch (e) {
    console.error('[signal] Rust-сборка data-письма недоступна:', e && e.message || e);
    return null;
  }
}

// ── Объект конверта (для релей-дубля отправки) ──────────────────────────
// Конверт — строка; релью нужен объект. Разбор — в ядре (envelope::raw_object).
export async function envelopeObject(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    return await invoke('vault_envelope_object', { text });
  } catch (e) {
    console.error('[signal] Rust-разбор объекта конверта недоступен:', e && e.message || e);
    return null;
  }
}
