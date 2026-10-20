// Гейт гигиены текста: в код, комментарии и документацию не должны попадать
// ИЕРОГЛИФЫ и БИТЫЕ БАЙТЫ.
//
// ЗАЧЕМ ГЕЙТ, А НЕ РАЗОВЫЙ ПРОГОН. Иероглифы в русском тексте появляются
// дважды: при генерации (модель «продолжает» фразу и подставляет китайские
// иероглифы) и при правке файла (несовпадение кодировок). За сессию 20.10 это
// случилось ПЯТЬ раз: иероглифы в сообщении коммита, китайский в модуле,
// битые байты в журнале, битые байты в смоуке, смесь в черновике. Разовый
// прогон по репозиторию делался и не помогал — помогает гейт в CI.
//
// ЧТО ИЩЕМ.
//   1) CJK-иероглифы (U+4E00–U+9FFF и соседние блоки), хирагана/катакана
//      (U+3040–U+30FF), хангыль (U+AC00–U+D7AF);
//   2) U+FFFD (заменяющий символ) — это битые байты: файл прочитан с неверной
//      кодировкой и часть текста потеряна НЕОБРАТИМО.
//
// ЧТО ЛЕГИТИМНО.
//   * src/locales/zh.js — китайская локализация приложения (её задача);
//   * строка `language_zh:` в ЛЮБОМ файле локалей — это НАЗВАНИЕ языка в
//     выпадающем списке (китайский пишется по-китайски — так правильно);
//   * каталог vault-android — заброшенная копия 0.1.148 (в APK не идёт),
//     но и там локализация своя.
//
// ЗАПУСК: node scripts/hygiene-gate.mjs [--notes]
//   --notes — дополнительно проверить рабочий журнал (~/Notes/Projects/
//   mailcipher). Каталога может не быть (CI, другой машина) — тогда шаг
//   пропускается молча.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(import.meta.dirname, '..', '..');   // корень репозитория

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', '.opencode', 'graphify-out',
  'build', '.vite', 'coverage', 'gen',
]);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip',
  '.gz', '.tar', '.apk', '.a', '.so', '.dll', '.exe', '.woff', '.woff2',
  '.ttf', '.eot', '.mp3', '.mp4', '.keystore', '.jks',
]);

// Диапазоны заданы ШЕСТНАДЦАТЕРИЧНЫМИ escape'ами: сам гейт не должен содержать
// иероглифов — иначе он запрещал бы сам себя.
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const KANA = /[\u3040-\u30FF]/;
const HANGUL = /[\uAC00-\uD7AF\u1100-\u11FF]/;
const FFFD = /\uFFFD/;

function classify(line) {
  if (FFFD.test(line)) return 'битые байты (U+FFFD)';
  if (CJK.test(line)) return 'иероглифы (CJK)';
  if (KANA.test(line)) return 'кана (хирагана/катакана)';
  if (HANGUL.test(line)) return 'хангыль';
  return null;
}

// Легитимные места: файл целиком (локализация) ИЛИ строка (название языка).
function isAllowedFile(rel) {
  return /(^|\/)src\/locales\/zh\.js$/.test(rel) || /(^|\/)locales\/zh\.js$/.test(rel);
}
function isAllowedLine(rel, line) {
  if (!/(^|\/)locales\/(en|ru|zh)\.js$/.test(rel)) return false;
  return /language_zh\s*:/.test(line);
}

function scanTree(root, label, findings) {
  if (!existsSync(root)) return 0;
  let scanned = 0;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      let size = 0;
      try { size = statSync(full).size; } catch { continue; }
      if (size > 3_000_000) continue;
      let buf;
      try { buf = readFileSync(full); } catch { continue; }
      // БИНАРНЫЕ ФАЙЛЫ пропускаем: прочитанный как UTF-64 .wav даёт «иероглифы»,
      // которых нет (это мусор декодирования, а не текст).
      if (buf.includes(0)) continue;
      let txt;
      try { txt = buf.toString('utf8'); } catch { continue; }
      scanned++;
      const rel = path.relative(root, full);
      if (isAllowedFile(rel)) continue;
      const lines = txt.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const kind = classify(lines[i]);
        if (!kind) continue;
        if (isAllowedLine(rel, lines[i])) continue;
        findings.push({ file: path.join(label, rel), line: i + 1, kind, text: lines[i].trim().slice(0, 140) });
      }
    }
  };
  walk(root);
  return scanned;
}

const findings = [];
const notesRoot = path.join(os.homedir(), 'Notes', 'Projects', 'mailcipher');
const wantNotes = process.argv.includes('--notes');

const scannedRepo = scanTree(REPO, path.basename(REPO), findings);
const scannedNotes = wantNotes ? scanTree(notesRoot, '~/Notes/Projects/mailcipher', findings) : 0;

if (findings.length) {
  console.error('═══ ИЕРОГЛИФЫ/БИТЫЕ БАЙТЫ В ТЕКСТЕ ═══\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.kind}]`);
    console.error(`      ${f.text}`);
  }
  console.error(`\n  Найдено: ${findings.length} (проверено файлов: ${scannedRepo}` +
    (scannedNotes ? ` + ${scannedNotes} из журнала` : '') + ').');
  console.error('  Что делать: заменить иероглифы русскими словами, восстановить битые');
  console.error('  байты из исходника (U+FFFD означает ПОТЕРЮ текста — не «заменить»,');
  console.error('  а взять правильную строку).');
  process.exit(1);
}

console.log(`✓ hygiene-gate: иероглифов и битых байтов нет (проверено файлов: ${scannedRepo}` +
  (scannedNotes ? ` + ${scannedNotes} из журнала` : '') + ').');
