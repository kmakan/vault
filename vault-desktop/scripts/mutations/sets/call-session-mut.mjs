// Набор мутаций: call-session-mut
// Цель: убедиться, что смоук call-session-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'call-session-mut',
  file: 'src/features/call-session.js',
  smoke: 'call-session-smoke.mjs',
  mutations: [
    { name: "состояние звонка не пишется",
      pattern: "    setCallState(v) { this.state.callState = v; _notify(); },",
      replacement: "    setCallState(v) { _notify(); }," },
    { name: "подписчики не будит при изменении состояния",
      pattern: "    setMuted(v) { this.state.callMuted = !!v; _notify(); },",
      replacement: "    setMuted(v) { this.state.callMuted = !!v; }," },
    { name: "микрофон не приводится к boolean",
      pattern: "    setSpeaker(v) { this.state.callSpeaker = !!v; _notify(); },",
      replacement: "    setSpeaker(v) { this.state.callSpeaker = v; _notify(); }," },
    { name: "часы звонка не сбрасываются при старте",
      pattern: "      this.state.callClockSec = 0;",
      replacement: "      void 0;" },
    { name: "таймер часов не кладётся в состояние",
      pattern: "      this.state.callClockTimer = h;",
      replacement: "      void 0;" },
    { name: "остановка часов не чистит таймер в состоянии",
      pattern: "      this.state.callClockTimer = null;",
      replacement: "      void 0;" },
    { name: "удалённый offer не записывается",
      pattern: "      if (remote !== undefined) this.state.remoteOffer = remote;",
      replacement: "      void 0;" },
    { name: "reset не сбрасывает состояние (пишет в копию)",
      pattern: "    reset() {\n      Object.assign(this.state, {",
      replacement: "    reset() {\n      Object.assign({}, {" },
  ],
};
