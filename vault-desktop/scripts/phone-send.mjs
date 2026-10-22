// Отправка сообщения с телефона через CDP (живая проверка доставки).
// Использование: node scripts/phone-send.mjs "<текст>" ["<получатель>"]
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:9224';

async function cdpEvaluate(expression) {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('нет страницы в CDP');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP')); });
  try {
    ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    }));
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('таймаут')), 120000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          clearTimeout(timer);
          if (m.result && m.result.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
          else res(m.result.result.value);
        }
      };
    });
  } finally { ws.close(); }
}

const text = process.argv[2] || 'Проверка доставки после починки моста';
const peer = process.argv[3] || 'icemaksim@gmail.com';

const out = await cdpEvaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = document.querySelector('#app').__vue_app__;
  const p = app._container._vnode.component.proxy;
  const PEER = ${JSON.stringify(peer)};
  const TEXT = ${JSON.stringify(text)};

  // 1) Открыть чат с получателем.
  if (p.activeChat !== PEER) {
    const item = Array.from(document.querySelectorAll('.contact-item'))
      .find((e) => (e.innerText || '').includes(PEER));
    if (!item) return { error: 'контакт не найден', items: Array.from(document.querySelectorAll('.contact-item')).map((e) => (e.innerText||'').slice(0,40)) };
    item.click();
    await sleep(2000);
  }
  if (p.activeChat !== PEER) return { error: 'чат не открылся', activeChat: p.activeChat };

  // 2) Ввести текст в композер (как пользователь).
  const input = document.querySelector('input.message-field, textarea.message-field');
  if (!input) return { error: 'композер не найден' };
  const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(input, TEXT);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(600);

  // 3) Отправить (кнопка или Enter).
  const before = p.chat.state.messages.length;
  const btn = document.querySelector('.send-btn-round');
  let sent = false;
  if (btn && !btn.disabled) { btn.click(); sent = true; }
  else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    sent = true;
  }
  await sleep(3000);
  const after = p.chat.state.messages.length;
  const last = p.chat.state.messages[after - 1] || {};
  return {
    peer: PEER,
    sent,
    messagesBefore: before,
    messagesAfter: after,
    lastText: (last.text || '').slice(0, 80),
    lastStatus: last.status,
    lastId: last.id,
  };
})()`);

console.log(JSON.stringify(out, null, 2));
