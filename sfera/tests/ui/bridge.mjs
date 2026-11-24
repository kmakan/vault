#!/usr/bin/env node
// Гейт UI-адаптера: вызовы и DTO, без бизнес-логики в JS.
import { createBridge, COMMANDS } from '../../src/ui/bridge.js';

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }
function check(cond, msg) { if (!cond) fail(msg); }

const calls = [];
const bridge = createBridge(async (name, args) => {
  calls.push({ name, args });
  if (name === COMMANDS.apiVersion) return 1;
  if (name === COMMANDS.linkStatus) return { linked: false, account_fp: null };
  if (name === COMMANDS.identity) return { v: 1, fp: 'aa:bb', pub_key: '00' };
  if (name === COMMANDS.feed) return [{ id: 'p1' }];
  if (name === COMMANDS.contacts) return [{ fp: 'aa:bb' }];
  if (name === COMMANDS.audiences) return [{ id: 'sphere_close' }];
  if (name === COMMANDS.publishPost) return { v: 1, id: 'p2' };
  if (name === COMMANDS.profile) return { v: 1 };
  if (name === COMMANDS.storeCaps) return { kind: 'Local' };
  if (name === COMMANDS.companion) return { install: false, target: 'vault://open' };
  if (name === COMMANDS.plans) return [{ months: 1, kopecks: 14900 }];
  if (name === COMMANDS.planFor) return { months: 12, kopecks: 149000 };
  if (name === COMMANDS.mediaKind) return 'Video';
  if (name === COMMANDS.orgAllowsMedia) return false;
  if (name === COMMANDS.uploadAvatar) {
    return { v: 1, avatar: { blob_id: 'aa', mime: 'image/png', size: 3 } };
  }
  if (name === COMMANDS.libraryOpen) {
    return { v: 1, blob_id: 'aa', mime: 'image/png', kind: 'Image', size: 3, data_base64: 'AAA' };
  }
  if (name === COMMANDS.libraryStream) {
    return { v: 1, blob_id: 'aa', mime: 'video/mp4', size: 9, url: 'sfera-media://localhost/aa' };
  }
  if (name === COMMANDS.libraryThumb) {
    return { v: 1, blob_id: 'aa', mime: 'image/jpeg', kind: 'Image', size: 3, data_base64: 'AAA' };
  }
  if (name === COMMANDS.audienceMembers) {
    return { v: 1, id: 'sphere_close', epoch: 2, members: ['aa:bb'] };
  }
  if (name === COMMANDS.setAudienceMembers) return { v: 1, changed: true };
  if (name === COMMANDS.setMyProfile) return { v: 1, outcome: 'inserted' };
  if (name === COMMANDS.syncStatus) return { v: 1, pending: 2, failed: 0, due: 0, has_transport: false };
  if (name === COMMANDS.roleOptions) {
    return [{ value: 'friend', can_view_media: true, can_react: true, can_view_history: false, can_request_chat: true, profile: 'full' }];
  }
  if (name === COMMANDS.setContactRole) return null;
  return null;
});

check((await bridge.apiVersion()) === 1, 'api version passed through');
check((await bridge.linkStatus()).linked === false, 'link status passed through');
check((await bridge.identity()).fp === 'aa:bb', 'identity DTO');
check((await bridge.feed()).length === 1, 'feed DTO');
check((await bridge.contacts()).length === 1, 'contacts DTO');
check((await bridge.audiences())[0].id === 'sphere_close', 'audiences DTO');
const req = { v: 1, ts: 1, body: 'hi', audience: { id: 'a' }, media: [], now: 1 };
check((await bridge.publishPost(req)).id === 'p2', 'publish DTO');
check((await bridge.profile('aa:bb')).v === 1, 'profile DTO');
check((await bridge.storeCaps()).kind === 'Local', 'caps DTO');

const companion = await bridge.companionAction(true);
check(companion.install === false, 'companion install flag');
check(companion.target === 'vault://open', 'companion target');
check(companion.labelKey === 'companion_open', 'companion label comes from UI keys');

const plans = await bridge.plans({ plans: [] });
check(plans.length === 1, 'plans DTO passed through');
const plan = await bridge.planFor({ plans: [] }, 12);
check(plan.months === 12, 'plan_for passed through');
check((await bridge.mediaKind('video/mp4')) === 'Video', 'media kind from Rust');
check((await bridge.orgAllowsMedia('viewer')) === false, 'org rights from Rust');
const avatar = await bridge.uploadAvatar('image/png', 'AAA');
check(avatar.avatar.blob_id === 'aa', 'avatar ref from Rust');
const content = await bridge.libraryOpen('aa');
check(content.kind === 'Image' && content.data_base64 === 'AAA', 'library content from Rust');
const thumb = await bridge.libraryThumb('aa');
check(thumb.mime === 'image/jpeg', 'thumbnail from Rust');
const stream = await bridge.libraryStream('aa');
check(stream.url === 'sfera-media://localhost/aa' && stream.size === 9, 'stream URL from Rust');
const members = await bridge.audienceMembers('sphere_close');
check(members.epoch === 2 && members.members.length === 1, 'audience members from Rust');
const changed = await bridge.setAudienceMembers({ v: 1, id: 'sphere_close', members: ['aa:bb'] });
check(changed.changed === true, 'membership change from Rust');
const saved = await bridge.setMyProfile({
  v: 1, ts: 1, display_name: 'Ann', bio: '', avatar: null, links: [], now: 1,
});
check(saved.outcome === 'inserted', 'profile save outcome');
const sync = await bridge.syncStatus(1000);
check(sync.pending === 2 && sync.has_transport === false, 'sync status from Rust');
const roles = await bridge.roleOptions();
check(roles[0].value === 'friend' && roles[0].profile === 'full', 'role presets from Rust');
await bridge.setContactRole({ v: 1, fp: 'aa:bb', role: 'friend' });

check(calls.length === 24, `expected 24 invoke calls, got ${calls.length}`);
check(calls.every((c) => typeof c.name === 'string'), 'command names');
check(calls[9].args.deepLinkHandled === true, 'companion arg');
check(calls[13].args.role === 'viewer', 'org role arg');
check(calls[14].args.dataBase64 === 'AAA', 'avatar bytes passed to Rust');
check(calls[15].args.blobId === 'aa', 'library open arg');
check(calls[16].args.blobId === 'aa', 'library thumb arg');
check(calls[17].args.blobId === 'aa', 'library stream arg');
check(calls[18].args.id === 'sphere_close', 'audience members arg');
check(calls[19].args.req.id === 'sphere_close', 'set members arg');
check(calls[20].args.req.display_name === 'Ann', 'profile request passed unchanged');
check(calls[21].args.now === 1000, 'sync status time passed through');
check(calls[22].name === COMMANDS.roleOptions, 'role options command');
check(calls[23].args.req.role === 'friend' && calls[23].args.req.fp === 'aa:bb', 'role request passed unchanged');
check(calls[6].args.req === req, 'publish request passed unchanged');

let threw = false;
try { createBridge(null); } catch { threw = true; }
check(threw, 'missing invoke must fail early');

console.log('OK: Sfera UI adapter — вызовы Rust-команд без логики в JS');
