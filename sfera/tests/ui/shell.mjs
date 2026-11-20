#!/usr/bin/env node
// Гейт лёгкого UI: пять вкладок, без раздувания навигации.
import { TABS, createShell } from '../../src/ui/shell.js';

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

if (TABS.length !== 5) fail(`expected 5 tabs, got ${TABS.length}`);
const ids = TABS.map((t) => t.id).join(',');
if (ids !== 'feed,contacts,create,storage,profile') fail(`unexpected tabs: ${ids}`);
for (const t of TABS) {
  if (!t.labelKey.startsWith('nav_')) fail(`tab ${t.id} must use a locale key`);
}

const shell = createShell();
if (shell.active() !== 'feed') fail('default tab must be feed');
if (!shell.select('profile') || shell.active() !== 'profile') fail('select failed');
if (shell.select('billing')) fail('unknown tab must be rejected');
if (shell.active() !== 'profile') fail('failed select changed state');

console.log('OK: Sfera UI shell — 5 вкладок, навигация без бизнес-логики');
