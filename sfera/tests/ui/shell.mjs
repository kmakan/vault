#!/usr/bin/env node
// Гейт лёгкого UI: пять вкладок, без раздувания навигации.
import { TABS, COMPANION, companionLabelKey, createShell } from '../../src/ui/shell.js';

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

if (TABS.length !== 6) fail(`expected 6 tabs, got ${TABS.length}`);
const ids = TABS.map((t) => t.id).join(',');
if (ids !== 'feed,contacts,channels,create,storage,profile') fail(`unexpected tabs: ${ids}`);
for (const t of TABS) {
  if (!t.labelKey.startsWith('nav_')) fail(`tab ${t.id} must use a locale key`);
}

const shell = createShell();
if (shell.active() !== 'feed') fail('default tab must be feed');
if (!shell.select('profile') || shell.active() !== 'profile') fail('select failed');
if (shell.select('billing')) fail('unknown tab must be rejected');
if (shell.active() !== 'profile') fail('failed select changed state');

if (companionLabelKey(true) !== COMPANION.openLabelKey) fail('installed companion label');
if (companionLabelKey(false) !== COMPANION.installLabelKey) fail('missing companion label');

console.log('OK: Sfera UI shell — 6 вкладок, контекстная кнопка мессенджера');
