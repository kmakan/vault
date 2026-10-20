// Набор мутаций: relay-store-mut
// Цель: убедиться, что смоук relay-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'relay-store-mut',
  file: 'src/features/relay-store.js',
  smoke: 'relay-store-smoke.mjs',
  mutations: [
    { name: "счётчик фейлов релея не растёт",
      pattern: "    bumpRelayFails() { this.state.relayFails += 1; return this.state.relayFails; }",
      replacement: "    bumpRelayFails() { return this.state.relayFails; }" },
    { name: "сброс счётчика фейлов не работает",
      pattern: "    resetRelayFails() { this.state.relayFails = 0; return this.state.relayFails; }",
      replacement: "    resetRelayFails() { return this.state.relayFails; }" },
    { name: "эко-автономность не переключается",
      pattern: "    setEcoAutonomous(v) { this.state.ecoAutonomous = !!v; return this.state.ecoAutonomous; }",
      replacement: "    setEcoAutonomous(v) { return this.state.ecoAutonomous; }" },
    { name: "метка обрыва связи не пишется",
      pattern: "    setRelayOfflineSince(v) { this.state.relayOfflineSince = v; return this.state.relayOfflineSince; }",
      replacement: "    setRelayOfflineSince(v) { return this.state.relayOfflineSince; }" },
    { name: "режим доставки не переключается",
      pattern: "    setRelayMode(mode) {\n      this.state.relayDeliveryMode = mode;",
      replacement: "    setRelayMode(mode) {\n      void 0;" },
  ],
};
