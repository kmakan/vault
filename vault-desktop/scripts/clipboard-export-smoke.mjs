// Node-смоук features/clipboard-export.js — копирование и экспорт переписки.
//
// Что ловится: копирование и экспорт — три разных пути к одному файлу, и
// ошибка в них тиха: пользователь думает, что скопировал/выгрузил, а в буфере
// пусто (или файл не сохранён). Проверяем: что именно попадает в буфер
// (с цитатой или без), что при сбое буфера пользователь ВИДИТ ошибку (а не
// тишину), и что экспорт кладёт файл с правильным именем и типом.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOCKS = '/tmp/clipboard-export-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

prepareModuleCopy(
  ROOT + '/src/features/clipboard-export.js',
  MOCKS + '/clipboard-export.mjs',
  {},
  MOCKS,
);
const C = await import(MOCKS + '/clipboard-export.mjs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}

function makeDeps(over = {}) {
  const st = { copied: [], alerts: [], files: [], closed: 0, copyOk: true };
  const deps = {
    st,
    copyTextToClipboard: async (text) => { st.copied.push(text); return st.copyOk; },
    alert: (msg) => { st.alerts.push(msg); },
    tr: (key) => key,
    replyBody: (content) => '> ' + content,
    messages: () => [{ id: 'm1', content: 'привет' }],
    activeChat: () => 'peer@x.ru',
    exportChatJSON: (msgs, chat) => JSON.stringify({ chat, n: msgs.length }),
    exportChatTXT: (msgs, chat) => `chat=${chat};n=${msgs.length}`,
    downloadFile: (data, name, mime) => { st.files.push({ data, name, mime }); },
    closeExportMenu: () => { st.closed += 1; },
    ...over,
  };
  return deps;
}

// ── Копирование текста ─────────────────────────────────────────────────
{
  const deps = makeDeps();
  const ok = await C.copyText(deps, 'текст');
  check('копирование успешное → true', ok === true);
  check('текст попал в буфер', deps.st.copied[0] === 'текст', deps.st.copied);
  check('показан тост об успехе', String(deps.st.alerts[0]).includes('copied'), deps.st.alerts);
}
{
  const deps = makeDeps();
  deps.st.copyOk = false;
  const ok = await C.copyText(deps, 'текст');
  check('сбой буфера → false', ok === false);
  check('сбой буфера НЕ молчит (показан тост об ошибке)',
    deps.st.alerts.length === 1 && String(deps.st.alerts[0]).includes('copy_failed'), deps.st.alerts);
}

// ── Копирование сообщений ──────────────────────────────────────────────
{
  const deps = makeDeps();
  await C.copyMessageText(deps, null);
  check('без сообщения ничего не копируем', deps.st.copied.length === 0, deps.st.copied);
}
{
  const deps = makeDeps();
  await C.copyMessageText(deps, { content: 'привет' });
  check('с цитатой в буфер идёт replyBody', deps.st.copied[0] === '> привет', deps.st.copied);
}
{
  const deps = makeDeps();
  await C.copyMessageAll(deps, { content: 'привет' });
  check('целиком в буфер идёт сырой текст', deps.st.copied[0] === 'привет', deps.st.copied);
}
{
  const deps = makeDeps();
  await C.copyMessageAll(deps, null);
  check('без сообщения «целиком» ничего не копируем', deps.st.copied.length === 0, deps.st.copied);
}

// ── Экспорт ────────────────────────────────────────────────────────────
{
  const deps = makeDeps();
  C.exportAsJSON(deps);
  check('экспорт JSON: файл сохранён', deps.st.files.length === 1, deps.st.files);
  check('экспорт JSON: имя файла по чату и .json',
    /^vault-peer@x\.ru-\d+\.json$/.test(deps.st.files[0].name), deps.st.files[0].name);
  check('экспорт JSON: тип application/json',
    deps.st.files[0].mime === 'application/json', deps.st.files[0].mime);
  check('экспорт JSON: выгружен именно открытый чат (не другой)',
    String(deps.st.files[0].data).includes('peer@x.ru'), deps.st.files[0].data);
  check('экспорт JSON: меню экспорта закрыто', deps.st.closed === 1);
}
{
  const deps = makeDeps();
  C.exportAsTXT(deps);
  check('экспорт TXT: имя файла по чату и .txt',
    /^vault-peer@x\.ru-\d+\.txt$/.test(deps.st.files[0].name), deps.st.files[0].name);
  check('экспорт TXT: тип text/plain', deps.st.files[0].mime === 'text/plain', deps.st.files[0].mime);
  check('экспорт TXT: содержимое собрано сборщиком',
    deps.st.files[0].data === 'chat=peer@x.ru;n=1', deps.st.files[0].data);
  check('экспорт TXT: меню экспорта закрыто', deps.st.closed === 1, deps.st);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
