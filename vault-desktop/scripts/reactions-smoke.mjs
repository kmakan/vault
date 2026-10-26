import { writeFileSync, mkdirSync } from 'node:fs';
import { prepareModuleCopy } from './smoke-imports.mjs';
const ROOT='/home/maksim/whisper/vault-desktop/src/features';
const RX=ROOT+'/reactions.js';
const MOCKS='/tmp/reactions-smoke-mocks'; mkdirSync(MOCKS,{recursive:true}); mkdirSync(`${MOCKS}/features`,{recursive:true});
const apiCalls=[];
const api={ sendReaction: async (peer,content,emoji,action='add')=>{apiCalls.push(['send',peer,action])}, sendGroupReact: async (gid,content)=>{apiCalls.push(['sendGroup',gid,'add'])} };
const cryptoMock={ encryptVault: async (p)=>p+'::enc', encryptWithGroupKey: async (p)=>p+'::g', setPeerPublicKey:()=>{} };
const ls={};
globalThis.localStorage={ getItem:(k)=>ls[k]||null, setItem:(k,v)=>{ls[k]=String(v)} };
globalThis.window={ getSelection:()=>null };
writeFileSync(`${MOCKS}/api.js`, 'export default globalThis.__apiMock;\n');
writeFileSync(`${MOCKS}/crypto.js`, 'export default globalThis.__cryptoMock;\n');
globalThis.__apiMock=api; globalThis.__cryptoMock=cryptoMock;
writeFileSync(`${MOCKS}/features/reactions.js`, prepareModuleCopy(RX,`${MOCKS}/features/reactions.js`,{ '../api.js':'api.js','../crypto.js':'crypto.js' },MOCKS));
const R = await import(`${MOCKS}/features/reactions.js`).then(m=>m.default||m);
let p=0,f=0; function check(l,c){if(c){p++;console.log('  ✓ '+l)}else{f++;console.log('  ✗ '+l)}}

check('reactionsStorageKey(email)', R.reactionsStorageKey('a@b.c')==='vault-reactions-a@b.c');
check('loadStoredReactions пусто по умолчанию', JSON.stringify(R.loadStoredReactions('a@b.c'))==='{}');

// applyReactions: merge wire + set msg.reactions = уникальные эмодзи
{
  R.saveStoredReactions('a@b.c',{c1:{m1:[{emoji:'👍',user:'x@y.z'},{emoji:'👍',user:'a@b.c'}]}});
  const msgs=[{id:'m1'},{id:'m2'}];
  R.applyReactions({email:'a@b.c'}, msgs, 'c1', { m1:[{emoji:'👍',user:'p@y.z'},{emoji:'❤',user:'a@b.c'}] });
  check('applyReactions merge в хранилище', ls['vault-reactions-a@b.c'].includes('❤'));
  check('applyReactions msg.reactions уникальные (Set)', msgs[0].reactions.length===2 && msgs[0].reactions.includes('👍') && msgs[0].reactions.includes('❤'));
  check('applyReactions msg без реакций []', msgs[1].reactions.length===0);
}

// sendReactionEmail 1:1 + group guard
{
  apiCalls.length=0;
  R.sendReactionEmail({activeChat:'b@y.z',activeChatType:'1:1',peerKeys:{'b@y.z':'pk'},peerPqKeys:{},groupKeys:{}}, 'm1','👍','add');
  await new Promise(r=>setTimeout(r,0));
  check('sendReactionEmail 1:1 → api.sendReaction', apiCalls.some(c=>c[0]==='send'&&c[1]==='b@y.z'));
}
{
  apiCalls.length=0;
  R.sendReactionEmail({activeChatType:'group',currentGroup:{id:'g1'},groupKeys:{}}, 'm1','👍','add');
  await new Promise(r=>setTimeout(r,0));
  check('sendReactionEmail group без ключа — no-op', apiCalls.length===0);
}

// Контракт deps (ADR-005 W3, партия 3): состояние пикера — у владельца форм,
// поэтому фича получает геттер/сеттер, а не значение.
// deps: { chat, reactionPickerMsgId(), setReactionPickerMsgId(v), email(),
//         activeChat(), sendReactionEmail }
const rdeps = (o = {}) => ({
  chat: o.chat,
  reactionPickerMsgId: () => (o.reactionPickerMsgId === undefined ? null : o.reactionPickerMsgId),
  setReactionPickerMsgId: o.setReactionPickerMsgId || (() => {}),
  email: () => (o.email === undefined ? 'a@b.c' : o.email),
  activeChat: () => (o.activeChat === undefined ? 'b@y.z' : o.activeChat),
  sendReactionEmail: o.sendReactionEmail || (() => {}),
});

// toggleReactionPicker
{
  const chat={byId:(id)=>id==='call'?{callEvent:true}:null};
  let set=null, calls=0;
  const d=(o)=>rdeps({chat,...o,setReactionPickerMsgId:v=>{set=v;calls++}});
  check('toggleReactionPicker default open', R.toggleReactionPicker(d({reactionPickerMsgId:null}),'m1')==='m1');
  check('toggleReactionPicker ПИШЕТ состояние через setter (регрессия 49861f5: Vue отбрасывает return)', calls===1 && set==='m1');
  calls=0; set='SENTINEL';
  check('toggleReactionPicker callEvent skip', R.toggleReactionPicker(d({reactionPickerMsgId:'prev'}),'call')==='prev');
  check('toggleReactionPicker callEvent — setter НЕ тронут', calls===0);
  calls=0; set='SENTINEL';
  check('toggleReactionPicker toggle back to null', R.toggleReactionPicker(d({reactionPickerMsgId:'m1'}),'m1')===null);
  check('toggleReactionPicker toggle-off — setter(null)', calls===1 && set===null);
  globalThis.window.getSelection=()=>({toString:()=> 'select'});
  calls=0; set='SENTINEL';
  check('toggleReactionPicker selected text skip', R.toggleReactionPicker(d({chat:{byId:()=>null},reactionPickerMsgId:'p'}),'m1')==='p');
  check('toggleReactionPicker selected text — setter НЕ тронут', calls===0);
  globalThis.window.getSelection=()=>null;
}

// addReaction
{
  for(const k in ls) delete ls[k]; apiCalls.length=0; let picked='SENTINEL';
  const msgs=[{id:'m1',reactions:['👍']}];
  const chat={patch:(id,fn)=>{fn(msgs[0])}};
  R.addReaction(rdeps({email:'a@b.c',chat,activeChat:'b@y.z',
    sendReactionEmail:(m,e,a)=>api.sendReaction('b@y.z',m,e,a,),
    setReactionPickerMsgId:v=>{picked=v}}), 'm1','❤');
  await new Promise(r=>setTimeout(r,0));
  check('addReaction chat.patch добавил эмодзи', msgs[0].reactions.includes('❤'));
  let storedReactions = null;
  let storedThrew = null;
  try { storedReactions = JSON.parse(ls['vault-reactions-a@b.c']); } catch (e) { storedThrew = e; }
  const storedForChat = (storedReactions && storedReactions['b@y.z']) || {};
  check('addReaction storage (key=email)',
    storedThrew === null && Array.isArray(storedForChat.m1) && storedForChat.m1.some(r => r.emoji === '❤'),
    storedThrew ? String(storedThrew.message) : ls['vault-reactions-a@b.c']);
  check('addReaction sendReactionEmail add', apiCalls.some(c=>c[0]==='send'&&c[2]==='add'));
  check('addReaction setReactionPickerMsgId(null)', picked===null);
}

// toggleReaction: удаление + send remove
{
  for(const k in ls) delete ls[k];
  R.saveStoredReactions('a@b.c',{'b@y.z':{m1:[{emoji:'❤',user:'a@b.c'},{emoji:'👍',user:'x@y'}]}});
  apiCalls.length=0; const msgs=[{id:'m1',reactions:['❤','👍']}];
  const chat={patch:(id,fn)=>{fn(msgs[0])}};
  R.toggleReaction({email:'a@b.c',chat,activeChat:'b@y.z',
    sendReactionEmail:(m,e,a)=>api.sendReaction('b@y.z',m,e,a,)}, 'm1','❤');
  await new Promise(r=>setTimeout(r,0));
  check('toggleReaction удалил из storage', JSON.parse(ls['vault-reactions-a@b.c'])['b@y.z'].m1.every(r=>r.emoji!=='❤'));
  check('toggleReaction chat.patch удалил эмодзи', !msgs[0].reactions.includes('❤'));
  check('toggleReaction send remove', apiCalls.some(c=>c[2]==='remove'));
}

// toggleReaction no self → no-op
{
  for(const k in ls) delete ls[k];
  R.saveStoredReactions('a@b.c',{'b@y.z':{m9:[{emoji:'👍',user:'x@y'}]}}); apiCalls.length=0;
  R.toggleReaction({email:'a@b.c',chat:{patch:()=>{}},activeChat:'b@y.z',
    sendReactionEmail:()=>{apiCalls.push(['send',undefined,undefined,'nope'])}}, 'm9','❤');
  check('toggleReaction no self — no-op', !apiCalls.some(c=>c[2]==='nope'));
}

console.log('=== ИТОГО: '+p+' pass, '+f+' fail ==='); if (f) process.exit(1);
