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
  // Звонок конкретному контакту (Анна = десктопный аккаунт стенда).
  'call-anna': `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const PEER = 'icemaksim@gmail.com';
    // 1) Открыть чат с нужным контактом.
    if (p.activeChat !== PEER) {
      const item = Array.from(document.querySelectorAll('.contact-item'))
        .find((e) => (e.innerText || '').includes(PEER));
      if (!item) return { error: 'контакт не найден в списке чатов' };
      item.click();
      await sleep(1800);
    }
    if (p.activeChat !== PEER) return { error: 'чат не открылся', activeChat: p.activeChat };
    // 2) Нажать кнопку звонка в шапке.
    const btn = Array.from(document.querySelectorAll('.chat-actions button, .chat-header button'))
      .find((b) => /Позвонить|call_start/i.test(b.getAttribute('title') || ''));
    if (!btn) return { error: 'кнопка звонка не найдена', activeChat: p.activeChat };
    btn.click();
    await sleep(2000);
    const s2 = p.callSession ? p.callSession.state : {};
    return { peer: PEER, callId: s2.currentCall ? s2.currentCall.call_id : null,
             state: p.callSession ? p.callSession.state.callState : null };
  })()`,
  state: `(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const s = p.callSession ? p.callSession.state : {};
    const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    const storedVideo = inv ? await inv('settings_flag', { name: 'exp-video' }) : 'нет моста';
    return {
      email: p.email,
      activeChat: p.activeChat,
      currentCall: s.currentCall ? { call_id: s.currentCall.call_id, peer: s.currentCall.peer_email || s.currentCall.peer } : null,
      mediaConnected: s.callMediaConnected,
      videoOn: s.callVideoOn,
      hasPeerKey: !!(p.peerKeys && p.peerKeys[p.activeChat]),
      expCalls: p.experimentsCalls,
      expVideo: p.expVideo,
      storedVideo,
      cameraButton: !!document.querySelector('.call-orb-extra'),
    };
  })()`,

  // Проводка темы: фон экрана настроек обязан совпасть с --bg-primary
  // выбранной темы (жалоба 27.10 — попап был в дефолтной палитре).
  theme: `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    p.showSettings = true;
    await sleep(500);
    const pageEl = document.querySelector('.settings-page');
    const themeId = localStorage.getItem('vault-theme') || 'dark';
    const rootBg = getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim();
    const probeEl = document.createElement('div');
    probeEl.style.color = rootBg;
    document.body.appendChild(probeEl);
    const themeBg = rootBg ? getComputedStyle(probeEl).color : '';
    probeEl.remove();
    const pageBg = pageEl ? getComputedStyle(pageEl).backgroundColor : null;
    p.showSettings = false;
    return { themeId, pageBg, themeBg, matches: !!pageBg && pageBg === themeBg };
  })()`,

  // Тумблер видео: запись в kv + перечитывание флагов в живом приложении.
  // Нужен после приёмки: до 27.10 её проба гасила видео и не возвращала выбор.
  'video-flag': (() => {
    const on = process.argv[3] !== 'off';
    return `(async () => {
      const inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!inv) return { error: 'мост недоступен' };
      await inv('settings_flag_set', { name: 'exp-video', enabled: ${on} });
      const app = document.querySelector('#app').__vue_app__;
      const p = app._container._vnode.component.proxy;
      if (p.loadExperimentFlags) await p.loadExperimentFlags();
      const stored = await inv('settings_flag', { name: 'exp-video' });
      return { requested: ${on}, stored, expVideo: p.expVideo };
    })()`;
  })(),

  hangup: `(async () => {
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const before = p.callSession ? p.callSession.state.currentCall : null;
    if (!before) return { error: 'звонка нет' };
    await p.hangup('local');
    return { hungUp: before.call_id };
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
    // Кнопка камеры в оверлее звонка — по классу (подпись «Камера», а не
    // «видео»: поиск по слову «видео» не находил её и выдавал ложное «нет кнопки»).
    const vbtn = document.querySelector('.call-orb-extra');
    if (!vbtn) return { error: 'кнопка камеры не найдена', overlay: !!document.querySelector('.call-overlay-root') };
    const title = vbtn.getAttribute('title') || '';
    vbtn.click();
    await sleep(3000);
    const s = p.callSession ? p.callSession.state : {};
    const canvas = document.querySelector('canvas');
    return { title, videoOnBefore: before, videoOnAfter: s.callVideoOn, canvas: !!canvas,
             canvasSize: canvas ? canvas.width + 'x' + canvas.height : null,
             objectFit: canvas ? getComputedStyle(canvas).objectFit : null,
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
