// Набор мутаций: incoming-routing-mut
// Цель: убедиться, что смоук incoming-routing-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'incoming-routing-mut',
  file: 'src/features/incoming.js',
  smoke: 'incoming-routing-smoke.mjs',
  mutations: [
    { name: "письма обрабатываются без готовой криптографии",
      pattern: "  if (!fetched || !fetched.length || !deps.cryptoReady) return;",
      replacement: "  if (!fetched || !fetched.length) return;" },
    { name: "свои письма не отбрасываются",
      pattern: "    if (!from || from === myEmail) continue;",
      replacement: "    if (!from) continue;" },
    { name: "неизвестный класс конверта не отбрасывается",
      pattern: "    if (cls === null) continue;",
      replacement: "    void 0;" },
    { name: "обычные сообщения не обрабатываются",
      pattern: "    if (cls.kind === 'message') {",
      replacement: "    if (false) {" },
    { name: "заблокированный отправитель не отбрасывается",
      pattern: "  if (deps.isIgnored(from)) return null;",
      replacement: "  void 0;" },
    { name: "незашифрованное тело принимается как конверт",
      pattern: "  if (!body || !crypto.isEncrypted(body)) return null;",
      replacement: "  if (!body) return null;" },
    { name: "без ключа пира конверт идёт по общему пути",
      pattern: "  if (deps.peerKeys[from]) {",
      replacement: "  if (true) {" },
  ],
};
