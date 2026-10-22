// Управление экспериментальными флагами на телефоне через CDP.
// Использование: node scripts/phone-flag.mjs <exp-calls> <on|off>
// Флаг пишется тем же путём, что и в UI (kv 'exp-calls'), поэтому после
// включения состояние совпадает с тем, что увидит пользователь.
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
      const timer = setTimeout(() => rej(new Error('CDP: таймаут')), 60000);
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

const flag = process.argv[2] || 'exp-calls';
const on = (process.argv[3] || 'on') === 'on';

const out = await cdpEvaluate(`(async () => {
  const app = document.querySelector('#app').__vue_app__;
  const p = app._container._vnode.component.proxy;
  const setter = p.onExperimentsCalls;
  if (typeof setter !== 'function') return { error: 'нет onExperimentsCalls' };
  await setter(${on});
  return { set: '${flag}', on: ${on}, expCalls: p.expCalls };
})()`);
console.log(JSON.stringify(out, null, 2));
