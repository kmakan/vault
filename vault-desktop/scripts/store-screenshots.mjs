// Снимки экранов для магазинов (Google Play / RuStore) с живого телефона.
//
// Зачем: магазины требуют 2–8 скриншотов реального приложения (минимум
// 512×800). Рисованные макеты не проходят проверку «приложение работает».
// Снимки берём с настоящего устройства через CDP (навигация) + adb
// screencap (кадр) — это честные скриншоты того, что увидит пользователь.
//
// Использование: node scripts/store-screenshots.mjs <out-dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:9224';
const SER = process.env.VAULT_SER || '192.168.1.2:44405';
const OUT = process.argv[2] || '/tmp/opencode/store-shots';
mkdirSync(OUT, { recursive: true });

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
      const timer = setTimeout(() => rej(new Error('таймаут')), 60000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) {
          clearTimeout(timer);
          if (m.result && m.result.exceptionDetails) rej(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 300)));
          else res(m.result.result.value);
        }
      };
    });
  } finally { ws.close(); }
}

function shoot(name) {
  execFileSync('adb', ['-s', SER, 'shell', 'screencap', '-p', '/sdcard/shot.png']);
  execFileSync('adb', ['-s', SER, 'pull', '/sdcard/shot.png', path.join(OUT, name)]);
  console.log('  ✓ ' + name);
}

const NAV = {
  // 1) список чатов — главный экран
  '01-chats': `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    if (p.uiStore) p.uiStore.setModal('showSettings', false);
    await sleep(1200);
    return { screen: 'chats' };
  })()`,
  // 2) личный чат с шифрованием
  '02-chat-1to1': `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const item = Array.from(document.querySelectorAll('.contact-item'))
      .find((e) => /koanmak|icemaksim/i.test(e.innerText || ''));
    if (!item) return { error: 'нет чата' };
    item.click();
    await sleep(2200);
    return { screen: 'chat', chat: p.activeChat };
  })()`,
  // 3) групповой чат
  '03-group': `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    const item = Array.from(document.querySelectorAll('.contact-item'))
      .find((e) => /участник|Test-Группа|Demo Group/i.test(e.innerText || ''));
    if (!item) return { error: 'нет группы' };
    item.click();
    await sleep(2400);
    return { screen: 'group', chat: p.activeChat };
  })()`,
  // 4) настройки → приватность (там секция тарифа Pro)
  '04-settings-pro': `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    if (p.uiStore) p.uiStore.setModal('showSettings', true);
    else p.showSettings = true;
    await sleep(1400);
    const cat = Array.from(document.querySelectorAll('.settings-nav-item'))
      .find((el) => /Приватн|Privacy/i.test(el.innerText || ''));
    if (cat) { cat.click(); await sleep(1200); }
    return { screen: 'settings-privacy' };
  })()`,
};

for (const [name, probe] of Object.entries(NAV)) {
  try {
    const out = await cdpEvaluate(probe);
    if (out && out.error) { console.log('  ~ ' + name + ' — ' + out.error); continue; }
    await new Promise((r) => setTimeout(r, 700));
    shoot(name + '.png');
  } catch (e) {
    console.log('  ~ ' + name + ' — ' + (e && e.message ? e.message : e));
  }
}
console.log('готово: ' + OUT);
