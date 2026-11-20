#!/usr/bin/env node
// Контракт wire-формы прав для UI (ADR-006 §4.2, ADR-005: решения — в Rust).
//
// JS НЕ повторяет матрицу доступа: он проверяет, что форма, которую отдаёт
// Rust, совпадает с тем, что фронт ожидает отрисовать, и что продуктовые
// инварианты (Ограниченный без медиа, Друг без истории по умолчанию) на месте.
// Если Rust переименует поле — UI узнает об этом здесь, а не в проде.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  '..',
  'crates',
  'social-rights',
  'tests',
  'fixtures',
  'rights-contract.json',
);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const PERMISSION_KEYS = [
  'can_view_media',
  'can_react',
  'can_view_history',
  'can_request_chat',
  'profile',
];
const PROFILES = new Set(['none', 'brief', 'full']);
const ROLES = new Set(['close', 'friend', 'acquaintance', 'restricted']);
const AUDIENCE_KINDS = new Set(['all_contacts', 'sphere', 'selected', 'all_except']);
const DENY_REASONS = new Set([
  'pending_request',
  'declined',
  'blocked',
  'not_in_audience',
  'not_a_contact',
]);
const FP_RE = /^([0-9a-f]{2}:){8}\*{4}$/;

function checkPermissions(where, p) {
  if (typeof p !== 'object' || p === null) fail(`${where}: permissions not an object`);
  for (const k of PERMISSION_KEYS) {
    if (!(k in p)) fail(`${where}: missing ${k}`);
  }
  for (const k of ['can_view_media', 'can_react', 'can_view_history', 'can_request_chat']) {
    if (typeof p[k] !== 'boolean') fail(`${where}: ${k} must be boolean`);
  }
  if (!PROFILES.has(p.profile)) fail(`${where}: bad profile ${p.profile}`);
}

const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));

// 1. Роли: ровно четыре, ровно те поля.
const roleNames = Object.keys(fx.roles).sort();
if (roleNames.join(',') !== [...ROLES].sort().join(',')) {
  fail(`role set changed: ${roleNames.join(',')}`);
}
for (const [name, perms] of Object.entries(fx.roles)) {
  checkPermissions(`role ${name}`, perms);
}

// 2. Продуктовые инварианты из таблицы ADR-006 §4.2.
if (fx.roles.restricted.can_view_media !== false) {
  fail('restricted must NOT get media keys');
}
if (fx.roles.close.can_view_media !== true) fail('close must see media');
if (fx.roles.friend.can_view_history !== false) {
  fail('friend history default must be off (по настройке)');
}

// 3. Аудитории: форма тегов.
for (const a of fx.audiences) {
  if (!AUDIENCE_KINDS.has(a.kind)) fail(`bad audience kind ${a.kind}`);
  if (a.kind === 'sphere' && typeof a.id !== 'string') fail('sphere audience needs id');
  if (a.kind === 'selected' || a.kind === 'all_except') {
    if (!Array.isArray(a.fps) || a.fps.length === 0) {
      fail(`${a.kind} audience needs non-empty fps`);
    }
    for (const fp of a.fps) {
      if (!FP_RE.test(fp)) fail(`bad fingerprint in audience: ${fp}`);
    }
  }
}

// 4. Решения: delivered/deny/permissions согласованы.
if (!Array.isArray(fx.cases) || fx.cases.length === 0) fail('no access cases');
for (let i = 0; i < fx.cases.length; i++) {
  const c = fx.cases[i];
  const where = `case #${i}`;
  if (!ROLES.has(c.role)) fail(`${where}: bad role ${c.role}`);
  if (!AUDIENCE_KINDS.has(c.audience.kind)) fail(`${where}: bad audience`);
  const access = c.access;
  if (typeof access.delivered !== 'boolean') fail(`${where}: delivered must be boolean`);
  checkPermissions(where, access.permissions);

  if (access.delivered) {
    if (access.deny !== null) fail(`${where}: delivered but deny=${access.deny}`);
  } else {
    if (access.deny === null) fail(`${where}: denied without a reason`);
    if (!DENY_REASONS.has(access.deny)) fail(`${where}: unknown deny ${access.deny}`);
    // Отказ не оставляет прав: иначе UI показал бы доступ, которого нет.
    const p = access.permissions;
    for (const k of ['can_view_media', 'can_react', 'can_view_history', 'can_request_chat']) {
      if (p[k] !== false) fail(`${where}: denied case leaks ${k}=true`);
    }
    if (p.profile !== 'none') fail(`${where}: denied case leaks profile=${p.profile}`);
  }
}

// 5. Явная продуктовая проверка: контакт-Ограниченный получает текст, но не медиа.
const restrictedCase = fx.cases.find(
  (c) => c.relation === 'contact' && c.role === 'restricted' && c.audience.kind === 'all_contacts',
);
if (!restrictedCase) fail('missing restricted-contact case');
if (restrictedCase.access.delivered !== true) fail('restricted contact must get the post text');
if (restrictedCase.access.permissions.can_view_media !== false) {
  fail('restricted contact must not get media');
}

console.log(
  `OK: rights wire contract — ${roleNames.length} roles, ${fx.audiences.length} audiences, ${fx.cases.length} cases`,
);
