// Управление звонком с телефона через CDP (для живого теста видео).
// Использование: node scripts/phone-call.mjs <команда> [аргументы]
//   start     — нажать кнопку звонка в шапке чата
//   state     — снимок состояния звонка (callMediaConnected, callVideoOn, …)
//   video     — включить/выключить видео
//   screens   — список доступных команд
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:9224';

async function cdpEvaluate(expression) {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('нет страницы в CDP: ' + JSON.stringify(list).slice(0, 300));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP: не удалось подключиться'));
  });
  try {
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    }));
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('CDP: таймаут')), 120000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          clearTimeout(timer);
          if (msg.result && msg.result.exceptionDetails) {
            rej(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400)));
          } else res(msg.result.result.value);
        }
      };
    });
  } finally { ws.close(); }
}

const cmd = process.argv[2] || 'state';

const PROBES = {
  state: `(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const s = p.callSession ? p.callSession.state : {};
    return {
      email: p.email,
      activeChat: p.activeChat,
      currentCall: s.currentCall ? { call_id: s.currentCall.call_id, peer: s.currentCall.peer_email || s.currentCall.peer } : null,
      mediaConnected: s.callMediaConnected,
      videoOn: s.callVideoOn,
      hasPeerKey: !!(p.peerKeys && p.peerKeys[p.activeChat]),
      expCalls: p.experimentsCalls,
    };
  })()`,

  start: `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const btn = Array.from(document.querySelectorAll('.chat-header button, .chat-actions button'))
      .find((b) => /Позвонить|call_start/i.test(b.getAttribute('title') || ''));
    if (!btn) {
      return { error: 'кнопка звонка не найдена',
               buttons: Array.from(document.querySelectorAll('.chat-actions button')).map((b) => (b.getAttribute('title')||'').slice(0,24)) };
    }
    btn.click();
    await sleep(1500);
    const s = p.callSession ? p.callSession.state : {};
    return { clicked: true, currentCall: s.currentCall ? s.currentCall.call_id : null, mediaConnected: s.callMediaConnected };
  })()`,

  video: `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const before = p.callSession ? p.callSession.state.callVideoOn : null;
    // Кнопка видео в оверлее звонка.
    const btns = Array.from(document.querySelectorAll('button'));
    const vbtn = btns.find((b) => /видео|video/i.test((b.getAttribute('title') || '') + ' ' + (b.innerText || '')));
    if (!vbtn) return { error: 'кнопка видео не найдена', titles: btns.map((b) => (b.getAttribute('title')||'').slice(0,20)).filter(Boolean).slice(0,25) };
    vbtn.click();
    await sleep(3000);
    const s = p.callSession ? p.callSession.state : {};
    const canvas = document.querySelector('canvas');
    return { videoOnBefore: before, videoOnAfter: s.callVideoOn, canvas: !!canvas,
             canvasSize: canvas ? canvas.width + 'x' + canvas.height : null,
             overlay: !!document.querySelector('.call-overlay, .call-overlay-root') };
  })()`,
};

const probe = PROBES[cmd];
if (!probe) {
  console.error('неизвестная команда: ' + cmd + ' (доступны: ' + Object.keys(PROBES).join(', ') + ')');
  process.exit(2);
}
try {
  const out = await cdpEvaluate(probe);
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error('✗ ' + (e && e.message ? e.message : e));
  process.exit(1);
}
