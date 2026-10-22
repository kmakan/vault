// smoke: mailbox-api-deps-smoke.mjs
// Проверяет ПОРТ features/mailbox-api.js (ADR-004 J.4 + ADR-005 R3):
//   - без владельца бросает громко (никакой тихой деградации);
//   - с владельцем переадресует аргументы 1:1;
//   - владелец — явный узкий набор операций (не весь ctx/App);
//   - статический гейт: в App.vue фичам не передаётся `ctx`/`this` первым аргументом
//     (контракт deps не дублируется второй копией).
import fs from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

const src = fs.readFileSync('/home/maksim/whisper/vault-desktop/src/features/mailbox-api.js','utf8');
const app = fs.readFileSync('/home/maksim/whisper/vault-desktop/src/App.vue','utf8');

// --- 1. без владельца: громкая ошибка ---
{
  // динамический импорт из файла (как делает харнес)
  const mod = await import('/home/maksim/whisper/vault-desktop/src/features/mailbox-api.js');
  const api = mod.mailboxApi;
  let threw = false;
  try { await api.processIncoming({a:1}, {notify:true}); }
  catch (e) { threw = /владелец не зарегистрирован/.test(String(e && e.message)); }
  check('без владельца: processIncoming бросает громко', threw);
}

// --- 2. с владельцем: переадресация 1:1 ---
{
  const mod = await import('/home/maksim/whisper/vault-desktop/src/features/mailbox-api.js');
  const api = mod.mailboxApi;
  const calls = [];
  api.setOwner({
    processIncoming: (f,o) => { calls.push(['processIncoming',f,o]); return 'PI'; },
    loadMessages: (e) => { calls.push(['loadMessages',e]); return 'LM'; },
    loadEmails: (s) => { calls.push(['loadEmails',s]); return 'LE'; },
    loadGroups: () => { calls.push(['loadGroups']); return 'LG'; },
    loadGroupMessages: (id,force) => { calls.push(['loadGroupMessages',id,force]); return 'LGM'; },
    loadCursors: (id) => { calls.push(['loadCursors',id]); return 'LC'; },
    saveCursors: (id,c) => { calls.push(['saveCursors',id,c]); return 'SC'; },
    cacheBody: (k,b) => { calls.push(['cacheBody',k,b]); return 'CB'; },
    scrollToBottom: (f) => { calls.push(['scrollToBottom',f]); return 'SB'; },
  });
  check('processIncoming возвращает результат владельца', await api.processIncoming({x:1},{notify:true}) === 'PI');
  check('processIncoming переадресует аргументы', JSON.stringify(calls.at(-1)) === JSON.stringify(['processIncoming',{x:1},{notify:true}]));
  await api.loadMessages('alice@x');
  check('loadMessages переадресует email', JSON.stringify(calls.at(-1)) === JSON.stringify(['loadMessages','alice@x']));
  await api.loadEmails(false);
  check('loadEmails переадресует silent', JSON.stringify(calls.at(-1)) === JSON.stringify(['loadEmails',false]));
  await api.loadGroups();
  check('loadGroups без аргументов', JSON.stringify(calls.at(-1)) === JSON.stringify(['loadGroups']));
  await api.loadGroupMessages('g1', true);
  check('loadGroupMessages переадресует (id,force)', JSON.stringify(calls.at(-1)) === JSON.stringify(['loadGroupMessages','g1',true]));
  await api.loadCursors('acc1');
  check('loadCursors переадресует accountId', JSON.stringify(calls.at(-1)) === JSON.stringify(['loadCursors','acc1']));
  await api.saveCursors('acc1', {c:2});
  check('saveCursors переадресует (id,cursors)', JSON.stringify(calls.at(-1)) === JSON.stringify(['saveCursors','acc1',{c:2}]));
  api.cacheBody('k','body');
  check('cacheBody переадресует (key,body)', JSON.stringify(calls.at(-1)) === JSON.stringify(['cacheBody','k','body']));
  api.scrollToBottom(true);
  check('scrollToBottom переадресует force', JSON.stringify(calls.at(-1)) === JSON.stringify(['scrollToBottom',true]));
}

// --- 3. статический гейт: App.vue регистрирует владельца ---
check('App.vue вызывает mailboxApi.setOwner', /mailboxApi\.setOwner\(\{/.test(app));
const ownerBlock = app.slice(app.indexOf('mailboxApi.setOwner({'), app.indexOf('mailboxApi.setOwner({') + 600);
for (const op of ['processIncoming','loadMessages','loadEmails','loadGroups','loadGroupMessages','loadCursors','saveCursors','cacheBody','scrollToBottom']) {
  check('владелец объявляет ' + op, new RegExp('\\b' + op + ':').test(ownerBlock));
}

// --- 4. статический гейт: никакой feature-вызов с ctx/this первым аргументом ---
// Ищем вызовы вида XXXFeature.yyy(...)/Feature.yyy(...) где первый аргумент ctx/this
const bad = [];
const re = /([A-Za-z_]+Feature)\.([a-zA-Z_]+)\(\s*(ctx|this)\s*[,)]/g;
for (const raw of app.split('\n')) {
  const line = raw.replace(/\/\/.*/, '');
  let m;
  while ((m = re.exec(line)) !== null) bad.push(m[0]);
  re.lastIndex = 0;
}
check('App.vue: нет feature-вызовов с ctx/this первым аргументом', bad.length === 0);
if (bad.length) console.log('  bad:', bad.slice(0,10));

console.log('\nmailbox-api-deps-smoke: ' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
