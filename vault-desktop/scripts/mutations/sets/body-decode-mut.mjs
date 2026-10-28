// Набор мутаций: проводка разбора тела письма (src/body-decode.js).
//
// С 28.10 само правило (folding, QP, алфавит, padding, UTF-8) живёт ТОЛЬКО в
// ядре и меряется фикстурой vault-client/tests/fixtures/body-decode-contract.json
// + наборами rust-crypto / rust-bridge-crypto-mail / rust-bridge-monitor-state.
// Здесь — транспортная часть (t_7d2c1bb1): имя команды моста, имена аргументов
// и то, что отказ не всплывает в скан handshake. Эти поломки не видит ни один
// Rust-тест, поэтому смоук body-decode-smoke.mjs обязан их ловить.
export default {
  id: 'body-decode-mut',
  file: 'src/body-decode.js',
  smoke: 'body-decode-smoke.mjs',
  mutations: [
    { name: 'тело запрашивается не той командой моста (имя разъехалось с lib.rs)',
      pattern: "    return await invoke('vault_decode_url_safe_body', { body });",
      replacement: "    return await invoke('vault_decode_body', { body });" },
    { name: 'аргумент тела назван не body (мост получит undefined и пустоту)',
      pattern: "    return await invoke('vault_decode_url_safe_body', { body });",
      replacement: "    return await invoke('vault_decode_url_safe_body', { text: body });" },
    { name: 'отказ разбора всплывает наружу (чужое письмо роняет весь скан)',
      pattern: "    console.error('[body-decode] Rust-разбор тела недоступен:', e && e.message || e);\n    return null;",
      replacement: "    console.error('[body-decode] Rust-разбор тела недоступен:', e && e.message || e);\n    throw e;" },
    { name: 'пустой вход уходит в мост (null/не-строка как тело письма)',
      pattern: "  if (!body || typeof body !== 'string') return null;",
      replacement: "  if (false) return null;" },
    { name: 'kid запрашивается не той командой моста',
      pattern: "  return await invoke('channel_kid_hex', { token: String(token || '') });",
      replacement: "  return await invoke('channel_kid', { token: String(token || '') });" },
    { name: 'аргумент kid назван не token (мост получит пустой токен)',
      pattern: "  return await invoke('channel_kid_hex', { token: String(token || '') });",
      replacement: "  return await invoke('channel_kid_hex', { value: String(token || '') });" },
  ],
};
