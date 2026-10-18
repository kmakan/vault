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
    setChannelPosts(chId, arr) { this.state.channelPosts[chId] = arr || []; return this.state.channelPosts[chId]; },
    addChannelPosts(chId, posts) {
      const existing = this.state.channelPosts[chId] || [];
      this.state.channelPosts[chId] = [...existing, ...(posts || [])];
      return this.state.channelPosts[chId];
    },
    getChannelPosts(chId) { return this.state.channelPosts[chId] || []; },
    setUnread(chId, count) { this.state.channelUnread[chId] = count || 0; return this.state.channelUnread[chId]; },
    clearUnread(chId) { this.state.channelUnread[chId] = 0; },
    setChannelAvatar(chId, dataUrl) { this.state.channelAvatars[chId] = dataUrl || ''; return this.state.channelAvatars[chId]; },
    getChannelAvatar(chId) { return this.state.channelAvatars[chId] || ''; },
    setCurrentChannel(ch) { this.state.currentChannel = ch ?? null; return this.state.currentChannel; },
    reset() { this.state.channelPosts = {}; this.state.channelUnread = {}; this.state.channelAvatars = {}; this.state.currentChannel = null; },
  };
}
export const channelsStore = createChannelsStore();
