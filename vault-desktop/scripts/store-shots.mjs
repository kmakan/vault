// Снимки экранов для магазинов (RuStore / Google Play) с ЭМУЛЯТОРА.
//
// Зачем: магазины требуют 2–8 скриншотов реального приложения (минимум
// 512×800). Снимки берём с настоящего приложения через CDP (навигация) +
// adb screencap (кадр) — это честные скриншоты того, что увидит пользователь.
//
// Отличие от scripts/store-screenshots.mjs: тот снимает с БОЕВОГО телефона
// (X50) — там в аватарках остались случайные фото людей с dev-стендов, а в
// переписке — отладочные тексты («Тест после смены почты…», «e2e-проверка…»).
// Для магазина это не годится. Здесь стенд — эмулятор с ДЕМО-аккаунтами
// (vault_msg@mail.ru / vault_msg@bk.ru): аватары — монограммы, переписка —
// живая демо-переписка.
//
// Устройство: планшет имитируется через `wm size`/`wm density` (тот же
// эмулятор, другое разрешение) — приложение само переключается на
// двухпанельную раскладку, и скриншот честно показывает планшетный вид.
//
// Использование:
//   node scripts/store-shots.mjs <out-dir> [--ser emulator-5554] [--port 9224]
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const OUT = args[0] || '/tmp/opencode/store-shots';
const SER = (args.includes('--ser') ? args[args.indexOf('--ser') + 1] : process.env.VAULT_SER) || 'emulator-5554';
const PORT = (args.includes('--port') ? args[args.indexOf('--port') + 1] : '9224') + '';
const BASE = 'http://127.0.0.1:' + PORT;
mkdirSync(OUT, { recursive: true });

function adb(...a) {
  return execFileSync('adb', ['-s', SER, ...a], { encoding: 'utf8' });
}

async function cdpEvaluate(expression) {
  const list = await (await fetch(BASE + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('нет страницы в CDP');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP')); });
  try {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
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
  adb('shell', 'screencap', '-p', '/sdcard/shot.png');
  adb('pull', '/sdcard/shot.png', path.join(OUT, name));
  console.log('  ✓ ' + name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Хелперы внутри страницы: клик по элементу с подстрокой текста.
const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clickText = (sel, re) => {
    const el = Array.from(document.querySelectorAll(sel)).find((e) => re.test(String(e.innerText || e.title || '')));
    if (!el) return false;
    (el.closest('button,[role=button],label') || el).click();
    return true;
  };
`;

const PHONE = [
  // 1) список чатов
  ['01-chats', `(async () => { ${HELPERS}
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    if (p.showSettings) p.showSettings = false;
    if (p.closeMobileChat) p.closeMobileChat();
    await sleep(800);
    const tab = Array.from(document.querySelectorAll('button, [class*=tab]'))
      .find((e) => /Контакт|Contacts/i.test(String(e.innerText || '')));
    if (tab) { tab.click(); await sleep(600); }
    await sleep(900);
    return { screen: 'chats' };
  })()`],
  // 2) личный чат с шифрованием
  ['02-chat-1to1', `(async () => { ${HELPERS}
    const item = Array.from(document.querySelectorAll('.contact-item')).find((e) => /Анна/.test(String(e.innerText || '')));
    if (!item) return { error: 'нет чата' };
    item.click();
    await sleep(2200);
    return { screen: 'chat' };
  })()`],
  // 3) групповой чат
  ['03-group', `(async () => { ${HELPERS}
    const item = Array.from(document.querySelectorAll('.contact-item')).find((e) => /Команда/.test(String(e.innerText || '')));
    if (!item) return { error: 'нет группы' };
    item.click();
    await sleep(2400);
    return { screen: 'group' };
  })()`],
  // 4) настройки → приватность
  ['04-settings-privacy', `(async () => { ${HELPERS}
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    if (p.uiStore) p.uiStore.setModal('showSettings', true);
    else p.showSettings = true;
    await sleep(1400);
    const cat = Array.from(document.querySelectorAll('.settings-nav-item, [class*=settings-nav] *'))
      .find((el) => /Приватн|Privacy/i.test(String(el.innerText || '')));
    if (cat) { cat.click(); await sleep(1200); }
    return { screen: 'settings-privacy' };
  })()`],
  // 5) добавление контакта (обмен ключами)
  ['05-add-contact', `(async () => { ${HELPERS}
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    if (p.showSettings) p.showSettings = false;
    if (p.closeMobileChat) p.closeMobileChat();
    await sleep(800);
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('title') === 'Добавить контакт');
    if (!b) return { error: 'нет кнопки' };
    b.click();
    await sleep(1500);
    return { screen: 'add-contact' };
  })()`],
];

const TABLET = [
  ['t1-tablet-chats', `(async () => { ${HELPERS}
    const app = document.querySelector('#app').__vue_app__;
    const p = app._container._vnode.component.proxy;
    if (p.showSettings) p.showSettings = false;
    if (p.closeMobileChat) p.closeMobileChat();
    await sleep(1200);
    return { screen: 'tablet-chats' };
  })()`],
  ['t2-tablet-chat', `(async () => { ${HELPERS}
    const item = Array.from(document.querySelectorAll('.contact-item')).find((e) => /Анна/.test(String(e.innerText || '')));
    if (!item) return { error: 'нет чата' };
    item.click();
    await sleep(2400);
    return { screen: 'tablet-chat' };
  })()`],
];

async function runScenes(scenes) {
  for (const [name, probe] of scenes) {
    try {
      const out = await cdpEvaluate(probe);
      if (out && out.error) { console.log('  ~ ' + name + ' — ' + out.error); continue; }
      await sleep(700);
      shoot(name + '.png');
    } catch (e) {
      console.log('  ~ ' + name + ' — ' + (e && e.message ? e.message : e));
    }
  }
}

const mode = process.env.SHOTS_MODE || 'phone';
if (mode === 'phone') {
  console.log('телефон:');
  await runScenes(PHONE);
} else if (mode === 'tablet') {
  console.log('планшет:');
  await runScenes(TABLET);
}
console.log('готово: ' + OUT);
writeFileSync(path.join(OUT, '.meta.json'), JSON.stringify({ ser: SER, port: PORT, mode, at: new Date().toISOString() }, null, 2));
