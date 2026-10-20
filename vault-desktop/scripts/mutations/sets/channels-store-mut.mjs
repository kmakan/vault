// Набор мутаций: channels-store-mut
// Цель: убедиться, что смоук channels-store-smoke.mjs ЛОВИТ эти поломки.
// Если мутация выжила — смоук ничего не проверяет (урок ADR-005 §2.3).

export default {
  id: 'channels-store-mut',
  file: 'src/features/channels-store.js',
  smoke: 'channels-store-smoke.mjs',
  mutations: [
    { name: "посты канала не заменяются, а дописываются",
      pattern: "    setChannelPosts(chId, arr) { this.state.channelPosts[chId] = arr || []; return this.state.channelPosts[chId]; }",
      replacement: "    setChannelPosts(chId, arr) { this.state.channelPosts[chId] = [...(this.state.channelPosts[chId] || []), ...(arr || [])]; return this.state.channelPosts[chId]; }" },
    { name: "посты не прибавляются",
      pattern: "      this.state.channelPosts[chId] = [...existing, ...(posts || [])];",
      replacement: "      this.state.channelPosts[chId] = existing;" },
    { name: "счётчик непрочитанных не обнуляется",
      pattern: "    clearUnread(chId) { this.state.channelUnread[chId] = 0; }",
      replacement: "    clearUnread(chId) { void 0; }" },
    { name: "сброс не чистит аватары",
      pattern: "    reset() { this.state.channelPosts = {}; this.state.channelUnread = {}; this.state.channelAvatars = {}; this.state.currentChannel = null; }",
      replacement: "    reset() { this.state.channelPosts = {}; this.state.channelUnread = {}; this.state.currentChannel = null; }" },
  ],
};
