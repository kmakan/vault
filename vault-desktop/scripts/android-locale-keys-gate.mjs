#!/usr/bin/env node
// Гейт нативных строк Android. Магазины требуют, чтобы приложение говорило на
// заявленных языках, а экран замка и каналы уведомлений были литералами в
// Kotlin — на английской системе пользователь видел русские надписи, и ничто
// в дереве этого не меряло.
//
// Проверяет три вещи:
//   1. в Kotlin нет кирилличных строковых литералов (то, что видит человек,
//      обязано приходить из ресурсов; комментарии не в счёт);
//   2. у каждого ключа значений по умолчанию есть пара в values-en;
//   3. каждая ссылка R.string.* из Kotlin существует в значениях по умолчанию.
//
// Использование: node scripts/android-locale-keys-gate.mjs

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ANDROID = path.resolve('src-tauri/gen/android/app/src/main');
const VALUES = path.join(ANDROID, 'res/values/strings.xml');
const VALUES_EN = path.join(ANDROID, 'res/values-en/strings.xml');
const JAVA = path.join(ANDROID, 'java');

const CYR = /[Ѐ-ӿ]/;

function ktFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) ktFiles(full, out);
    else if (e.name.endsWith('.kt')) out.push(full);
  }
  return out;
}

// Комментарий отбрасывается по «//», не по «///»-префиксу: код может стоять
// после строки с URL («http://»), поэтому режем только второй слэш без
// третьего. Для этих файлов это не критично: литералов с «//» в них нет.
function stripComment(line) {
  const i = line.indexOf('//');
  return i < 0 ? line : line.slice(0, i);
}

function keysOf(file) {
  const txt = readFileSync(file, 'utf8');
  return [...txt.matchAll(/<string name="([^"]+)"/g)].map((m) => m[1]);
}

const problems = [];
const files = ktFiles(JAVA);
if (!files.length) problems.push(`нет Kotlin-файлов в ${path.relative('.', JAVA)}`);
if (!existsSync(VALUES)) problems.push(`нет ${path.relative('.', VALUES)}`);
if (!existsSync(VALUES_EN)) problems.push(`нет ${path.relative('.', VALUES_EN)}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}

const defaultKeys = keysOf(VALUES);
const enKeys = keysOf(VALUES_EN);
const keySet = new Set(defaultKeys);

let literals = 0;
for (const file of files) {
  const rel = path.relative('.', file);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = stripComment(line);
    for (const m of code.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
      if (CYR.test(m[1])) {
        literals++;
        console.error(`✗ ${rel}:${i + 1}: русская строка в коде — не переведётся`);
        console.error(`    ${m[0].slice(0, 80)}`);
      }
    }
  });
}

const refs = new Map();
const countRef = (key) => refs.set(key, (refs.get(key) || 0) + 1);
for (const file of files) {
  const rel = path.relative('.', file);
  const txt = readFileSync(file, 'utf8');
  for (const m of txt.matchAll(/R\.string\.([a-z0-9_]+)/g)) {
    if (!keySet.has(m[1])) {
      console.error(`✗ ${rel}: R.string.${m[1]} — ключа нет в values/strings.xml`);
      problems.push(`ссылка на несуществующий ключ ${m[1]}`);
    }
    countRef(m[1]);
  }
}
// Манифест ссылается на подписи не кодом, а строкой ресурса — их тоже надо
// считать использованными, иначе гейт советует удалить заголовок активности.
const manifest = path.join(ANDROID, 'AndroidManifest.xml');
if (existsSync(manifest)) {
  for (const m of readFileSync(manifest, 'utf8').matchAll(/@string\/([a-z0-9_]+)/g)) {
    if (!keySet.has(m[1])) {
      console.error(`✗ AndroidManifest.xml: @string/${m[1]} — ключа нет в values/strings.xml`);
      problems.push(`ссылка манифеста на несуществующий ключ ${m[1]}`);
    }
    countRef(m[1]);
  }
}

const missingEn = defaultKeys.filter((k) => !enKeys.includes(k));
const extraEn = enKeys.filter((k) => !keySet.has(k));
for (const k of missingEn) console.error(`✗ values-en: нет перевода для ${k}`);
for (const k of extraEn) console.error(`✗ values-en: ключ ${k} не нужен (нет в значениях по умолчанию)`);
if (missingEn.length) problems.push(`без перевода: ${missingEn.length}`);
if (extraEn.length) problems.push(`лишних ключей в values-en: ${extraEn.length}`);
if (literals) problems.push(`русских литералов в Kotlin: ${literals}`);

if (problems.length) {
  console.error(`\n  android-locale-keys: провал (${problems.join(', ')}).`);
  console.error('  Что делать: строку, которую видит человек, перенести в');
  console.error('  res/values/strings.xml и добавить её в res/values-en/strings.xml.');
  process.exit(1);
}

const unused = defaultKeys.filter((k) => !refs.has(k));
console.log(
  `✓ android-locale-keys: ключей ${defaultKeys.length}, все продублированы в values-en, ` +
    `русских литералов в Kotlin нет (файлов: ${files.length})` +
    (unused.length ? `; ключей без ссылок из Kotlin: ${unused.join(', ')}` : '') + '.'
);
