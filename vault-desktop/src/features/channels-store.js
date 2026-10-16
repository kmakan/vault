// ADR-004 J.5d: owner для channel state (быв. data this.channelPosts /
// this.channelUnread в App.vue). channels.js/forward.js читают через
// ctx.channelPosts/ctx.channelUnread — вынос в singleton, App.data proxy inj.
export function createChannelsStore() {
  const state = {
    channelPosts: {},    // channelId -> [{ts, body, images, sender}]
    channelUnread: {},   // channelId -> count
    channelAvatars: {},  // channelId -> dataUrl (из meta-конвертов)
    currentChannel: null, // активный канал в UI (null = чат/группа)
  };
  return {
    state,
    setChannelPosts(chId, arr) { state.channelPosts[chId] = arr || []; return state.channelPosts[chId]; },
    addChannelPosts(chId, posts) {
      const existing = state.channelPosts[chId] || [];
      state.channelPosts[chId] = [...existing, ...(posts || [])];
      return state.channelPosts[chId];
    },
    getChannelPosts(chId) { return state.channelPosts[chId] || []; },
    setUnread(chId, count) { state.channelUnread[chId] = count || 0; return state.channelUnread[chId]; },
    clearUnread(chId) { state.channelUnread[chId] = 0; },
    setChannelAvatar(chId, dataUrl) { state.channelAvatars[chId] = dataUrl || ''; return state.channelAvatars[chId]; },
    getChannelAvatar(chId) { return state.channelAvatars[chId] || ''; },
    setCurrentChannel(ch) { state.currentChannel = ch ?? null; return state.currentChannel; },
    reset() { state.channelPosts = {}; state.channelUnread = {}; state.channelAvatars = {}; state.currentChannel = null; },
  };
}
export const channelsStore = createChannelsStore();
