// Набор мутаций: messages-mut
// Цель: убедиться, что смоук messages-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'messages-mut',
  file: 'src/features/messages.js',
  smoke: 'messages-smoke.mjs',
  mutations: [
    { name: "без ключа пира чат всё равно грузится",
      pattern: "      if (!identityStore.state.peerKeys[email]) {\n        deps.chat.set([]);\n        return;\n      }",
      replacement: "      if (false) {\n        deps.chat.set([]);\n        return;\n      }" },
    { name: "дубль по id конверта не отсекается",
      pattern: "          if (!dedup.has(r.id)) dedup.set(r.id, r);",
      replacement: "          dedup.set(r.id, r);" },
    // stale-функция — ЕДИНСТВЕННОЕ место, где решается «актуальна ли
    // загрузка». Мутация guard'а маскируется другими guard'ами (их несколько),
    // а здесь ломается САМА проверка.
    { name: "устаревшая загрузка применяется (сообщения чужого чата)",
      pattern: "      const stale = () => seq !== deps.getLoadSeq() || chatUi.activeChat !== chat;",
      replacement: "      const stale = () => false;" },
    { name: "история не показывается до мержа",
      pattern: "      await deps.showHistoryFirst(chat, stale);",
      replacement: "      void 0;" },
    // Статус применяется в ТРЁХ местах (список, merged через statusById,
    // merged напрямую) — мутация одной точки маскируется остальными. Поэтому
    // бьём ИСТОЧНИК: квитанции не собираются вовсе.
    // Роутер сигналов теперь в Rust (ADR-005 W4): квитанцию определяет ядро,
    // JS только исполняет. Мутация бьёт по ветке исполнения.
    { name: "квитанции о прочтении не собираются (статус всегда delivered)",
      pattern: "                if (sig.kind === 'ack') {",
      replacement: "                if (false) {" },
    { name: "реакции не собираются (реакция уходит в чат сообщением)",
      pattern: "                if (sig.kind === 'reaction') {",
      replacement: "                if (false) {" },
    { name: "правки не собираются (правка уходит в чат сообщением)",
      pattern: "                if (sig.kind === 'edit') {",
      replacement: "                if (false) {" },
  ],
};
