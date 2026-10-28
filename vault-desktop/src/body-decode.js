// Адаптер над РАЗБОРОМ тела письма (Rust).
//
// ADR-005 R1: починка тела письма — протокол (снять folding SMTP, вернуть
// алфавит url-safe, восстановить padding, прочитать UTF-8), значит правило
// живёт в ядре: vault_client::crypto::{decode_mail_body, decode_url_safe_text,
// channel_kid_hex}. Здесь — только транспорт: ни «что вырезать», ни «сколько
// `=` доклеить» этот файл не решает (t_7d2c1bb1 — три копии правила сведены).
import { invoke } from '@tauri-apps/api/core';

// Тело письма (base64/base64url, folding по 76, потерянный QP-пэйдинг) → текст.
// Отказ моста и нечитаемое тело для handshake неразличимы — «не наше письмо»:
// null без исключения (как envelope-rule.js::parseEnvelope), иначе чужая почта
// роняла бы весь скан.
export async function decodeUrlSafeText(body) {
  if (!body || typeof body !== 'string') return null;
  try {
    return await invoke('vault_decode_url_safe_body', { body });
  } catch (e) {
    console.error('[body-decode] Rust-разбор тела недоступен:', e && e.message || e);
    return null;
  }
}

// ADR-002: key_id канала — первые 8 байт read-токена, BE, HEX-строкой
// (u64 после 2^53 теряет точность в JSON-числе, и подпись молча ушла бы не
// тому каналу). Отказ пробрасываем: публикующий сам решает, слать без подписи.
export async function channelKidHex(token) {
  return await invoke('channel_kid_hex', { token: String(token || '') });
}
