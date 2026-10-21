// Набор мутаций: calls-deps-mut
// Цель: убедиться, что смоук calls-deps-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'calls-deps-mut',
  file: 'src/features/calls.js',
  smoke: 'calls-deps-smoke.mjs',
  mutations: [
    { name: "перезвонить можно во время активного звонка",
      pattern: "      && canCached(callState, 'can_call_back')",
      replacement: "      && true" },
    { name: "перезвонить можно в групповом чате",
      pattern: "      && activeChatType === 'chat'",
      replacement: "      && true" },
    { name: "перезвонить можно без ключа пира",
      pattern: "      && peerKeys[activeChat]);",
      replacement: "      && true);" },
    { name: "микрофон не переключается",
      pattern: "  const muted = !deps.callMuted();",
      replacement: "  const muted = deps.callMuted();" },
    { name: "динамик не переключается",
      pattern: "  const speaker = !deps.callSpeaker();",
      replacement: "  const speaker = deps.callSpeaker();" },
    { name: "подпись звонка не показывает длительность",
      pattern: "    label += ' · ' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');",
      replacement: "    void 0;" },
    { name: "неизвестный вид события подменяется пустой строкой",
      pattern: "  }[ev.kind] || 'call_missed';",
      replacement: "  }[ev.kind] || '';" },
  ],
};
