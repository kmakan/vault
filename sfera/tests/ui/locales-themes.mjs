#!/usr/bin/env node
// Гейт UI-слоя Sfera (ADR-006 §9.3, §10):
// - языки ru/en/zh + расширяемость;
// - все локали имеют одинаковые ключи (пропуск = молчаливый fallback в проде);
// - темы используют палитру мессенджера (фиолетовый + янтарный);
// - в UI-файлах нет протокольной логики (ключи/подписи/права/форматы).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BUILTIN, FALLBACK, availableLocales, hasLocale, translate, missingKeys,
} from '../../src/locales/index.js';
import { THEMES, DEFAULT_THEME, themeNames, themeVars } from '../../src/themes/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', '..', 'src');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. Три языка по требованию владельца.
for (const code of ['ru', 'en', 'zh']) {
  if (!hasLocale(code)) fail(`missing required locale ${code}`);
}
if (FALLBACK !== 'en') fail('fallback must be en');
const names = availableLocales().map((l) => l.code);
if (names.join(',') !== 'ru,en,zh') fail(`unexpected locale order: ${names}`);

// 2. Все ключи совпадают с эталоном — иначе UI молча покажет английский.
for (const code of Object.keys(BUILTIN)) {
  const missing = missingKeys(code);
  if (missing.length) fail(`locale ${code} missing keys: ${missing.join(', ')}`);
}

// 3. Подстановка параметров.
const ru = translate('ru', 'feed_new_posts', { n: 3 });
if (!ru.includes('3')) fail('parameter substitution failed');
const zh = translate('zh', 'create_sent', { n: 2, m: 5 });
if (!zh.includes('2') || !zh.includes('5')) fail('zh parameter substitution failed');

// 4. Палитра мессенджера: фиолетовый акцент в базовых темах,
//    янтарный — вторичный во всех темах.
const dark = themeVars('dark');
if (dark['--accent-primary'] !== '#6366f1') fail('violet accent drifted from messenger');
if (dark['--accent-secondary'] !== '#818cf8') fail('violet secondary drifted');
for (const code of themeNames()) {
  const vars = themeVars(code);
  if (vars['--accent-warm'] !== '#f59e0b') fail(`${code}: amber accent missing`);
  if (!vars['--font-sans'] || !vars['--radius-lg']) fail(`${code}: base tokens missing`);
}
if (!THEMES[DEFAULT_THEME]) fail('default theme missing');

// 5. Расширяемость: новый язык = файл + строка реестра. Проверяем, что
//    реестр не захардкожен в трёх places (имя locale только в language_name).
const localeFiles = readdirSync(join(srcDir, 'locales')).filter((f) => f.endsWith('.js'));
if (localeFiles.length !== 4) fail(`expected 3 locale files + index, got ${localeFiles.length}`);

// 6. Логика в Rust: в UI-файлах не должно быть подписи/ключей/прав/форматов.
const forbidden = /sign_post|verify_post|fingerprint_from|canonical_post|ed25519|ml_kem|Audience::|RoleOverrides|JCS/i;
for (const dir of ['locales', 'themes']) {
  for (const f of readdirSync(join(srcDir, dir)).filter((x) => x.endsWith('.js'))) {
    const text = readFileSync(join(srcDir, dir, f), 'utf8');
    if (forbidden.test(text)) fail(`${dir}/${f}: protocol logic in UI layer`);
  }
}

console.log('OK: Sfera UI — ru/en/zh, ключи совпадают, палитра violet+amber, логика в Rust');
