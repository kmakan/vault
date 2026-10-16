// ADR-004 J.5d: owner для channel state (быв. data this.channelPosts /
// this.channelUnread в App.vue). channels.js/forward.js читают через
// ctx.channelPosts/ctx.channelUnread — вынос в singleton, App.data proxy inj.
export function createChannelsStore() {
  const state = {
    channelPosts: {},    // channelId -> [{ts, body, images, sender}]
    channelUnread: {},   // channelId -> count
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
    reset() { state.channelPosts = {}; state.channelUnread = {}; },
  };
}
export const channelsStore = createChannelsStore();
