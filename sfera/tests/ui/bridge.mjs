#!/usr/bin/env node
// Гейт UI-адаптера: вызовы и DTO, без бизнес-логики в JS.
import { createBridge, COMMANDS } from '../../src/ui/bridge.js';

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }
function check(cond, msg) { if (!cond) fail(msg); }

const calls = [];
const bridge = createBridge(async (name, args) => {
  calls.push({ name, args });
  if (name === COMMANDS.companion) return { install: false, target: 'vault://open' };
  if (name === COMMANDS.plans) return [{ months: 1, kopecks: 14900 }];
  if (name === COMMANDS.planFor) return { months: 12, kopecks: 149000 };
  if (name === COMMANDS.mediaKind) return 'Video';
  if (name === COMMANDS.orgAllowsMedia) return false;
  return null;
});

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

check(calls.length === 5, `expected 5 invoke calls, got ${calls.length}`);
check(calls.every((c) => typeof c.name === 'string'), 'command names');
check(calls[0].args.deepLinkHandled === true, 'companion arg');
check(calls[4].args.role === 'viewer', 'org role arg');

let threw = false;
try { createBridge(null); } catch { threw = true; }
check(threw, 'missing invoke must fail early');

console.log('OK: Sfera UI adapter — вызовы Rust-команд без логики в JS');
