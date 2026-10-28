// Тестовый двойник команд разбора тела письма (Rust).
//
// ПОЧЕМУ ДВОЙНИК, А НЕ ПРАВИЛО. Правило (снять folding SMTP, раскодировать
// QP, вернуть url-safe алфавит, добить padding, прочитать UTF-8) с 28.10 живёт
// ТОЛЬКО в ядре — vault-client/src/crypto.rs::clean_base64_body и
// decode_url_safe_text/channel_kid_hex. Мера правила — общая фикстура
// vault-client/tests/fixtures/body-decode-contract.json и мутации ядра
// (rust-crypto, rust-bridge-crypto-mail, rust-bridge-monitor-state).
//
// Здесь — двойник ДЛЯ СМОУКОВ: он отвечает на ТЕ ЖЕ команды моста и с ТЕМИ ЖЕ
// именами аргументов (body / token), чтобы смоуки исполняли настоящий адаптер
// src/body-decode.js без Tauri. Расхождение двойника с Rust прод не сломает
// (прод зовёт Rust), но сделает смоук слепым к смене формы вызова — поэтому
// имена команд здесь обязаны совпадать с src-tauri/src/lib.rs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');   // vault-desktop/

// Тот же порядок, что в ядре: пробелы → QP-escapes → алфавит → padding.
function decodeBody(body) {
  let s = String(body || '').replace(/\s+/g, '');
  if (s.includes('=')) {
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '=' && i + 2 < s.length
        && /^[0-9a-f]$/i.test(s[i + 1]) && /^[0-9a-f]$/i.test(s[i + 2])) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(c.charCodeAt(0));
      }
    }
    s = Buffer.from(bytes).toString('latin1');
  }
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// Обработчик команд для моков моста. undefined — «не моя команда».
export function bodyDecodeHandler(cmd, args) {
  const a = args || {};
  if (cmd === 'vault_decode_url_safe_body') {
    return new TextDecoder('utf-8', { fatal: true }).decode(decodeBody(a.body));
  }
  if (cmd === 'channel_kid_hex') {
    const bytes = decodeBody(a.token);
    if (bytes.length < 8) throw new Error('token shorter than 8 bytes');
    return bytes.subarray(0, 8).toString('hex');
  }
  return undefined;
}

// Копия настоящего адаптера с подменённым Tauri-вызовом (tauriLine —
// например "const invoke = (...a) => globalThis.__INVOKE__(...a);").
export function writeBodyDecodeAdapter(mocksDir, tauriLine) {
  mkdirSync(mocksDir, { recursive: true });
  const src = readFileSync(path.join(ROOT, 'src', 'body-decode.js'), 'utf8')
    .replace("import { invoke } from '@tauri-apps/api/core';", tauriLine);
  writeFileSync(path.join(mocksDir, 'body-decode.js'), src);
}
