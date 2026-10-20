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
    { name: "квитанции о прочтении не собираются (статус всегда delivered)",
      pattern: "                if (robj && (robj.read === 1 || robj.delivered === 1) && Array.isArray(robj.msg_ids)) {",
      replacement: "                if (false) {" },
  ],
};
