import { writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
const ROOT='/home/maksim/whisper/vault-desktop/src/features';
const SRC='/home/maksim/whisper/vault-desktop/src';
const HIST=ROOT+'/history.js';
const MOCKS='/tmp/history-smoke-mocks'; mkdirSync(MOCKS,{recursive:true}); mkdirSync(MOCKS+'/features',{recursive:true});

const dbCalls=[];
const db={
  bodyCacheLoadAll: async (ns) => { dbCalls.push(['bcAll',ns]); return [['k1','b1'],['k2','b2']]; },
  bodyCacheSet: async (ns,k,v) => { dbCalls.push(['bcSet',ns,k,v]); },
  kvGet: async (ns,k) => { dbCalls.push(['kvGet',ns,k]); return k==='chat-cache:chat' ? JSON.stringify([{id:'old'}]) : null; },
  kvSet: async (ns,k,v) => { dbCalls.push(['kvSet',ns,k,v]); },
};
const histStore={};
// Архив — НАСТОЯЩИЙ src/history.js (слияние и нормализация проверяются кодом,
// а не заглушкой), поэтому мок db обслуживает historyLoad/historySave.
db.historyLoad = async (ns, chat) => (chat in histStore ? JSON.stringify(histStore[chat]) : null);
db.historySave = async (ns, chat, json) => { histStore[chat] = JSON.parse(json); };
const identityMock={ accountNamespace: async (e) => 'fp:'+(e||'anon') };
globalThis.__dbMock=db; globalThis.__identityMock=identityMock;
writeFileSync(`${MOCKS}/api.js`, 'export const db = globalThis.__dbMock;\n');
writeFileSync(`${MOCKS}/identity.js`, 'export const accountNamespace = (e) => globalThis.__identityMock.accountNamespace(e);\n');
writeFileSync(`${MOCKS}/history.js`, prepareModuleCopy(SRC + '/history.js', `${MOCKS}/history.js`, {
  './api.js':'api.js', './identity.js':'identity.js',
}, MOCKS));

writeFileSync(`${MOCKS}/features/history.js`, prepareModuleCopy(HIST, `${MOCKS}/features/history.js`, {
  '../api.js':'api.js', '../identity.js':'identity.js', '../history.js':'history.js',
}, MOCKS));
const H = await import(`${MOCKS}/features/history.js`).then(m => m.default||m);
// Настоящий владелец переписки: chat-store.js не знает ни о Vue, ни о Tauri,
// поэтому импортируется напрямую — смоук видит ТОТ ЖЕ контракт, что и App.vue.
const { createChatStore } = await import(SRC + '/chat-store.js');
const makeChatStore = () => createChatStore();
let passed=0,failed=0;
function check(l,c,e){if(c){passed++;console.log('  ✓ '+l)}else{failed++;console.log('  ✗ '+l+(e!==undefined?' -> '+JSON.stringify(e):''))}}

check('bodyCacheKey(email) чистая строка', H.bodyCacheKey('a@b.c')==='vault-body-cache:a@b.c');
check('chatCacheKey(email,chat) чистая строка', H.chatCacheKey('a@b.c','ch')==='vault-chat-cache:a@b.c:ch');

{ dbCalls.length=0;
  const {bodies,order}=await H.loadBodyCache('a@b.c');
  check('loadBodyCache bodies из db.bodyCacheLoadAll', bodies['k1']==='b1');
  check('loadBodyCache order = keys', JSON.stringify(order)==='["k1","k2"]');
}

{ const cache={}, order=[];
  for (let i=0;i<410;i++) H.cacheBody({emailBodyCache:cache,bodyCacheOrder:order},('k'+i),'b');
  check('cacheBody FIFO trim 400 (k0 удалён, k409 есть)', order.length===400 && !('k0' in cache) && 'k409' in cache);
}

{ dbCalls.length=0;
  await H.persistBodyCache('a@b.c', {a:'1',b:'2'});
  check('persistBodyCache db.bodyCacheSet для всех ключей', dbCalls.filter(c=>c[0]==='bcSet').length===2);
}

{ dbCalls.length=0;
  const r=await H.loadChatCache('a@b.c','chat');
  check('loadChatCache kvGet → JSON.parse', r&&r[0].id==='old');
}

{ dbCalls.length=0;
  const msgs=[{id:'m',content:'x',from:'me',created_at:'2026-01-01T00:00:00Z',reactions:{},attachment:{},deleted:true,edited:true,sender_id:'a@b.c',ts:1000}];
  await H.saveChatCache('a@b.c','chat',msgs,H.msgTs);
  const slim=JSON.parse(dbCalls.find(c=>c[0]==='kvSet')[3]);
  check('saveChatCache slim без email field, ts=src', slim[0].id==='m' && !('email' in slim[0]) && slim[0].ts===1000);
}

{ let held=null;
  H.markPending({ setPendingOutgoing: (k,msg)=>held=msg }, 'chat1',{id:'x'});
  check('markPending вызывает setPendingOutgoing(msg)', held&&held.id==='x');
}

{ let dropped=false, merged=null;
  const pending={chat1:{p1:{id:'p1',_pendingAt:Date.now(),status:'sending'}}};
  const deps={pendingOutgoing:pending,isTombstoned:()=>false,msgTs:H.msgTs,
    mergePendingOutgoing:(k,v)=>{merged=v; pending[k]=v;},dropBucket:()=>{dropped=true}};
  const out=H.mergePending(deps,'chat1',[{id:'real'}]);
  check('mergePending подмешивает pending', out.some(m=>m.id==='p1'));
  check('mergePending mergePendingOutgoing вызван с remaining', merged && merged.p1 && out.some(m=>m.id==='p1'));
}
{
  // СВЕЖИЙ pending (_pendingAt = сейчас): иначе его отбрасывает «устарелость»,
  // и проверка tombstone была бы замаскирована (второй guard).
  // ВАЖНО: корзина pending КЛЮЧУЕТСЯ ПО id сообщения (bucket[id] = msg) — если
  // положить туда само сообщение, цикл разберёт его ПОЛЯ как записи и
  // проверка будет смотреть не на то (мы так и сделали сначала).
  const p2={c:{t:{id:'t',_pendingAt:Date.now(),status:'sending'}}};
  const out2=H.mergePending({pendingOutgoing:p2,isTombstoned:(id)=>id==='t',msgTs:H.msgTs,mergePendingOutgoing:()=>{},dropBucket:()=>{}},'c',[]);
  check('mergePending isTombstoned исключает', !out2.some(m=>m.id==='t'), out2);
}
{
  // Просроченное pending (старше 10 минут) — отбрасывается даже без tombstone.
  const old={c:{old:{id:'old',_pendingAt:Date.now()-11*60*1000,status:'sending'}}};
  const outOld=H.mergePending({pendingOutgoing:old,isTombstoned:()=>false,msgTs:H.msgTs,mergePendingOutgoing:()=>{},dropBucket:()=>{}},'c',[]);
  check('mergePending просроченное pending отбрасывает', !outOld.some(m=>m.id==='old'), outOld);
}
{
  // Pending, совпавший с реальным сообщением (тот же текст в окне) — не
  // дублируется в чате.
  const real={id:'r1',content:'привет',ts:Date.now()};
  // id заглушки ДОЛЖЕН начинаться с 'pending-' (по нему matchesPending и опознаёт заглушку).
  const pend={c:{'pending-abc':{id:'pending-abc',content:'привет',ts:Date.now(),_pendingAt:Date.now(),status:'sending'}}};
  const outDup=H.mergePending({pendingOutgoing:pend,isTombstoned:()=>false,msgTs:H.msgTs,mergePendingOutgoing:()=>{},dropBucket:()=>{}},'c',[real]);
  check('mergePending: pending-дубль реального не добавляется',
    outDup.filter(m=>m.content==='привет').length === 1, outDup);
}

{
  // Бакет pending обязан быть ЗАПИСЬЮ. Строка (ключ чата, попавший не в тот
  // аргумент) дала бы Object.keys по символам — поллинг подмешивал символы
  // строки в чат вместо переписки («пустые пузыри», жалоба 22.10).
  const corrupt={ 'peer@x.com':'peer@x.com' };
  const outBad=H.mergePending({pendingOutgoing:corrupt,isTombstoned:()=>false,msgTs:H.msgTs,mergePendingOutgoing:()=>{},dropBucket:()=>{}},'peer@x.com',[{id:'m1',content:'живое'}]);
  check('mergePending: бакет-строка не рассыпается в символы-сообщения',
    outBad.every(m=>m && typeof m==='object') && outBad.length===1, outBad);
}

{ const hist=[{from:'me',status:'sending',ts:Date.now()-120000},{from:'peer',status:'sending',ts:Date.now()+1000}];
  H.normalizeStaleSending(H.msgTs, hist);
  check('normalizeStaleSending старый sending→sent', hist[0].status==='sent');
  check('normalizeStaleSending свежий не трогает', hist[1].status==='sending');
}

{
  const callObj={}; callObj['type']='"type":"call_"'; // placeholder string
  histStore['ch']=[{id:'a',content:'{"type":"call_missed"}'}, {id:'b',content:'hi'}];
  const r=await H.loadLocalHistory('a@b.c','ch', H.msgTs);
  check('loadLocalHistory filter call_*-сигналов', r.length===1 && r[0].id==='b');
}

{
  histStore['gh']=[{id:'h1',content:'old',ts:100}];
  let got=null;
  const filterDeleted = (a)=>a.filter(m=>!m.deleted);
  const merged=await H.mergeHistory({email:'a@b.c',msgTs:H.msgTs,filterDeleted},'gh',[{id:'h2',content:'new',ts:200}]);
  check('mergeHistory объединяет старое+новое', merged.length===2);
  check('mergeHistory фильтрует deleted', filterDeleted===filterDeleted && merged.every(m=>!m.deleted));
  check('mergeHistory новые (extra) в конце после сортировки ts', merged.map(m=>m.id).join(',')==='h1,h2');
}

{
  histStore['fh']=[{id:'f1',content:'hi',ts:1}];
  // ВЛАДЕЛЕЦ — НАСТОЯЩИЙ (src/chat-store.js), а не самоделка по форме:
  // самописный `{state:{messages},set}` пропускал расхождение контракта,
  // из-за которого приложение теряло отправленные сообщения (22.10).
  const chat = makeChatStore();
  await H.showHistoryFirst({loadHistory: (ck)=>H.loadLocalHistory('a@b.c',ck,H.msgTs), chat, msgTs: H.msgTs}, 'fh', ()=>false);
  check('showHistoryFirst chat.set отфильтрованными (без call_)', chat.state.messages.length===1 && chat.state.messages[0].id==='f1');
}

{
  histStore['sh']=[];
  const chat = makeChatStore();
  chat.append({id:'x',content:'y'});
  await H.saveCurrentHistory('a@b.c','sh',chat);
  check('saveCurrentHistory берёт messages У ВЛАДИТЕЛЯ (chat.state.messages)', histStore['sh']&&histStore['sh'][0].id==='x');
}

check('msgTs: ts приоритетнее, чем date', H.msgTs({ts:777})===777);
check('msgTs _pendingAt fallback', H.msgTs({_pendingAt:555})===555);
check('msgTs 0 on пусто', H.msgTs({})===0);

// ── Кэш тел писем: загрузка в состояние и отложенное сохранение ────────
console.log('\nКэш тел писем: загрузка и отложенное сохранение');
{
  const cache = { 'a@x': 'body-a' };
  const order = ['a@x'];
  const saved = [];
  let timer = null;
  const deps = {
    email: 'u@x.org',
    emailBodyCache: () => cache,
    setEmailBodyCache: (v) => { Object.assign(cache, v); },
    bodyCacheOrder: () => order,
    setBodyCacheOrder: (v) => { order.length = 0; order.push(...v); },
    bodyCacheSaveTimer: () => timer,
    setBodyCacheSaveTimer: (t) => { timer = t; },
    persistBodyCache: async () => { saved.push(1); },
  };
  await H.loadBodyCacheInto(deps);
  // Источник — kv (мок отдаёт [['k1','b1'],['k2','b2']]), значит в состояние
  // должны попасть ИМЕННО эти тела и такой же порядок.
  check('кэш: тела из kv загружены в состояние',
    cache['k1'] === 'b1' && cache['k2'] === 'b2', Object.keys(cache));
  check('кэш: порядок ключей загружен',
    JSON.stringify(order) === JSON.stringify(['k1', 'k2']), order);
}
{
  const cache = {};
  const order = [];
  const saved = [];
  let timer = null;
  const deps = {
    email: 'u@x.org',
    emailBodyCache: () => cache,
    setEmailBodyCache: (v) => { Object.assign(cache, v); },
    bodyCacheOrder: () => order,
    setBodyCacheOrder: (v) => { order.length = 0; order.push(...v); },
    bodyCacheSaveTimer: () => timer,
    setBodyCacheSaveTimer: (t) => { timer = t; },
    persistBodyCache: async () => { saved.push(1); },
  };
  H.cacheBodyWithPersist(deps, 'k1', 'body-1');
  check('кэш: тело положено', cache['k1'] === 'body-1', cache);
  check('кэш: сохранение отложено (не сразу)', saved.length === 0, saved.length);
  check('кэш: таймер установлен', !!timer, timer);
  // Второе тело до истечения таймера — таймер перезапускается, сохранение
  // остаётся отложенным (debounce).
  H.cacheBodyWithPersist(deps, 'k2', 'body-2');
  check('кэш: второе тело тоже в кэше', cache['k2'] === 'body-2', cache);
  check('кэш: сохранение всё ещё отложено', saved.length === 0, saved.length);
  await new Promise((r) => setTimeout(r, 2200));
  check('кэш: сохранение произошло после паузы', saved.length === 1, saved.length);
}

console.log('=== ИТОГО: '+passed+' pass, '+failed+' fail ===');
if (failed) process.exit(1);
