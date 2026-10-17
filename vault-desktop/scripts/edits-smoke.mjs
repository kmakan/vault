import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';

const ROOT = '/home/maksim/whisper/vault-desktop/src/features';
const EDITS = ROOT + '/edits.js';
const MOCKS = '/tmp/edits-smoke-mocks';
mkdirSync(MOCKS, { recursive: true });

const dbCalls = [], apiCalls = [];
const db = { tombstoneAdd: async (ns, mid, rid) => { dbCalls.push(['tombstoneAdd', ns, mid, rid]); return true; } };
const apiMock = {
  sendEdit: async (to, body) => { apiCalls.push(['sendEdit', to, body]); },
  sendGroupEdit: async (gid, body) => { apiCalls.push(['sendGroupEdit', gid, body]); },
};
const cryptoMock = {
  setPeerPublicKey: () => {},
  encryptWithGroupKey: async (p) => 'ENC_G:' + p,
  encryptVault: async (p) => 'ENC_1:' + p,
};
const identityMock = { accountNamespace: async (e) => 'fp:' + (e || 'anon') };

writeFileSync(`${MOCKS}/api.js`, 'export const db = globalThis.__dbMock;\nexport default globalThis.__apiMock;\n');
writeFileSync(`${MOCKS}/crypto.js`, 'export default globalThis.__cryptoMock;\n');
writeFileSync(`${MOCKS}/identity.js`, 'export const accountNamespace = (e) => globalThis.__identityMock.accountNamespace(e);\n');
globalThis.__dbMock = db; globalThis.__apiMock = apiMock;
globalThis.__cryptoMock = cryptoMock; globalThis.__identityMock = identityMock;

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

writeFileSync(`${MOCKS}/features/edits.js`,
  prepareModuleCopy(EDITS, `${MOCKS}/features/edits.js`, {
    '../api.js': 'api.js', '../crypto.js': 'crypto.js', '../identity.js': 'identity.js',
  }, MOCKS));

const E = await import(`${MOCKS}/features/edits.js`).then(m => m.default || m);
let passed = 0, failed = 0;
function check(label, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

check('editsStorageKey(email) чистая строка — не ctx', E.editsStorageKey('a@b.c') === 'vault-edits-a@b.c');
check('editsStorageKey без email → anon', E.editsStorageKey('') === 'vault-edits-anon');

store.clear();
E.saveStoredEdits('a@b.c', { 'c': { 'm': [{ text:'hi', action:'edit', sender:'a@b.c' }] } });
check('loadStoredEdits после save хранит структуру', E.loadStoredEdits('a@b.c')['c']['m'][0].text === 'hi');
check('loadStoredEdits пустой ключ → {}', Object.keys(E.loadStoredEdits('z')).length === 0);

store.clear();
E.recordLocalEdit('a@b.c','c','m2','правка','edit');
const r = E.loadStoredEdits('a@b.c')['c']['m2'][0];
check('recordLocalEdit пушит text/action/sender', r.text==='правка' && r.action==='edit' && r.sender==='a@b.c');
check('recordLocalEdit пушит date', typeof r.date === 'number');

const cache = [];
check('tombstonesKey(email) чистая строка', E.tombstonesKey('a@b.c') === 'vault-tombstones-a@b.c');
check('loadTombstones принимает кэш', E.loadTombstones(cache) === cache);
await E.addTombstone({ email:'a@b.c', tombstonesCache:cache }, 'msg-1');
check('addTombstone пушит (in-place)', cache.includes('msg-1'));
check('addTombstone dedup', cache.filter(x=>x==='msg-1').length===1);
check('addTombstone пишет sqlite fp:', dbCalls.some(c=>c[0]==='tombstoneAdd'&&c[1]==='fp:a@b.c'&&c[2]==='msg-1'));
const c2=[]; await E.addTombstone({email:'a@b.c',tombstonesCache:c2},'');
check('addTombstone без msgId → ничего', c2.length===0);
check('isTombstoned найден', E.isTombstoned(cache,'msg-1')===true);
check('isTombstoned не найден', E.isTombstoned(cache,'nope')===false);

const midc=[];
check('midTombstonesKey(email) чистая строка', E.midTombstonesKey('a@b.c')==='vault-mid-tombstones-a@b.c');
check('loadMidTombstones принимает кэш', E.loadMidTombstones(midc)===midc);
await E.addMidTombstone({email:'a@b.c',midTombstonesCache:midc},'mid-1');
check('addMidTombstone пушит', midc.includes('mid-1'));
check('isMidTombstoned найден', E.isMidTombstoned(midc,'mid-1')===true);

check('filterDeleted по msg.id',
  E.filterDeleted({tombstonesCache:['x'],midTombstonesCache:[]},[{id:'x'},{id:'y'}]).length===1
  && E.filterDeleted({tombstonesCache:['x'],midTombstonesCache:[]},[{id:'x'},{id:'y'}])[0].id==='y');
check('filterDeleted по mid',
  E.filterDeleted({tombstonesCache:[],midTombstonesCache:['m1']},[{id:'a',mid:'m1'},{id:'b',mid:'m2'}]).length===1
  && E.filterDeleted({tombstonesCache:[],midTombstonesCache:['m1']},[{id:'a',mid:'m1'},{id:'b',mid:'m2'}])[0].id==='b');

const msg={id:'m3',mid:'mid-3',from:'me',content:'старый'}; const tombs=[],mids=[];
E.applyEdits({email:'a@b.c',tombstonesCache:tombs,midTombstonesCache:mids},[msg],'c',{});
check('applyEdits no-op без wire', msg.content==='старый');
msg.sender_id='a@b.c'; tombs.length=0;mids.length=0; dbCalls.length=0; store.clear();
E.applyEdits({email:'a@b.c',tombstonesCache:tombs,midTombstonesCache:mids},[msg],'c',{'m3':[{text:'',action:'delete',date:5,sender:'a@b.c'}]});
check('applyEdits delete→tombstone+mid', tombs.includes('m3')&&mids.includes('mid-3'));
check('applyEdits delete→deleted+content=""', msg.deleted===true&&msg.content==='');
msg.deleted=false;msg.content='старый';tombs.length=0;mids.length=0;dbCalls.length=0;store.clear();
E.applyEdits({email:'a@b.c',tombstonesCache:tombs,midTombstonesCache:mids},[msg],'c',{'m3':[{text:'взлом',action:'edit',date:9,sender:'evil@x'}]});
check('applyEdits чужая правка игнорируется', msg.content==='старый'&&tombs.length===0);
msg.content='старый';dbCalls.length=0;store.clear();
E.applyEdits({email:'a@b.c',tombstonesCache:[],midTombstonesCache:[]},[msg],'c',{'m3':[{text:'новый',action:'edit',date:7,sender:'a@b.c'}]});
check('applyEdits edit→content+edited', msg.content==='новый'&&msg.edited===true);

const DECLARED=['activeChat','activeChatType','currentGroup','groupKeys','peerKeys','peerPqKeys','email'];
let read=new Set();
const base={email:'a@b.c',activeChat:'p@x',activeChatType:'chat',currentGroup:null,groupKeys:{},peerKeys:{'p@x':'K'},peerPqKeys:{'p@x':'P'}};
const deps=new Proxy(base,{get(t,k){if(typeof k==='string')read.add(k);return t[k];}});
apiCalls.length=0; E.sendEditEmail(deps,'m9','правка','edit');
await new Promise(r=>setTimeout(r,50));
check('sendEditEmail 1:1→sendEdit', apiCalls[0]&&apiCalls[0][0]==='sendEdit');
check('sendEditEmail читает только DECLARED', ([...read].filter(k=>!DECLARED.includes(k)).length===0));
read.clear();apiCalls.length=0;
const g={...base,activeChatType:'group',currentGroup:{id:'g1'},groupKeys:{'g1':'GK'}};
const gDeps=new Proxy(g,{get(t,k){if(typeof k==='string')read.add(k);return t[k];}});
E.sendEditEmail(gDeps,'m9','гр','edit'); await new Promise(r=>setTimeout(r,50));
check('sendEditEmail group→sendGroupEdit', apiCalls.some(c=>c[0]==='sendGroupEdit'&&c[1]==='g1'));

const src=readFileSync(EDITS,'utf8');
const converted=['editsStorageKey','loadStoredEdits','saveStoredEdits','recordLocalEdit','tombstonesKey','loadTombstones','addTombstone','isTombstoned','midTombstonesKey','loadMidTombstones','addMidTombstone','isMidTombstoned','filterDeleted','applyEdits','sendEditEmail'];
let clean=true;
const bodyOf=(name)=>{
  let at1=src.indexOf('export async function '+name+'(');
  let at2=src.indexOf('export function '+name+'(');
  const at=[at1,at2].filter(i=>i>=0).sort((a,b)=>a-b)[0];
  if(at<0) return null;
  const open=src.indexOf('{',at); let d=0,end=src.length;
  for(let j=open;j<src.length;j++){if(src[j]==='{')d++;else if(src[j]==='}'){d--;if(d===0){end=j+1;break;}}}
  return src.slice(open,end);
};
for(const fn of converted){
  const body=bodyOf(fn);
  if(!body){clean=false;console.log('  x '+fn+': ne naiden');continue;}
  if(body.includes('ctx')){clean=false;console.log('  ✗ '+fn+': обращение к ctx');}
}
check('Регрессия: нет ctx в переведённых', clean);

console.log('\n=== ИТОГО: '+passed+' pass, '+failed+' fail ===');
if(failed)process.exit(1);
