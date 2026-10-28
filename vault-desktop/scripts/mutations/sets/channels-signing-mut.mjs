// Набор мутаций: подпись постов канала (src/relay-client.js, ADR-002).
// Цель: убедиться, что смоук channels-signing-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).
//
// С 28.10 kid канала выводит ядро (channel_kid_hex), а не JS: локальный
// hex-вывод удалён (t_7d2c1bb1). Поэтому мутации бьют по ПРОВОДКЕ — какому
// токену доверен kid, что уходит в подпись и как живёт пометка регистрации, —
// а правило «первые 8 байт BE» меряется в Rust (rust-crypto + rust-bridge-*).
export default {
  id: 'channels-signing-mut',
  file: 'src/relay-client.js',
  smoke: 'channels-signing-smoke.mjs',
  mutations: [
    { name: "kid передаётся числом, а не HEX-строкой (потеря точности после 2^53)",
      pattern: "        sig = await invoke('channel_sign_post', { kidHex, envId: id, body });",
      replacement: "        sig = await invoke('channel_sign_post', { kidHex: Number(kidHex), envId: id, body });" },
    { name: "подписывается не та строка, что уйдёт в JSON",
      pattern: "        sig = await invoke('channel_sign_post', { kidHex, envId: id, body });",
      replacement: "        sig = await invoke('channel_sign_post', { kidHex, envId: id, body: body + ' ' });" },
    { name: "kid не передаётся в подпись вовсе (подпись без привязки к каналу)",
      pattern: "        sig = await invoke('channel_sign_post', { kidHex, envId: id, body });",
      replacement: "        sig = await invoke('channel_sign_post', { envId: id, body });" },
    { name: "kid обрезан до 4 байт (ядро дало 8, JS молча переписал)",
      pattern: "        kidHex = await channelKidHex(read);",
      replacement: "        kidHex = (await channelKidHex(read)).slice(0, 8);" },
    { name: "публичный ключ канала не регистрируется на релее",
      pattern: "        await ensureChannelKeyRegistered(relay, read, kidHex);",
      replacement: "        void 0;" },
    { name: "пометка «зарегистрирован» ставится даже при отказе регистрации",
      pattern: "  if (!res || res.ok !== true) {",
      replacement: "  if (false) {" },
    { name: "403 не сбрасывает пометку «зарегистрирован» (канал навсегда остаётся в v1)",
      pattern: "          if (kidHex) _chanKeyRegistered.delete(relay.url + '::' + kidHex);",
      replacement: "          void 0;" },
    { name: "подпись не попадает в тело публикации",
      pattern: "          sig, // ADR-002: null для личных/старых сборок, base64url для канала",
      replacement: "          sig: null," },
  ],
};
