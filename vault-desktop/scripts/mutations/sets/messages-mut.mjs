// Набор мутаций: messages-mut
// Цель: убедиться, что смоук messages-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'messages-mut',
  file: 'src/features/messages.js',
  smoke: 'messages-smoke.mjs',
  mutations: [
    { name: "без ключа пира чат всё равно грузится",
      pattern: "      if (!(await peerContactFor(email, identityStore.state.peerKeys, myEmail())).key) {",
      replacement: "      if (false) {" },
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
    // ПРАВИЛО ИСЧЕЗНОВЕНИЯ (22.10): история — только когда показывать нечего.
    // Снятие условия возвращает дефект: оптимистичное сообщение исчезает при
    // ближайшем поллинге.
    { name: "история подставляется на живой экран (оптимистичное исчезает)",
      pattern: "      if (!(deps.chat.state.messages || []).length) {\n        await deps.showHistoryFirst(chat, stale);\n      }",
      replacement: "      await deps.showHistoryFirst(chat, stale);" },
    { name: "пустой результат затирает живой экран",
      pattern: "        if (!merged.length) {",
      replacement: "        if (false) {" },
    { name: "томбстоун-очистка не работает (удалённое живёт вечно)",
      pattern: "          if (merged0.length) {",
      replacement: "          if (false) {" },
    { name: "гард актуальности перед перезаписью экрана снят",
      pattern: "        if (stale()) return;\n        if (!merged.length) {",
      replacement: "        void 0;\n        if (!merged.length) {" },
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
