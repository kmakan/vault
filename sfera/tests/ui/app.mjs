#!/usr/bin/env node
// Гейт состояния UI: оркестрация вызовов Rust, без правил в JS.
import { createAppState } from '../../src/ui/app.js';

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }
function check(cond, msg) { if (!cond) fail(msg); }

const audience = { id: 'sphere_close', epoch: 1, spec: { Sphere: { id: 'sphere_close' } } };
const calls = [];
let failFeed = false;
let sphereMembers = ['aa:bb'];
let myProfile = { profile: { display_name: 'Ann', bio: '', links: [] }, sig: 'x' };
let contactRole = 'friend';
let roleRequest = null;
let streamCalls = [];
let openCalls = [];
let receivedProfile = null;
let avatarCalls = [];
let inboxCalls = 0;

const bridge = {
  apiVersion: async () => 7,
  linkStatus: async () => ({ linked: false, account_fp: null }),
  identity: async () => ({ v: 7, fp: 'aa:bb', pub_key: '00' }),
  feed: async () => {
    if (failFeed) throw new Error('feed down');
    return [{ id: 'p1' }];
  },
  contacts: async () => [{ fp: 'peer:fp', role: contactRole }, { fp: 'aa:bb', role: contactRole }],
  roleOptions: async () => [
    { value: 'friend', can_view_media: true, can_react: true, can_view_history: false, can_request_chat: true, profile: 'full' },
    { value: 'restricted', can_view_media: false, can_react: false, can_view_history: false, can_request_chat: false, profile: 'none' },
  ],
  setContactRole: async (req) => {
    roleRequest = req;
    contactRole = req.role;
    return null;
  },
  audiences: async () => [audience],
  audienceMembers: async (id) => ({ v: 7, id, epoch: 1, members: [...sphereMembers] }),
  setAudienceMembers: async (req) => {
    sphereMembers = [...req.members];
    return { v: 7, changed: true };
  },
  storeCaps: async () => ({ kind: 'Local', range: true }),
  profile: async (fp) => fp === 'peer:fp' ? receivedProfile : myProfile,
  receiveInbox: async () => {
    inboxCalls += 1;
    return { scanned: 2, candidates: 1, accepted: 1, duplicates: 0, rejected: 0 };
  },
  openReceivedAvatar: async (id) => {
    avatarCalls.push(id);
    return { v: 7, blob_id: 'remote-avatar', mime: 'image/png', kind: 'Image', size: 3, data_base64: 'REMOTE' };
  },
  setMyProfile: async (req) => {
    myProfile = {
      profile: {
        display_name: req.display_name,
        bio: req.bio,
        avatar: req.avatar ?? null,
        links: req.links,
      },
      sig: 'x',
    };
    return { v: 7, outcome: 'inserted' };
  },
  uploadAvatar: async (mime) => ({
    v: 7, avatar: { blob_id: 'av1', mime, size: 12 },
  }),
  libraryItems: async () => [],
  libraryForget: async () => true,
  libraryOpen: async (blobId) => {
    openCalls.push(blobId);
    return {
      v: 7, blob_id: blobId, mime: 'image/png', kind: 'Image', size: 3, data_base64: 'AAA',
    };
  },
  libraryStream: async (blobId) => {
    streamCalls.push(blobId);
    const mime = blobId === 'blob-3' ? 'video/mp4' : 'audio/ogg';
    return {
      v: 7, blob_id: blobId, mime, size: 9,
      url: `sfera-media://localhost/${blobId}`,
    };
  },
  libraryThumb: async (blobId) => ({
    v: 7, blob_id: blobId, mime: 'image/jpeg', kind: 'Image', size: 3, data_base64: 'AAA',
  }),
  mediaKind: async (mime) => (mime.startsWith('image/') ? 'Image' : 'Document'),
  syncStatus: async () => ({ v: 7, pending: 2, failed: 0, due: 0, has_transport: false }),
  publishPost: async (req) => { calls.push(req); return { v: 7, id: 'p2', ts: req.ts }; },
  discussion: async (postId) => ({
    v: 7, post_id: postId, comments: [], reactions: [{ emoji: '❤️', count: 1, authors: [] }],
  }),
  commentOnPost: async (req) => { calls.push({ command: 'comment', ...req }); return { comment: { id: 'c1' } }; },
  reactToPost: async (req) => { calls.push({ command: 'reaction', ...req }); return { reaction: { version: 1 } }; },
  companionAction: async (handled) => ({ install: !handled, target: 'vault://open' }),
  publicChannels: async () => [{ v: 7, id: 'news', title: 'Новости', description: '', creator_fp: 'aa:bb', created_at: 1, posts: 1, latest_ts: 1000 }],
  publicChannel: async (id) => ({
    v: 7,
    channel: { v: 7, id, title: 'Новости', description: '', creator_fp: 'aa:bb', created_at: 1, posts: 1, latest_ts: 1000 },
    posts: [{ id: 'pub1', ts: 1000, body: 'публичный пост' }],
  }),
  createPublicChannel: async (req) => {
    calls.push({ command: 'create-channel', ...req });
    return { v: 7, id: req.id, title: req.title, description: req.description, creator_fp: 'aa:bb', created_at: req.now, posts: 0, latest_ts: null };
  },
  publishPublicPost: async (req) => {
    calls.push({ command: 'publish-public', ...req });
    return { id: 'pub2', ts: req.ts, body: req.body };
  },
  syncPublicChannel: async (req) => {
    calls.push({ command: 'sync-public', ...req });
    return { channel: req.channel_id, inserted: 1, duplicates: 0, posts: 2 };
  },
};

const api = createAppState({ bridge, locale: 'ru', theme: 'dark', clock: () => 1000 });
const s = api.state;

check(s.tab === 'feed', 'default tab');
check(s.locale === 'ru', 'default locale');
check(s.theme === 'dark', 'default theme');

await api.init();
check(s.apiVersion === 7, 'api version comes from Rust');
check(s.link.linked === false, 'link status loaded');
check(s.identity.fp === 'aa:bb', 'identity loaded');
check(s.feed.length === 1, 'feed loaded');
check(s.publicChannels.length === 1 && s.publicChannels[0].id === 'news', 'public channels loaded');
check(s.contacts.length === 2, 'contacts loaded');
check(s.roleOptions.length === 2 && s.roleOptions[0].value === 'friend', 'role presets loaded from Rust');
check(s.audiences[0].id === 'sphere_close', 'audiences loaded');
check(s.audienceMembers.sphere_close.members.length === 1, 'sphere members loaded on init');
check(s.myProfile.profile.display_name === 'Ann', 'own profile loaded');
check(s.caps.kind === 'Local', 'caps loaded');
check(s.sync?.pending === 2 && s.sync.has_transport === false, 'sync status loaded');
check(s.lastSyncAt === 1000, 'last sync time from injected clock');

receivedProfile = {
  profile: { display_name: 'Peer', bio: '', avatar: { blob_id: 'remote', profile_id: 'peer-profile-id' }, links: [] },
  sig: 'signed',
};
const received = await api.receiveInbox();
check(inboxCalls === 1 && received.accepted === 1, 'explicit IMAP cycle');
check(s.receiveReport.accepted === 1, 'receive report comes from Rust');
check(s.contactProfiles['peer:fp'].profile.display_name === 'Peer', 'received profile shown by fingerprint');
check(s.contactProfiles['aa:bb'].profile.display_name === 'Ann', 'own profile is not replaced by peer');
check(avatarCalls.join(',') === 'peer-profile-id', 'avatar lookup uses Rust profile id, not blob id');
check(s.contactAvatars['peer:fp'] === 'data:image/png;base64,REMOTE', 'received avatar rendered from Rust bytes');
receivedProfile = { profile: { display_name: 'Peer', bio: '', avatar: null, links: [] }, sig: 'signed' };
await api.loadContactProfile('peer:fp');
check(!s.contactAvatars['peer:fp'], 'removing remote avatar clears stale preview');

check(api.openTab('profile') && s.tab === 'profile', 'tab switch');
check(!api.openTab('billing') && s.tab === 'profile', 'unknown tab rejected');

api.setDraft('unfinished post');
check(s.draft === 'unfinished post', 'composer draft survives tab switches');
api.setDraft(null);
check(s.draft === '', 'empty draft is normalized');

check(api.setLocale('en') && s.locale === 'en', 'locale switch');
check(!api.setLocale('xx') && s.locale === 'en', 'unknown locale rejected');
check(api.setTheme('light') && s.theme === 'light', 'theme switch');
check(!api.setTheme('neon') && s.theme === 'light', 'unknown theme rejected');
check(api.themeVars()['--bg-primary'] === '#ffffff', 'theme vars from theme registry');
check(api.t('nav_feed') === 'Feed', 'translate uses active locale');
check((await api.mediaKind('image/png')) === 'Image', 'media kind comes from Rust');

const content = await api.openFile('blob-1');
check(content.kind === 'Image', 'opened file comes from Rust');
check(s.preview.blob_id === 'blob-1', 'preview is set');
check(s.previewUrl === 'data:image/png;base64,AAA', 'image preview url for display only');
api.closePreview();
check(s.preview === null && s.previewUrl === null, 'preview closed');

bridge.libraryOpen = async (blobId) => ({
  v: 7, blob_id: blobId, mime: 'application/pdf', kind: 'Document', size: 9, data_base64: 'AAA',
});
const doc = await api.openFile('blob-2');
check(doc.kind === 'Document' && s.previewUrl === null, 'documents have no inline preview');
await api.forgetFile('blob-2');
check(s.preview === null && s.previewUrl === null, 'forgetting open file closes preview');

s.library = [
  { blob_id: 'blob-3', kind: 'Video', mime: 'video/mp4' },
  { blob_id: 'blob-4', kind: 'Audio', mime: 'audio/ogg' },
];
const beforeStream = openCalls.length;
const video = await api.openFile('blob-3');
check(video.kind === 'Video', 'video kind comes from the catalog');
check(s.previewUrl === 'sfera-media://localhost/blob-3', 'video streams from Rust URL');
api.closePreview();
const audio = await api.openFile('blob-4');
check(s.previewUrl === 'sfera-media://localhost/blob-4', 'audio streams from Rust URL');
check(streamCalls.join(',') === 'blob-3,blob-4', 'stream command used for media');
check(openCalls.length === beforeStream, 'audio/video are not read as whole base64');
api.closePreview();

s.library = [{ blob_id: 'b1', thumb_blob_id: 't1' }];
s.feed = [{ id: 'p1', post: { post: { media: [{ blob_id: 'b2', thumb_blob_id: 't2' }] } } }];
await api.loadThumbs();
check(s.thumbs.b1 === 'data:image/jpeg;base64,AAA', 'library thumbnail loaded');
check(s.thumbs.b2 === 'data:image/jpeg;base64,AAA', 'feed media thumbnail loaded');

const change = await api.setAudienceMembers({ id: 'sphere_close', members: ['aa:bb', 'cc:dd'] });
check(change.changed === true, 'membership change passed through');
check(s.audienceMembers.sphere_close.members.length === 2, 'members reloaded after save');

await api.setContactRole('aa:bb', 'restricted');
check(roleRequest.v === 7 && roleRequest.fp === 'aa:bb' && roleRequest.role === 'restricted', 'role change carries wire version from Rust');
check(s.contacts[0].role === 'restricted', 'contacts reloaded after role change');
let roleThrew = false;
try { await api.setContactRole('', 'friend'); } catch { roleThrew = true; }
check(roleThrew, 'missing fp rejected before Rust');

const saved = await api.saveProfile({
  displayName: 'Ann2', bio: 'hi', links: [{ label: 'site', url: 'https://x' }],
});
check(saved.outcome === 'inserted', 'profile save outcome');
check(s.myProfile.profile.display_name === 'Ann2', 'profile reloaded after save');
let nameThrew = false;
try { await api.saveProfile({ displayName: '   ' }); } catch { nameThrew = true; }
check(nameThrew, 'empty display name rejected before Rust');

// FileReader — граница браузера; в тесте только отдаём готовый data URL.
globalThis.FileReader = class {
  readAsDataURL(file) {
    this.result = `data:${file.type};base64,AAAA`;
    queueMicrotask(() => this.onload?.());
  }
};
await api.uploadAvatar({ type: 'image/png' });
check(s.uploads.length === 0, 'avatar does not enter post attachments');
check(s.avatarDraft?.blob_id === 'av1', 'avatar draft points at uploaded blob');
await api.saveProfile({ displayName: 'Ann3' });
check(s.myProfile.profile.avatar?.blob_id === 'av1', 'avatar saved with profile');
api.clearAvatar();
check(s.avatarDraft === null, 'avatar can be removed before save');
let avatarThrew = false;
try { await api.uploadAvatar({ type: 'text/plain' }); } catch { avatarThrew = true; }
check(avatarThrew, 'non-image avatar rejected before upload');

s.avatarDraft = { blob_id: 'b9', mime: 'image/png', size: 1 };
await api.forgetFile('b9');
check(s.avatarDraft === null, 'forgetting the avatar blob clears the draft');

let threw = false;
try { await api.publish({ body: '   ', audience }); } catch { threw = true; }
check(threw, 'empty post rejected');
threw = false;
try { await api.publish({ body: 'hello' }); } catch { threw = true; }
check(threw, 'missing audience rejected');

const post = await api.publish({ body: 'hello', audience });
check(post.id === 'p2', 'publish result passed through');
check(calls.length === 1, 'one publish call');
check(calls[0].v === 7, 'wire version from Rust, not hardcoded');
check(calls[0].ts === 1000 && calls[0].now === 1000, 'time comes from injected clock');
check(calls[0].body === 'hello', 'body passed through');
check(calls[0].audience === audience, 'audience passed through unchanged');
check(calls[0].media.length === 0, 'empty media by default');
check(s.discussions.p1.reactions[0].emoji === '❤️', 'discussion summary loaded from Rust');

await api.commentOnPost('p1', 'Ответ');
check(calls.at(-1).command === 'comment' && !('comment_id' in calls.at(-1)), 'comment id is assigned in Rust, not UI');
await api.reactToPost('p1', '❤️');
check(calls.at(-1).command === 'reaction' && !('version' in calls.at(-1)), 'reaction version is assigned in Rust, not UI');

const channelView = await api.loadPublicChannel('news');
check(channelView.posts[0].body === 'публичный пост', 'public channel view comes from Rust');
check(s.publicChannelViews.news.channel.id === 'news', 'public channel view stored by id');

const createdChannel = await api.createPublicChannel('tech', 'Техно', 'Описание');
check(createdChannel.id === 'tech', 'created public channel passed through');
check(calls.at(-1).command === 'create-channel' && calls.at(-1).v === 7, 'channel creation uses Rust version');
check(calls.at(-1).now === 1000, 'channel creation time from clock');

const publicPost = await api.publishPublicPost('news', 'второй пост');
check(publicPost.id === 'pub2', 'public post id from Rust');
check(calls.filter((c) => c.command === 'publish-public').length === 1, 'one public publish call');
const publishCall = calls.find((c) => c.command === 'publish-public');
check(publishCall.channel_id === 'news' && publishCall.body === 'второй пост', 'public publish payload passed through');
check(publishCall.v === 7 && publishCall.ts === 1000 && publishCall.now === 1000, 'public publish version and clock');
check(s.publicChannelViews.news.posts.length === 1, 'channel view refreshed after publish');

const syncReport = await api.syncPublicChannel('news', 'http://127.0.0.1:8095', 'test-token');
check(syncReport.inserted === 1 && syncReport.posts === 2, 'relay report comes from Rust');
check(s.publicSyncReports.news.channel === 'news', 'relay report stored by channel');
const syncCall = calls.find((c) => c.command === 'sync-public');
check(syncCall.v === 7 && syncCall.channel_id === 'news', 'sync uses Rust version and channel id');
check(syncCall.base_url === 'http://127.0.0.1:8095' && syncCall.upload_token === 'test-token', 'relay config passed through');

failFeed = true;
const loaded = await api.loadFeed();
check(loaded === null && s.error === 'feed down', 'bridge error is surfaced, not hidden');

console.log('OK: Sfera UI state — вызовы Rust, версия и адресат не изобретаются в JS');
