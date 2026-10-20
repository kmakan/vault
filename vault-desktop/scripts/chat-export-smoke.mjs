// Node-смоук src/chatExport.js — экспорт переписки (JSON и TXT).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СМОУК. Экспорт — это то, что человек забирает с собой и
// читает в другом приложении: формат здесь контракт, а не деталь. Правила:
//   * JSON: счётчик сообщений, отметка шифрования, реакции — по контракту;
//   * TXT: «You» для своих сообщений и имя контакта для чужих, метка
//     шифрования и реакции в строке заголовка, ВРЕМЯ сообщения (или «?»);
//   * файл скачивается под заданным именем.
import { exportChatJSON, exportChatTXT } from '../src/chatExport.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

const MESSAGES = [
  { id: 'm1', from: 'me', content: 'привет', time: '10:00', encrypted: true, reactions: ['👍'] },
  { id: 'm2', from: 'peer@x.ru', content: 'здорово', time: '10:01' },
];

// ── JSON ─────────────────────────────────────────────────────────────────
{
  const raw = exportChatJSON(MESSAGES, 'peer@x.ru');
  let data;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  ok('JSON разбирается', !!data, raw.slice(0, 120));
  ok('контакт записан', data && data.contact === 'peer@x.ru');
  ok('счётчик сообщений верный', data && data.messageCount === 2, data && data.messageCount);
  ok('сообщения внутри', data && data.messages.length === 2);
  ok('текст сообщения сохранён', data && data.messages[0].content === 'привет');
  ok('время сохранено', data && data.messages[0].time === '10:00');
  ok('отметка шифрования есть', data && data.messages[0].encrypted === true);
  ok('у сообщения без шифрования encrypted = false', data && data.messages[1].encrypted === false);
  ok('реакции сохранены', data && Array.isArray(data.messages[0].reactions) && data.messages[0].reactions[0] === '👍');
  ok('у сообщения без реакций reactions = []', data && Array.isArray(data.messages[1].reactions) && data.messages[1].reactions.length === 0);
  ok('формат приложения записан', data && typeof data.app === 'string' && data.app.length > 0);
  ok('версия формата записана', data && typeof data.version === 'string' && data.version.length > 0);
  ok('дата экспорта записана', data && !Number.isNaN(Date.parse(data.exportDate)), data && data.exportDate);
}

// ── TXT ──────────────────────────────────────────────────────────────────
{
  const txt = exportChatTXT(MESSAGES, 'peer@x.ru');
  ok('заголовок содержит контакт', txt.includes('peer@x.ru'), txt.slice(0, 120));
  ok('заголовок содержит число сообщений', /Messages:\s*2/.test(txt));
  ok('своё сообщение помечено как You', /\[10:00\] You/.test(txt), txt);
  // Строка ЧУЖЕГО сообщения обязана называть контакт, а не «You»: иначе в
  // экспорте не видно, кто что писал (а «Contact: …» в шапке этого не даёт).
  const peerLine = (txt.split('\n').find((l) => l.startsWith('[10:01]')) || '');
  ok('строка чужого сообщения подписана контактом (не «You»)',
    /peer@x\.ru/.test(peerLine) && !peerLine.includes('You'), peerLine);
  ok('в файле вообще нет «You» у чужой реплики', !/\[10:01\] You/.test(txt), txt);
  ok('время сообщения в строке', txt.includes('10:00') && txt.includes('10:01'));
  ok('метка шифрования есть', txt.includes('🔒'), txt);
  ok('реакции в строке', txt.includes('👍'));
  ok('текст сообщения в файле', txt.includes('привет') && txt.includes('здорово'));
}
{
  // Сообщение без времени — плейсхолдер, а не «undefined».
  const txt = exportChatTXT([{ id: 'x', from: 'peer@x.ru', content: 'без времени' }], 'peer@x.ru');
  ok('сообщение без времени → «?» (не undefined)', txt.includes('[?]'), txt);
  ok('в файле нет строки «undefined»', !txt.includes('undefined'), txt);
}

console.log('\n=== ИТОГ: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
