// Вспомогательный CDP-проб: что доступно в живом WebView (диагностика).
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:9224';

async function cdpEvaluate(expression) {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('нет страницы в CDP');
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
      const timer = setTimeout(() => rej(new Error('таймаут')), 60000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === 1) {
          clearTimeout(timer);
          if (msg.result && msg.result.exceptionDetails) {
            rej(new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 300)));
          } else {
            res(msg.result.result.value);
          }
        }
      };
    });
  } finally { ws.close(); }
}

const out = await cdpEvaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = document.querySelector('#app').__vue_app__;
  const p = app._container._vnode.component.proxy;
  const keys = Object.keys(p).filter((k) => !k.startsWith('_') && !k.startsWith('\\$')).slice(0, 60);
  const res = {
    isLoggedIn: p.isLoggedIn,
    email: p.email,
    hasDb: !!p.db,
    hasApi: !!p.api,
    proxyKeys: keys,
    settingsModal: !!document.querySelector('.modal-overlay'),
  };
  // Открыть настройки и посмотреть, что в разделе «Приватность».
  const btns = document.querySelectorAll('.header-actions button');
  res.headerButtons = btns.length;
  if (btns.length) { btns[btns.length - 1].click(); await sleep(900); }
  res.showSettings = p.showSettings;
  const navs = Array.from(document.querySelectorAll('.settings-nav-item')).map((e) => (e.innerText || '').trim());
  res.navItems = navs;
  const cat = Array.from(document.querySelectorAll('.settings-nav-item')).find((el) => /Приватн|Privacy/i.test(el.innerText || ''));
  if (cat) { cat.click(); await sleep(800); }
  const content = document.querySelector('.settings-content');
  res.settingsText = content ? (content.innerText || '').replace(/\\n+/g, ' | ').slice(0, 1200) : null;
  res.buttons = Array.from(document.querySelectorAll('.settings-content button')).map((b) => (b.innerText || '').trim().slice(0, 30)).filter(Boolean);
  return res;
})()`);

console.log(JSON.stringify(out, null, 2));
