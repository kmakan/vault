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

const bridge = {
  apiVersion: async () => 7,
  linkStatus: async () => ({ linked: false, account_fp: null }),
  identity: async () => ({ v: 7, fp: 'aa:bb', pub_key: '00' }),
  feed: async () => {
    if (failFeed) throw new Error('feed down');
    return [{ id: 'p1' }];
  },
  contacts: async () => [{ fp: 'aa:bb', role: 'friend' }],
  audiences: async () => [audience],
  audienceMembers: async (id) => ({ v: 7, id, epoch: 1, members: [...sphereMembers] }),
  setAudienceMembers: async (req) => {
    sphereMembers = [...req.members];
    return { v: 7, changed: true };
  },
  storeCaps: async () => ({ kind: 'Local', range: true }),
  profile: async () => myProfile,
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
  uploadMedia: async (mime) => ({
    v: 7, blob_id: 'av1', mime, size: 12, kind: 'Image', file_key_hex: '00',
  }),
  libraryItems: async () => [],
  libraryForget: async () => true,
  libraryOpen: async (blobId) => ({
    v: 7, blob_id: blobId, mime: 'image/png', kind: 'Image', size: 3, data_base64: 'AAA',
  }),
  libraryThumb: async (blobId) => ({
    v: 7, blob_id: blobId, mime: 'image/jpeg', kind: 'Image', size: 3, data_base64: 'AAA',
  }),
  mediaKind: async (mime) => (mime.startsWith('image/') ? 'Image' : 'Document'),
  publishPost: async (req) => { calls.push(req); return { v: 7, id: 'p2', ts: req.ts }; },
  companionAction: async (handled) => ({ install: !handled, target: 'vault://open' }),
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
check(s.contacts.length === 1, 'contacts loaded');
check(s.audiences[0].id === 'sphere_close', 'audiences loaded');
check(s.audienceMembers.sphere_close.members.length === 1, 'sphere members loaded on init');
check(s.myProfile.profile.display_name === 'Ann', 'own profile loaded');
check(s.caps.kind === 'Local', 'caps loaded');

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

bridge.libraryOpen = async (blobId) => ({
  v: 7, blob_id: blobId, mime: 'video/mp4', kind: 'Video', size: 9, data_base64: 'AAA',
});
await api.openFile('blob-3');
check(s.previewUrl === 'data:video/mp4;base64,AAA', 'video plays inline');
api.closePreview();
bridge.libraryOpen = async (blobId) => ({
  v: 7, blob_id: blobId, mime: 'audio/ogg', kind: 'Audio', size: 9, data_base64: 'AAA',
});
await api.openFile('blob-4');
check(s.previewUrl === 'data:audio/ogg;base64,AAA', 'audio plays inline');
api.closePreview();

s.library = [{ blob_id: 'b1', thumb_blob_id: 't1' }];
s.feed = [{ id: 'p1', post: { post: { media: [{ blob_id: 'b2', thumb_blob_id: 't2' }] } } }];
await api.loadThumbs();
check(s.thumbs.b1 === 'data:image/jpeg;base64,AAA', 'library thumbnail loaded');
check(s.thumbs.b2 === 'data:image/jpeg;base64,AAA', 'feed media thumbnail loaded');

const change = await api.setAudienceMembers({ id: 'sphere_close', members: ['aa:bb', 'cc:dd'] });
check(change.changed === true, 'membership change passed through');
check(s.audienceMembers.sphere_close.members.length === 2, 'members reloaded after save');

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

failFeed = true;
const loaded = await api.loadFeed();
check(loaded === null && s.error === 'feed down', 'bridge error is surfaced, not hidden');

console.log('OK: Sfera UI state — вызовы Rust, версия и адресат не изобретаются в JS');
