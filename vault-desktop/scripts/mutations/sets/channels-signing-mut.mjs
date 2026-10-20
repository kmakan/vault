// Набор мутаций: channels-signing-mut
// Цель: убедиться, что смоук channels-signing-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'channels-signing-mut',
  file: 'src/relay-client.js',
  smoke: 'channels-signing-smoke.mjs',
  mutations: [
    { name: "kid передаётся числом, а не HEX-строкой (потеря точности после 2^53)",
      pattern: "        sig = await invoke('channel_sign_post', { kidHex: kidHexOfToken(read), envId: id, body });",
      replacement: "        sig = await invoke('channel_sign_post', { kidHex: Number(kidHexOfToken(read)), envId: id, body });" },
    { name: "подписывается не та строка, что уйдёт в JSON",
      pattern: "        sig = await invoke('channel_sign_post', { kidHex: kidHexOfToken(read), envId: id, body });",
      replacement: "        sig = await invoke('channel_sign_post', { kidHex: kidHexOfToken(read), envId: id, body: body + ' ' });" },
    { name: "kid считается не из первых 8 байт токена",
      pattern: "  for (let i = 0; i < 8; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');",
      replacement: "  for (let i = 0; i < 4; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, '0');" },
    { name: "пометка «зарегистрирован» ставится даже при отказе регистрации",
      pattern: "  if (!res || res.ok !== true) {",
      replacement: "  if (false) {" },
    { name: "403 не сбрасывает пометку «зарегистрирован» (канал навсегда остаётся в v1)",
      pattern: "          _chanKeyRegistered.delete(relay.url + '::' + kidHexOfToken(read));",
      replacement: "          void 0;" },
    { name: "подпись не попадает в тело публикации",
      pattern: "          sig, // ADR-002: null для личных/старых сборок, base64url для канала",
      replacement: "          sig: null," },
  ],
};
